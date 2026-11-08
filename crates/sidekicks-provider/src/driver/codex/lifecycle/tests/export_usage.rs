//! A session's completed responses from Codex's log export: each counted once on its session, the
//! stream's twin passed over by its counts, a reviewer fork's joined to its review window or live
//! turn, and a request turn's settle arming one export check.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::logs::v1::LogRecord;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use super::usage::{GatedUsage, answer_region_read, token_usage_frame};
use super::{LiveCodexSession, TEST_TURN, answer_stopping_request};
use crate::bounded_poll::poll_until;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::session::lifecycle_call::let_go_codex_session_record;
use crate::driver::codex::session::side_questions::test_copies::{
    COPY_THREAD, COPY_TURN, resting_question,
};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, turn_completed, turn_reply, turn_started,
};
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exports::tests::{export_checks, export_tagged};
use crate::driver::codex::telemetry::exports::{
    CODEX_EXPORT_INTERVAL, CodexExportTag, CodexExports,
};
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::session_control::AskSideQuestionParams;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::pricing::receiver::TelemetryExportReader as _;
use crate::usage_delta_accountant::UsageAxisCounts;

/// More paused time than a held response waits after its arrival.
const PAST_TWO_INTERVALS: Duration = CODEX_EXPORT_INTERVAL.saturating_mul(3);

/// The order a case's stream and export arrive in.
enum Arrival {
    /// The stream's reading, then its export twin, then the turn's completion.
    StatedFirst,
    /// The export twin, then the reading past two intervals, then the completion.
    ExportedFirst,
    /// The stream's reading, an export the stream never states, then the completion.
    ExportOnlyOnAStreamedThread,
    /// The export twin with no reading, then the session let go before its turn completes.
    HeldWhenTheSessionCloses,
    /// The export twin and the completion, the twin decided, then the reading released late.
    StatedAfterItsDecision,
}

/// A live session on a paused clock, its spend recorded through an open gate, its turn started
/// and its service's launch registered with the drain running.
struct ExportingSession {
    live: LiveCodexSession,
    usage: Arc<GatedUsage>,
    exports: Arc<CodexExports>,
    tag: CodexExportTag,
}

impl ExportingSession {
    async fn start() -> Self {
        let live = LiveCodexSession::start(&[]).await;
        tokio::time::pause();
        let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
        assert!(
            live.driver
                .ports
                .usage
                .register(Arc::clone(&usage) as _)
                .is_ok()
        );
        // The scripted service's own register, which its scheduler is reached through.
        let exports = Arc::clone(&live.scripted.service.dependencies().exports);
        let drain = exports
            .take_drain()
            .expect("the register's drain is untaken");
        tokio::spawn(drain.run());
        let tag = exports.launched(&live.scripted.service);
        live.scripted.script.send(&turn_started(TEST_TURN));
        Self {
            live,
            usage,
            exports,
            tag,
        }
    }

    // A reading stating one response of `counts` as both the thread's total and its last.
    fn state(&self, counts: &UsageAxisCounts) {
        let wire = wire_counts(counts);
        self.live
            .scripted
            .script
            .send(&token_usage_frame(TEST_THREAD, &wire, &wire));
    }

    // An export of one completed response of `counts` on the session's thread.
    async fn export(&self, counts: &UsageAxisCounts) {
        let record = codex_record(completed_response_attributes(TEST_THREAD, counts));
        self.export_records(vec![record]).await;
    }

    // An export of `records` under the launch's tag.
    async fn export_records(&self, records: Vec<LogRecord>) {
        self.exports
            .read_telemetry_export(self.tag.holder(), export_tagged(&self.tag, records))
            .await;
    }

    fn complete_turn(&self) {
        self.live
            .scripted
            .script
            .send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    }

    // Lets the session's record go with its turn live, answering what the let-go and the
    // recorder's region read ask of the service.
    async fn let_go(&mut self) {
        let claim = self
            .live
            .driver
            .slots
            .claim_closing(self.live.session_id)
            .await;
        let inbound = claim.live().expect("the session is live");
        let let_go = let_go_codex_session_record(&inbound, CodexRecordExit::SessionContinues);
        tokio::pin!(let_go);
        let mut is_region_answered = false;
        loop {
            tokio::select! {
                () = &mut let_go => break,
                sent = self.live.scripted.script.next_sent() => {
                    if sent["method"] == "config/read" {
                        is_region_answered = true;
                        self.live
                            .scripted
                            .script
                            .answer(&sent, &json!({ "config": {}, "origins": {} }));
                    } else {
                        answer_stopping_request(&self.live.scripted.script, &sent);
                    }
                }
            }
        }
        claim.vacate();
        if !is_region_answered {
            answer_region_read(&mut self.live.scripted).await;
        }
    }

    // The input and output of each row recorded, in order, once `rows` are recorded and every
    // held response's decision time has passed with no more.
    async fn settled_rows(&self, rows: usize) -> Vec<(Option<u64>, Option<u64>)> {
        let read = || {
            lock(&self.usage.metered)
                .iter()
                .map(|metered| {
                    (
                        metered.delta.axis_deltas.input,
                        metered.delta.axis_deltas.output,
                    )
                })
                .collect::<Vec<_>>()
        };
        poll_until(read, |recorded| recorded.len() >= rows).await;
        // The paused clock moves only once every task is idle, so each decision due by then ran.
        tokio::time::sleep(PAST_TWO_INTERVALS).await;
        read()
    }
}

fn counts(input: u64, output: u64) -> UsageAxisCounts {
    UsageAxisCounts {
        input: Some(input),
        output: Some(output),
        total: Some(input + output),
        ..UsageAxisCounts::default()
    }
}

// `counts` as a usage reading's breakdown carries them.
fn wire_counts(counts: &UsageAxisCounts) -> Value {
    json!({
        "inputTokens": counts.input,
        "outputTokens": counts.output,
        "totalTokens": counts.total,
    })
}

// Killed: `stated_first` by a ledger the stream's metered delta never enters (two rows);
// `exported_first` by deciding a held response two intervals after its arrival while its turn is
// live (two rows); `export_only_on_a_streamed_thread` by passing over an export whose thread the
// stream metered on, whatever its counts (one row); `held_when_the_session_closes` by dropping
// the held responses with the session's record (no row); `stated_after_its_decision` by a priced
// response that keeps no claim on its stream's late twin (two rows).
#[rstest]
#[case::stated_first(Arrival::StatedFirst)]
#[case::exported_first(Arrival::ExportedFirst)]
#[case::export_only_on_a_streamed_thread(Arrival::ExportOnlyOnAStreamedThread)]
#[case::held_when_the_session_closes(Arrival::HeldWhenTheSessionCloses)]
#[case::stated_after_its_decision(Arrival::StatedAfterItsDecision)]
#[tokio::test]
async fn an_exported_response_is_counted_once_on_its_session(#[case] arrival: Arrival) {
    let mut session = ExportingSession::start().await;
    let stated = counts(1_000, 500);
    let expected = match arrival {
        Arrival::StatedFirst => {
            session.state(&stated);
            answer_region_read(&mut session.live.scripted).await;
            session.export(&stated).await;
            session.complete_turn();
            vec![(Some(1_000), Some(500))]
        }
        Arrival::ExportedFirst => {
            session.export(&stated).await;
            tokio::time::sleep(PAST_TWO_INTERVALS).await;
            session.state(&stated);
            answer_region_read(&mut session.live.scripted).await;
            session.complete_turn();
            vec![(Some(1_000), Some(500))]
        }
        Arrival::ExportOnlyOnAStreamedThread => {
            session.state(&stated);
            answer_region_read(&mut session.live.scripted).await;
            session.export(&counts(400, 20)).await;
            session.complete_turn();
            vec![(Some(1_000), Some(500)), (Some(400), Some(20))]
        }
        Arrival::HeldWhenTheSessionCloses => {
            session.export(&stated).await;
            // The export reaches the session's queue before its let-go does.
            tokio::time::sleep(Duration::from_millis(10)).await;
            session.let_go().await;
            vec![(Some(1_000), Some(500))]
        }
        Arrival::StatedAfterItsDecision => {
            session.export(&stated).await;
            session.complete_turn();
            // The region read comes once the twin is decided and priced, two intervals on.
            answer_region_read(&mut session.live.scripted).await;
            session.state(&stated);
            vec![(Some(1_000), Some(500))]
        }
    };

    assert_eq!(session.settled_rows(expected.len()).await, expected);
    if let Arrival::ExportOnlyOnAStreamedThread = arrival {
        let metered = lock(&session.usage.metered);
        let exported = metered.last().expect("the export's row is recorded");
        assert_eq!(exported.owner, MeteredUsageOwner::Run);
        assert_eq!(exported.binding_id, session.live.binding_id);
    }
}

/// The thread of a reviewer's fork, which no listing names.
const FORK_THREAD: &str = "fork-1";

/// How a reviewer fork's case covers its requests.
enum ReviewCover {
    /// Two review windows open on the session, the latest on the run's turn.
    LatestWindow,
    /// No window opens; the run's turn is live.
    LiveTurnOnly,
    /// The listing fails and more responses come than a launch keeps.
    ListingFails,
}

// Now in Unix milliseconds, the clock a record's observed time and a review's start read.
fn unix_time_ms() -> u64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is past 1970");
    u64::try_from(since.as_millis()).expect("the time fits")
}

// A completed response on the fork's thread carrying `counts` and the person's identity, observed
// at `observed_at_ms`.
fn fork_record(counts: &UsageAxisCounts, observed_at_ms: u64) -> LogRecord {
    LogRecord {
        observed_time_unix_nano: observed_at_ms * 1_000_000,
        ..codex_record(completed_response_attributes(FORK_THREAD, counts))
    }
}

// A review's start on the session's thread for `turn_id`, begun at `started_at_ms`.
fn review_started(review_id: &str, turn_id: &str, started_at_ms: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "item/autoApprovalReview/started",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": turn_id,
            "startedAtMs": started_at_ms,
            "reviewId": review_id,
            "targetItemId": null,
        },
    })
}

// How many recorded messages read `message`.
fn messages_reading(recorded: &RecordedEvents, message: &str) -> usize {
    recorded
        .messages()
        .iter()
        .filter(|recorded| recorded.as_str() == message)
        .count()
}

// A reviewer fork's requests, on a thread no listing names, are counted once on the session under
// its account: joined to the latest review window on the session's turn, else to the turn live at
// their first record, and none of the person's identity is logged. Killed: `latest_window` by
// refusing a not-listed bucket without the join (no rows), by the first window in place of the
// latest (rows on `turn-0`) and by logging a record's attributes (the identity in a log line);
// `live_turn_only` by refusing a bucket no window covers while a turn is live (no rows);
// `listing_fails` by an unbounded keep (no drop line, and 1,001 dropped with the launch).
#[rstest]
#[case::latest_window(ReviewCover::LatestWindow)]
#[case::live_turn_only(ReviewCover::LiveTurnOnly)]
#[case::listing_fails(ReviewCover::ListingFails)]
#[tokio::test]
async fn a_reviewer_fork_s_requests_cost_once_on_the_session_under_its_account(
    #[case] cover: ReviewCover,
) {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut session = ExportingSession::start().await;
    let now = unix_time_ms();
    if let ReviewCover::LatestWindow = cover {
        let script = &session.live.scripted.script;
        script.send(&review_started("review-0", "turn-0", now - 20_000));
        script.send(&review_started("review-1", TEST_TURN, now - 10_000));
        // The windows open before the fork's records are joined.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if let ReviewCover::ListingFails = cover {
        let records = (0..=1_000)
            .map(|_| fork_record(&counts(10, 1), now))
            .collect();
        session.export_records(records).await;
        let list = session.live.scripted.next_request("thread/list").await;
        session.live.scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": list["id"],
            "error": { "code": -32603, "message": "the listing failed" },
        }));
        let dropped = "a codex launch keeps too many unplaced responses; the oldest is dropped";
        poll_until(|| messages_reading(&recorded, dropped), |count| *count >= 1).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(messages_reading(&recorded, dropped), 1);
        // The relaunch drops the launch with what it keeps, each logged.
        session.exports.launched(&session.live.scripted.service);
        let gone = "a codex launch that kept an unplaced response is gone; it is dropped";
        assert_eq!(messages_reading(&recorded, gone), 1_000);
        return;
    }
    let first = counts(300, 20);
    let second = counts(200, 10);
    session
        .export_records(vec![fork_record(&first, now), fork_record(&second, now)])
        .await;
    let unlisted = json!({ "data": [], "nextCursor": null });
    let list = session.live.scripted.next_request("thread/list").await;
    session.live.scripted.script.answer(&list, &unlisted);
    // The launch's next export retries the thread once, still not listed.
    session.export_records(Vec::new()).await;
    let list = session.live.scripted.next_request("thread/list").await;
    session.live.scripted.script.answer(&list, &unlisted);
    session.complete_turn();
    answer_region_read(&mut session.live.scripted).await;

    assert_eq!(
        session.settled_rows(2).await,
        vec![(Some(300), Some(20)), (Some(200), Some(10))]
    );
    for metered in lock(&session.usage.metered).iter() {
        assert_eq!(metered.owner, MeteredUsageOwner::Run);
        assert_eq!(metered.binding_id, session.live.binding_id);
        assert_eq!(metered.delta.attributed_turn_id.as_deref(), Some(TEST_TURN));
    }
    let texts = recorded.texts();
    assert!(
        texts
            .iter()
            .all(|text| !text.contains("person-email-value") && !text.contains("account-id-value")),
        "no log line carries the person's identity"
    );
}

/// The turn whose request a case's settle arms an export check for.
enum RequestTurn {
    /// The session's own turn.
    SessionOwn,
    /// A live side question's copy's turn, its spend diverted off the session's.
    LiveSideQuestion,
}

// A request turn's settle arms one export check on its launch while no export arrives. Killed by
// the settle never handed to the register, by the request never marked from the metered delta,
// and, for a live side question, by its diverted spend left unmarked or its settle never handed
// to the register (no check in each).
#[rstest]
#[case::the_session_s_own(RequestTurn::SessionOwn)]
#[case::a_live_side_question_s(RequestTurn::LiveSideQuestion)]
#[tokio::test]
async fn a_request_turn_waits_for_its_export_once(#[case] turn: RequestTurn) {
    let mut live = LiveCodexSession::start(&[]).await;
    tokio::time::pause();
    let exports = Arc::clone(&live.scripted.service.dependencies().exports);
    exports.launched(&live.scripted.service);
    let reading = wire_counts(&counts(1_000, 500));
    match turn {
        RequestTurn::SessionOwn => {
            let script = &live.scripted.script;
            script.send(&turn_started(TEST_TURN));
            script.send(&token_usage_frame(TEST_THREAD, &reading, &reading));
            script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
        }
        RequestTurn::LiveSideQuestion => {
            let params = AskSideQuestionParams {
                resume: None,
                ..resting_question(live.session_id, Path::new("/"))
            };
            let asked = live.driver.ask_side_question(params);
            tokio::pin!(asked);
            let scripted = &mut live.scripted;
            let copy_turn = async {
                let fork = scripted.next_request("thread/fork").await;
                scripted.script.answer(
                    &fork,
                    &json!({
                        "thread": {"id": COPY_THREAD, "sessionId": "codex-session"},
                        "activePermissionProfile": {"id": fork["params"]["permissions"]},
                    }),
                );
                let start = scripted.next_request("turn/start").await;
                scripted.script.answer(&start, &turn_reply(COPY_TURN));
                let started = json!({"jsonrpc": "2.0", "method": "turn/started", "params": {
                    "threadId": COPY_THREAD,
                    "turn": {"id": COPY_TURN, "items": [], "status": "inProgress"},
                }});
                scripted.script.send(&started);
                let mut usage = token_usage_frame(COPY_THREAD, &reading, &reading);
                usage["params"]["turnId"] = json!(COPY_TURN);
                scripted.script.send(&usage);
                scripted
                    .script
                    .send(&turn_completed(COPY_THREAD, COPY_TURN, "completed"));
            };
            // The ask waits on its copy's answer, which the session's task delivers on its own.
            tokio::select! {
                () = copy_turn => {}
                _answered = &mut asked => {}
            }
        }
    }

    poll_until(|| export_checks(exports.scheduler()), |checks| *checks >= 1).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(export_checks(exports.scheduler()), 1);
}

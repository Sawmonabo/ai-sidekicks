//! A session's completed responses from Codex's log export, on a sink that decides each sighting
//! by the usage record's own statements: each counted once on its session whichever of the stream,
//! the export and the rollout line comes first, a reviewer fork's joined to its review window or
//! live turn, a request turn's settle arming one export check, and the session's rollout file read
//! for what no export carried while the export is stopped, each pass on from the last and on past
//! the export's return.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::logs::v1::LogRecord;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::sync::watch;

use super::usage::{GatedUsage, answer_region_read, token_usage_frame};
use super::{LiveCodexSession, TEST_TURN};
use crate::bounded_poll::poll_until;
use crate::driver::codex::session::side_questions::test_copies::{
    COPY_THREAD, COPY_TURN, resting_question,
};
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, turn_completed, turn_reply, turn_started,
};
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exports::tests::{export_checks, export_tagged, refused};
use crate::driver::codex::telemetry::exports::{CodexExportTag, CodexExports};
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::session_control::AskSideQuestionParams;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::pricing::receiver::TelemetryExportReader as _;
use crate::usage_delta_accountant::UsageAxisCounts;

/// The order a case's stream and export arrive in.
enum Arrival {
    /// The stream's reading, then its export twin, then the turn's completion.
    StatedFirst,
    /// The export twin, then the reading, then the completion.
    ExportedFirst,
    /// The stream's reading, an export the stream never states, then the completion.
    ExportOnlyOnAStreamedThread,
}

/// A live session on a paused clock, its run open on its turns, its spend recorded through an
/// open gate, [`TEST_TURN`] started and its service's launch registered with the drain running.
struct ExportingSession {
    live: LiveCodexSession,
    usage: Arc<GatedUsage>,
    exports: Arc<CodexExports>,
    tag: CodexExportTag,
}

impl ExportingSession {
    async fn start(turns: &[&str]) -> Self {
        let live = LiveCodexSession::on_turns(turns).await;
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
        tokio::spawn(drain.run(tokio_util::task::TaskTracker::new()));
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

    // Appends `lines` to the rollout file at `path`.
    fn append_rollout(path: &Path, lines: &[String]) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("the rollout file opens");
        std::io::Write::write_all(&mut file, (lines.join("\n") + "\n").as_bytes())
            .expect("the lines are written");
    }

    // Writes `lines` as the rollout file of `thread_id` in today's day folder, by this system's
    // clock as Codex names its folders, under the service's home; answers its path.
    fn write_rollout(&self, thread_id: &str, lines: &[String]) -> PathBuf {
        let today = jiff::Timestamp::now()
            .to_zoned(jiff::tz::TimeZone::system())
            .date();
        let folder = self
            .live
            .scripted
            .service
            .home()
            .codex_home
            .join("sessions")
            .join(format!("{:04}", today.year()))
            .join(format!("{:02}", today.month()))
            .join(format!("{:02}", today.day()));
        std::fs::create_dir_all(&folder).expect("the day folder is made");
        let path = folder.join(format!("rollout-2026-11-09T10-00-00-{thread_id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").expect("the rollout file is written");
        path
    }

    // Answers a fallback pass's listing of the recent helpers with none.
    async fn answer_helper_listing(&mut self) {
        let listing = self.live.scripted.next_request("thread/list").await;
        self.live
            .scripted
            .script
            .answer(&listing, &json!({"data": [], "nextCursor": null}));
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

// The stream's reading and its export twin compose one sighting key, so either order prices one
// row, and an export of other counts on the streamed thread is a row of its own, filed on the run.
// Killed: `stated_first` and `exported_first` by a sighting the stream's reading or the export
// leaves off, or keys the two compose apart (two rows); `export_only_on_a_streamed_thread` by a key
// that leaves out the counts (one row).
#[rstest]
#[case::stated_first(Arrival::StatedFirst)]
#[case::exported_first(Arrival::ExportedFirst)]
#[case::export_only_on_a_streamed_thread(Arrival::ExportOnlyOnAStreamedThread)]
#[tokio::test]
async fn an_exported_response_is_counted_once_on_its_session(#[case] arrival: Arrival) {
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    let stated = counts(1_000, 500);
    // The stream's reading and the export are both decided before the rows are read.
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
            answer_region_read(&mut session.live.scripted).await;
            session.state(&stated);
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
    };

    assert_eq!(session.usage.rows_once_decided(2).await, expected);
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

// A completed response on `thread_id` carrying `counts` and the person's identity, observed at
// `observed_at_ms`.
fn stamped_record(thread_id: &str, counts: &UsageAxisCounts, observed_at_ms: u64) -> LogRecord {
    LogRecord {
        observed_time_unix_nano: observed_at_ms * 1_000_000,
        ..codex_record(completed_response_attributes(thread_id, counts))
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

// A reviewer fork's requests, on a thread no listing names, are counted once on the session under
// its account: joined to the latest review window on the session's turn, else to the turn live at
// their first record, and none of the person's identity is logged. Killed: `latest_window` by
// refusing a not-listed bucket without the join (no rows), by the first window in place of the
// latest (rows on `turn-0`) and by logging a record's attributes (the identity in a log line);
// `live_turn_only` by refusing a bucket no window covers while a turn is live (no rows);
// `listing_fails` by an unbounded keep (no refusal, and 1,001 refused with the launch) and by a
// launch dropped silently (no refusals with it).
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
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    // Read once the session's task stamped its turn's start, which the paused clock waits for.
    tokio::time::sleep(Duration::from_millis(10)).await;
    let now = read_unix_time_ms();
    if let ReviewCover::LatestWindow = cover {
        let script = &session.live.scripted.script;
        script.send(&review_started("review-0", "turn-0", now - 20_000));
        script.send(&review_started("review-1", TEST_TURN, now - 10_000));
        // The windows open before the fork's records are joined.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if let ReviewCover::ListingFails = cover {
        let records = (0..=1_000)
            .map(|_| stamped_record(FORK_THREAD, &counts(10, 1), now))
            .collect();
        session.export_records(records).await;
        let list = session.live.scripted.next_request("thread/list").await;
        session.live.scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "id": list["id"],
            "error": { "code": -32603, "message": "the listing failed" },
        }));
        poll_until(|| refused(&recorded), |count| *count >= 1).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(
            refused(&recorded),
            1,
            "only the oldest past the bound is refused"
        );
        // A relaunch, the old tag let go, drops the launch with what it keeps, each refused.
        let relaunch = session.exports.launched(&session.live.scripted.service);
        drop(std::mem::replace(&mut session.tag, relaunch));
        session
            .exports
            .is_exporting(session.live.scripted.service.id());
        assert_eq!(refused(&recorded), 1 + 1_000);
        return;
    }
    let first = counts(300, 20);
    let second = counts(200, 10);
    session
        .export_records(vec![
            stamped_record(FORK_THREAD, &first, now),
            stamped_record(FORK_THREAD, &second, now),
        ])
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
        session.usage.rows_once_decided(2).await,
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
    let _tag = exports.launched(&live.scripted.service);
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
                // The copy reads the folder's starting level before its fork.
                let read = scripted.next_request("config/read").await;
                scripted
                    .script
                    .answer(&read, &json!({"config": {}, "origins": {}}));
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

// One rollout line of `kind` holding `payload`, stamped at `at_ms`.
fn rollout_line(at_ms: u64, kind: &str, payload: &Value) -> String {
    let at = i64::try_from(at_ms)
        .ok()
        .and_then(|at_ms| jiff::Timestamp::from_millisecond(at_ms).ok())
        .expect("the test's stamp is a time");
    json!({"timestamp": at.to_string(), "type": kind, "payload": payload}).to_string()
}

// The usage record of `response_id` on the session's thread and `turn_id`, stamped at `at_ms`.
fn rollout_record(at_ms: u64, turn_id: &str, response_id: &str, input: u64, output: u64) -> String {
    let usage = json!({
        "input_tokens": input,
        "cached_input_tokens": 0,
        "output_tokens": output,
        "reasoning_output_tokens": 0,
        "total_tokens": input + output,
    });
    let payload = json!({
        "thread_id": TEST_THREAD,
        "turn_id": turn_id,
        "response_id": response_id,
        "usage": usage,
    });
    rollout_line(at_ms, "token_usage_record", &payload)
}

// The context line of `turn_id`, naming its model, stamped at `at_ms`.
fn turn_context(at_ms: u64, turn_id: &str) -> String {
    rollout_line(
        at_ms,
        "turn_context",
        &json!({"turn_id": turn_id, "model": "gpt-5"}),
    )
}

// The session's thread's rollout file through [`TEST_TURN`]: its thread named, the response the
// stream states and a warm-up it never states, each stamped at `at_ms`.
fn first_turn_rollout(at_ms: u64) -> Vec<String> {
    vec![
        rollout_line(
            at_ms,
            "session_meta",
            &json!({"id": TEST_THREAD, "source": "cli"}),
        ),
        turn_context(at_ms, TEST_TURN),
        rollout_record(at_ms, TEST_TURN, "response-stated", 1_000, 500),
        rollout_record(at_ms, TEST_TURN, "response-warm-up", 2, 0),
    ]
}

/// The session's second turn, after [`TEST_TURN`] settles.
const SECOND_TURN: &str = "turn-2";

// Once a request turn settles with no export, the session's own rollout file is read: the
// response its stream stated is passed over by its sighting and the warm-up the stream never
// stated is counted once. Killed by passing over a streamed thread's file (one row), by a line's
// key composed apart from the stream's (three rows), and by no read as the status turns stopped
// (one row).
#[tokio::test]
async fn a_streamed_thread_s_rollout_counts_what_no_export_carried_once() {
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.write_rollout(TEST_THREAD, &first_turn_rollout(read_unix_time_ms()));

    session.state(&counts(1_000, 500));
    answer_region_read(&mut session.live.scripted).await;
    session.complete_turn();
    // The check finds no export two intervals on; the fallback's pass lists the recent helpers.
    session.answer_helper_listing().await;

    assert_eq!(
        session.usage.rows_once_decided(3).await,
        [(Some(1_000), Some(500)), (Some(2), Some(0))]
    );
}

// While the export stays stopped, the pass at each settled request turn reads the session's file
// on from where the last pass stopped: the second counts only the second turn's warm-up. Killed by
// no pass at a request turn settled while the status reads stopped (three rows).
#[tokio::test]
async fn a_second_turn_s_pass_reads_the_file_on_from_where_the_first_stopped() {
    let mut session = ExportingSession::start(&[TEST_TURN, SECOND_TURN]).await;
    let at_ms = read_unix_time_ms();
    let rollout = session.write_rollout(TEST_THREAD, &first_turn_rollout(at_ms));
    session.state(&counts(1_000, 500));
    answer_region_read(&mut session.live.scripted).await;
    session.complete_turn();
    session.answer_helper_listing().await;
    assert_eq!(
        session.usage.rows_once_decided(3).await,
        [(Some(1_000), Some(500)), (Some(2), Some(0))]
    );

    ExportingSession::append_rollout(
        &rollout,
        &[
            turn_context(at_ms, SECOND_TURN),
            rollout_record(at_ms, SECOND_TURN, "response-second", 3_000, 700),
            rollout_record(at_ms, SECOND_TURN, "response-second-warm-up", 3, 0),
        ],
    );
    let script = &session.live.scripted.script;
    script.send(&turn_started(SECOND_TURN));
    let mut reading = token_usage_frame(
        TEST_THREAD,
        &wire_counts(&counts(4_000, 1_200)),
        &wire_counts(&counts(3_000, 700)),
    );
    reading["params"]["turnId"] = json!(SECOND_TURN);
    script.send(&reading);
    script.send(&turn_completed(TEST_THREAD, SECOND_TURN, "completed"));
    session.answer_helper_listing().await;

    assert_eq!(
        session.usage.rows_once_decided(6).await,
        [
            (Some(1_000), Some(500)),
            (Some(2), Some(0)),
            (Some(3_000), Some(700)),
            (Some(3), Some(0)),
        ]
    );
}

// A response whose export comes late, after the pass priced its line, counts once: the late export
// is passed over by its sighting, and the export's other response counts. Killed by an export's
// key composed apart from the line's (the late response counted twice, five rows).
#[tokio::test]
async fn a_late_export_s_response_read_first_from_the_file_counts_once() {
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    let at_ms = read_unix_time_ms();
    let mut lines = first_turn_rollout(at_ms);
    lines.push(rollout_record(at_ms, TEST_TURN, "response-late", 7, 1));
    session.write_rollout(TEST_THREAD, &lines);
    session.state(&counts(1_000, 500));
    answer_region_read(&mut session.live.scripted).await;
    session.complete_turn();
    session.answer_helper_listing().await;
    assert_eq!(
        session.usage.rows_once_decided(4).await,
        [
            (Some(1_000), Some(500)),
            (Some(2), Some(0)),
            (Some(7), Some(1))
        ]
    );

    // Logged before its line was written; the later record is of a response no line states yet.
    session
        .export_records(vec![
            stamped_record(TEST_THREAD, &counts(7, 1), at_ms - 5),
            stamped_record(TEST_THREAD, &counts(4, 4), at_ms + 10),
        ])
        .await;

    let mut rows = session.usage.rows_once_decided(6).await;
    rows.sort_unstable();
    assert_eq!(
        rows,
        [
            (Some(2), Some(0)),
            (Some(4), Some(4)),
            (Some(7), Some(1)),
            (Some(1_000), Some(500)),
        ]
    );
}

// The pass at the stop after an export passes over the line of a response that export carried,
// though Codex stamped the line well after the export's newest record (Codex sets no bound on how
// long after): that response counts once, and the warm-ups no export carried are counted. Killed
// by a line's key composed apart from the export's and the stream's (the exported response
// counted again, five rows).
#[tokio::test]
async fn a_pass_after_an_export_passes_over_the_responses_that_export_carried() {
    let mut session = ExportingSession::start(&[TEST_TURN, SECOND_TURN]).await;
    // Well before the file is written, which the pass finds by its change time.
    let exported_at_ms = read_unix_time_ms() - 10_000;
    let written_at_ms = exported_at_ms + 1_500;
    let second_at_ms = exported_at_ms + 3_000;
    session.write_rollout(
        TEST_THREAD,
        &[
            rollout_line(
                written_at_ms,
                "session_meta",
                &json!({"id": TEST_THREAD, "source": "cli"}),
            ),
            turn_context(written_at_ms, TEST_TURN),
            rollout_record(written_at_ms, TEST_TURN, "response-exported", 1_000, 500),
            rollout_record(written_at_ms, TEST_TURN, "response-warm-up", 2, 0),
            turn_context(second_at_ms, SECOND_TURN),
            rollout_record(second_at_ms, SECOND_TURN, "response-second", 3_000, 700),
            rollout_record(second_at_ms, SECOND_TURN, "response-second-warm-up", 3, 0),
        ],
    );
    session.state(&counts(1_000, 500));
    answer_region_read(&mut session.live.scripted).await;
    session
        .export_records(vec![stamped_record(
            TEST_THREAD,
            &counts(1_000, 500),
            exported_at_ms,
        )])
        .await;
    session.complete_turn();
    // The paused clock moves on, so the second turn begins after the export and waits for one.
    assert_eq!(
        session.usage.rows_once_decided(2).await,
        [(Some(1_000), Some(500))]
    );

    let script = &session.live.scripted.script;
    script.send(&turn_started(SECOND_TURN));
    let mut reading = token_usage_frame(
        TEST_THREAD,
        &wire_counts(&counts(4_000, 1_200)),
        &wire_counts(&counts(3_000, 700)),
    );
    reading["params"]["turnId"] = json!(SECOND_TURN);
    script.send(&reading);
    script.send(&turn_completed(TEST_THREAD, SECOND_TURN, "completed"));
    // The second turn's check finds no export two intervals on, and the pass begins.
    session.answer_helper_listing().await;

    let mut rows = session.usage.rows_once_decided(7).await;
    rows.sort_unstable();
    assert_eq!(
        rows,
        [
            (Some(2), Some(0)),
            (Some(3), Some(0)),
            (Some(1_000), Some(500)),
            (Some(3_000), Some(700)),
        ]
    );
}

// A turn event of `kind` on `turn_id` in a rollout file, stamped at `at_ms`.
fn turn_event(at_ms: u64, kind: &str, turn_id: &str) -> String {
    rollout_line(
        at_ms,
        "event_msg",
        &json!({"type": kind, "turn_id": turn_id}),
    )
}

// After the export returns, the session's file is read on at each export until the turn live at
// the returning export's newest record ends: a response whose export was lost, its line written
// after the last pass, counts once from the file at the next export, and each exported response
// counts once. Killed by letting the file go as the export returns (the lost response counted
// nowhere, four rows) and by the returned export's response priced from the file too (six rows).
#[tokio::test]
async fn a_lost_response_written_after_the_export_returns_counts_once_from_the_file() {
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    let at_ms = read_unix_time_ms();
    let rollout = session.write_rollout(TEST_THREAD, &first_turn_rollout(at_ms));
    session.state(&counts(1_000, 500));
    answer_region_read(&mut session.live.scripted).await;
    session.complete_turn();
    session.answer_helper_listing().await;
    assert_eq!(
        session.usage.rows_once_decided(3).await,
        [(Some(1_000), Some(500)), (Some(2), Some(0))]
    );

    let returned_at_ms = at_ms + 1_000;
    ExportingSession::append_rollout(
        &rollout,
        &[
            turn_context(returned_at_ms, SECOND_TURN),
            turn_event(returned_at_ms, "task_started", SECOND_TURN),
            rollout_record(returned_at_ms + 5, SECOND_TURN, "response-returned", 7, 1),
        ],
    );
    session
        .export_records(vec![stamped_record(
            TEST_THREAD,
            &counts(7, 1),
            returned_at_ms,
        )])
        .await;
    assert_eq!(session.usage.rows_once_decided(5).await.len(), 3);

    ExportingSession::append_rollout(
        &rollout,
        &[
            rollout_record(returned_at_ms + 60, SECOND_TURN, "response-lost", 9, 3),
            turn_event(returned_at_ms + 70, "task_complete", SECOND_TURN),
        ],
    );
    session
        .export_records(vec![stamped_record(
            TEST_THREAD,
            &counts(4, 4),
            returned_at_ms + 100,
        )])
        .await;

    let mut rows = session.usage.rows_once_decided(7).await;
    rows.sort_unstable();
    assert_eq!(
        rows,
        [
            (Some(2), Some(0)),
            (Some(4), Some(4)),
            (Some(7), Some(1)),
            (Some(9), Some(3)),
            (Some(1_000), Some(500)),
        ]
    );
}

/// The thread of a fork below the session's thread, which the listing names.
const LISTED_FORK_THREAD: &str = "fork-2";

/// The fork's own turn.
const FORK_TURN: &str = "fork-turn";

// While the export arrives, a response placed below the session's thread reads on that thread's
// rollout file: the search inside it, which no export carries, is charged once, and the file's
// record of the exported response is passed over; a stop's pass that then reads the same file
// charges nothing more, while it counts the session's own warm-up. Killed by no read as the
// response is placed (no search row), by the read's record priced again (five rows) and by the
// stop charging the search again (two search rows).
#[tokio::test]
async fn an_off_stream_search_is_charged_once_while_the_export_arrives() {
    let mut session = ExportingSession::start(&[TEST_TURN, SECOND_TURN]).await;
    let now = read_unix_time_ms();
    let fork_meta = json!({"id": LISTED_FORK_THREAD, "forked_from_id": TEST_THREAD});
    let fork_record = json!({
        "thread_id": LISTED_FORK_THREAD,
        "turn_id": FORK_TURN,
        "response_id": "response-fork",
        "usage": {
            "input_tokens": 300, "cached_input_tokens": 0, "output_tokens": 20,
            "reasoning_output_tokens": 0, "total_tokens": 320,
        },
    });
    let fork_search = json!({
        "type": "web_search_call", "id": "ws_fork", "status": "completed",
        "action": {"type": "search", "query": "steer order"},
        "internal_chat_message_metadata_passthrough": {"turn_id": FORK_TURN},
    });
    session.write_rollout(
        LISTED_FORK_THREAD,
        &[
            rollout_line(now, "session_meta", &fork_meta),
            turn_context(now, FORK_TURN),
            rollout_line(now, "response_item", &fork_search),
            rollout_line(now, "token_usage_record", &fork_record),
        ],
    );
    session.write_rollout(
        TEST_THREAD,
        &[
            rollout_line(
                now,
                "session_meta",
                &json!({"id": TEST_THREAD, "source": "cli"}),
            ),
            turn_context(now, SECOND_TURN),
            rollout_record(now, SECOND_TURN, "response-warm-up", 2, 0),
        ],
    );

    // Logged well before the files were written, so the stop's pass finds both by their change.
    session
        .export_records(vec![stamped_record(
            LISTED_FORK_THREAD,
            &counts(300, 20),
            now - 10_000,
        )])
        .await;
    let list = session.live.scripted.next_request("thread/list").await;
    session.live.scripted.script.answer(
        &list,
        &json!({
            "data": [{"id": LISTED_FORK_THREAD, "parentThreadId": TEST_THREAD}],
            "nextCursor": null,
        }),
    );
    answer_region_read(&mut session.live.scripted).await;
    assert_eq!(session.usage.rows_once_decided(3).await.len(), 2);
    let searches = |session: &ExportingSession| {
        lock(&session.usage.metered)
            .iter()
            .filter(|metered| metered.delta.request.web_search_requests == Some(1))
            .count()
    };
    assert_eq!(searches(&session), 1);

    // A request turn that sees no export stops the status, and the stop's pass reads both files;
    // the paused clock moves on first, so the turn begins after the export.
    tokio::time::sleep(Duration::from_millis(10)).await;
    session.complete_turn();
    let script = &session.live.scripted.script;
    script.send(&turn_started(SECOND_TURN));
    let second = wire_counts(&counts(3_000, 700));
    let mut reading = token_usage_frame(TEST_THREAD, &second, &second);
    reading["params"]["turnId"] = json!(SECOND_TURN);
    script.send(&reading);
    script.send(&turn_completed(TEST_THREAD, SECOND_TURN, "completed"));
    session.answer_helper_listing().await;

    let mut rows = session.usage.rows_once_decided(5).await;
    rows.sort_unstable();
    assert_eq!(
        rows,
        [
            (None, None),
            (Some(2), Some(0)),
            (Some(300), Some(20)),
            (Some(3_000), Some(700)),
        ]
    );
    assert_eq!(searches(&session), 1);
}

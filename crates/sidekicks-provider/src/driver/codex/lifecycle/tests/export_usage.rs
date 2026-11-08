//! A session's completed responses from Codex's log export: each counted once on its session, the
//! stream's twin passed over by its counts, and a request turn's settle arming one export check.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use super::usage::{GatedUsage, answer_region_read, token_usage_frame};
use super::{LiveCodexSession, TEST_TURN, answer_stopping_request};
use crate::bounded_poll::poll_until;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::session::lifecycle_call::let_go_codex_session_record;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed, turn_started};
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exports::tests::{export_checks, export_tagged};
use crate::driver::codex::telemetry::exports::{
    CODEX_EXPORT_INTERVAL, CodexExportTag, CodexExports,
};
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
        self.exports
            .read_telemetry_export(export_tagged(&self.tag, vec![record]))
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
// the held responses with the session's record (no row).
#[rstest]
#[case::stated_first(Arrival::StatedFirst)]
#[case::exported_first(Arrival::ExportedFirst)]
#[case::export_only_on_a_streamed_thread(Arrival::ExportOnlyOnAStreamedThread)]
#[case::held_when_the_session_closes(Arrival::HeldWhenTheSessionCloses)]
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
    };

    assert_eq!(session.settled_rows(expected.len()).await, expected);
    if let Arrival::ExportOnlyOnAStreamedThread = arrival {
        let metered = lock(&session.usage.metered);
        let exported = metered.last().expect("the export's row is recorded");
        assert_eq!(exported.owner, MeteredUsageOwner::Run);
        assert_eq!(exported.binding_id, session.live.binding_id);
    }
}

// A request turn's settle arms one export check on its launch while no export arrives. Killed by
// the settle never handed to the register and by the request never marked from the metered delta
// (no check either way).
#[tokio::test]
async fn a_request_turn_waits_for_its_export_once() {
    let live = LiveCodexSession::start(&[]).await;
    tokio::time::pause();
    let exports = Arc::clone(&live.scripted.service.dependencies().exports);
    exports.launched(&live.scripted.service);
    let reading = wire_counts(&counts(1_000, 500));
    let script = &live.scripted.script;
    script.send(&turn_started(TEST_TURN));
    script.send(&token_usage_frame(TEST_THREAD, &reading, &reading));
    script.send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));

    poll_until(|| export_checks(exports.scheduler()), |checks| *checks >= 1).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(export_checks(exports.scheduler()), 1);
}

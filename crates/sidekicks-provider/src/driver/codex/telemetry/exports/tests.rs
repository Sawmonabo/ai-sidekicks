use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use rstest::rstest;
use serde_json::json;
use serde_json::value::to_raw_value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{CodexExportTag, CodexExports};
use crate::bounded_poll::poll_until;
use crate::driver::codex::event_normalizer::{
    CODEX_TURN_COMPLETED_METHOD, CODEX_TURN_STARTED_METHOD,
};
use crate::driver::codex::service::supervisor::CodexServiceId;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_account_service_for, start_scripted_codex_service,
};
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::codex::session::thread_turns::CodexThreadTurns;
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::test_registry::new_session_id;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader as _};
use crate::usage_delta_accountant::UsageAxisCounts;

const THREAD: &str = "thread-1";

/// How many export checks `scheduler` holds.
pub(crate) fn export_checks(scheduler: &Scheduler) -> usize {
    scheduler
        .waiting_job_names()
        .into_iter()
        .filter(|name| *name == "telemetry export check")
        .count()
}

// Runs one turn on the thread through the session's turn reader, as the intake does: its start,
// a metered request when `makes_request`, and its completion, whose settle goes to `exports`.
fn settle_turn(
    turns: &mut CodexThreadTurns,
    exports: &CodexExports,
    service_id: CodexServiceId,
    turn_id: &str,
    makes_request: bool,
) {
    let params = to_raw_value(&json!({"threadId": THREAD, "turn": {"id": turn_id}}))
        .expect("the params are JSON");
    assert!(
        turns
            .observe(CODEX_TURN_STARTED_METHOD, &params, Instant::now())
            .is_none()
    );
    if makes_request {
        turns.request_made(THREAD);
    }
    let settled = turns
        .observe(CODEX_TURN_COMPLETED_METHOD, &params, Instant::now())
        .expect("the live turn settles");
    exports.turn_settled(
        service_id,
        new_session_id(),
        settled.made_request,
        settled.started_at,
    );
}

/// A log export whose one resource carries `tag`, as Codex's SDK reads it from the launch, and
/// holds `records`.
pub(crate) fn export_tagged(tag: &CodexExportTag, records: Vec<LogRecord>) -> TelemetryExport {
    export_carrying(&tag.resource_attributes(), records)
}

/// A log export whose one resource carries `attributes`, a process's `OTEL_RESOURCE_ATTRIBUTES`
/// holding one pair, and holds `records`.
pub(crate) fn export_carrying(attributes: &str, records: Vec<LogRecord>) -> TelemetryExport {
    let (key, value) = attributes.split_once('=').expect("the tag is a pair");
    TelemetryExport::Logs(ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: vec![KeyValue {
                    key: key.to_owned(),
                    value: Some(AnyValue {
                        value: Some(Value::StringValue(value.to_owned())),
                    }),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            scope_logs: vec![ScopeLogs {
                log_records: records,
                ..Default::default()
            }],
            ..Default::default()
        }],
    })
}

// The export status' budget: at most one export check per launch, none while idle. Paused time,
// advanced past the export's instant, since the tracker reads a turn begun at that instant as
// exported. Killed by a check per turn (2 after two request turns), a check on a turn with no
// request (1 at the second step), an export that leaves the check armed or a tag the reader
// cannot find (1 after the export), and a relaunch keeping the old launch, whose tag was let go,
// and its check (1 at the relaunch, or 2 at the end).
#[tokio::test(start_paused = true)]
async fn a_launch_holds_one_export_check_only_while_request_turns_wait_for_an_export() {
    let scheduler = Arc::new(Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    ));
    let exports = CodexExports::new(Arc::clone(&scheduler));
    let scripted = start_scripted_codex_service();
    let service_id = scripted.service.id();
    let mut turns = CodexThreadTurns::default();

    let tag = exports.launched(&scripted.service);
    assert_eq!(export_checks(&scheduler), 0);

    settle_turn(&mut turns, &exports, service_id, "turn-1", false);
    assert_eq!(export_checks(&scheduler), 0);

    settle_turn(&mut turns, &exports, service_id, "turn-2", true);
    settle_turn(&mut turns, &exports, service_id, "turn-3", true);
    assert_eq!(export_checks(&scheduler), 1);

    exports
        .read_telemetry_export(tag.holder(), export_tagged(&tag, Vec::new()))
        .await;
    assert_eq!(export_checks(&scheduler), 0);

    // A turn begun after the export, so the export does not count for it.
    tokio::time::advance(Duration::from_millis(2)).await;
    settle_turn(&mut turns, &exports, service_id, "turn-4", true);
    assert_eq!(export_checks(&scheduler), 1);
    drop(tag);
    let _relaunch = exports.launched(&scripted.service);
    assert_eq!(export_checks(&scheduler), 0);
    settle_turn(&mut turns, &exports, service_id, "turn-5", true);
    assert_eq!(export_checks(&scheduler), 1);
}

/// The thread a session moved from one launch's service to another's.
const MOVED_THREAD: &str = "thread-moved";

// A completed response on `thread_id` of `input` input tokens, as Codex logs it.
fn response_on(thread_id: &str, input: u64) -> LogRecord {
    let counts = UsageAxisCounts {
        input: Some(input),
        output: Some(10),
        total: Some(input + 10),
        ..UsageAxisCounts::default()
    };
    codex_record(completed_response_attributes(thread_id, &counts))
}

/// How many records were refused and counted.
pub(crate) fn refused(recorded: &RecordedEvents) -> usize {
    recorded
        .counters()
        .iter()
        .filter(|counter| *counter == "driver.telemetry.recordRefused")
        .count()
}

/// The account launch A runs on, apart from B's.
fn launch_a_account() -> ProviderAccountId {
    ProviderAccountId::new("account-a".to_owned()).expect("the test's account id is valid")
}

// Two launches on one register whose drain runs: A on its own account, and B with a session on
// `TEST_THREAD` attached and a request turn settled, so B's export check is armed.
struct TwoLaunches {
    scheduler: Arc<Scheduler>,
    exports: Arc<CodexExports>,
    a: ScriptedCodexService,
    tag_a: CodexExportTag,
    tag_b: CodexExportTag,
    b_session: TestCodexSession,
}

impl TwoLaunches {
    async fn start() -> Self {
        let scheduler = Arc::new(Scheduler::start(
            Arc::new(TestWallClock::default()),
            None,
            watch::channel(0).1,
        ));
        let exports = Arc::new(CodexExports::new(Arc::clone(&scheduler)));
        let drain = exports
            .take_drain()
            .expect("the register's drain is untaken");
        tokio::spawn(drain.run(tokio_util::task::TaskTracker::new()));
        let a = start_scripted_account_service_for(launch_a_account());
        let b_session = TestCodexSession::start_on(start_scripted_codex_service()).await;
        let tag_a = exports.launched(&a.service);
        let tag_b = exports.launched(&b_session.scripted.service);
        exports.turn_settled(
            b_session.scripted.service.id(),
            b_session.task.record.session_id,
            true,
            Instant::now(),
        );
        assert_eq!(export_checks(&scheduler), 1);
        Self {
            scheduler,
            exports,
            a,
            tag_a,
            tag_b,
            b_session,
        }
    }

    // The first completed response of the next hand-over B's session's queue takes, past every
    // other item.
    async fn next_exported(&mut self) -> CodexExportedResponse {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let CodexSessionInbound::ExportedResponses(exported) =
                    self.b_session.task.next_item().await
                    && let Some(first) = exported.into_iter().next()
                {
                    return first;
                }
            }
        })
        .await
        .expect("a completed response reaches the session")
    }
}

/// What names another launch in a record read under launch A's token.
enum ForeignRecord {
    /// The resource carries B's tag.
    OtherLaunchTag,
    /// The resource carries A's tag, the response B's thread, which A never streamed.
    OtherLaunchThread,
}

// Each foreign record is counted once and reaches no session: a response B's own token posts
// next is the first B's session takes. Killed by the launch found by the resource's tag alone and
// by a forged tag only logged (the foreign response reaches B's session first), and by a thread
// of another launch's service joined onto A's own placement (the drain walks A's unanswered
// service and the count never comes).
#[rstest]
#[case::other_launch_tag(ForeignRecord::OtherLaunchTag)]
#[case::other_launch_thread(ForeignRecord::OtherLaunchThread)]
#[tokio::test]
async fn a_record_under_one_launch_s_token_naming_another_launch_is_dropped_and_counted(
    #[case] foreign: ForeignRecord,
) {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut two = TwoLaunches::start().await;
    let tag = match foreign {
        ForeignRecord::OtherLaunchTag => &two.tag_b,
        ForeignRecord::OtherLaunchThread => &two.tag_a,
    };
    two.exports
        .read_telemetry_export(
            two.tag_a.holder(),
            export_tagged(tag, vec![response_on(TEST_THREAD, 111)]),
        )
        .await;
    poll_until(|| refused(&recorded), |count| *count >= 1).await;
    assert_eq!(
        export_checks(&two.scheduler),
        1,
        "B's export check is armed"
    );

    two.exports
        .read_telemetry_export(
            two.tag_b.holder(),
            export_tagged(&two.tag_b, vec![response_on(TEST_THREAD, 222)]),
        )
        .await;
    let first = two.next_exported().await;
    assert_eq!(first.response.counts.input, Some(222));
    assert_eq!(refused(&recorded), 1);
}

// A thread A's service streamed for a session, released there and registered on B for the same
// session, which is attached to B: A's record on it reaches that session once, carrying A's
// account, counted nowhere, and B's export check stays armed. Killed by the moved thread placed
// on B (no account, or B's export status taking it), and by the moved thread dropped by the
// thread check (no response reaches the session).
#[tokio::test]
async fn a_record_on_a_thread_its_launch_streamed_before_a_move_is_filed_on_its_session() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut two = TwoLaunches::start().await;
    let session_id = two.b_session.task.record.session_id;
    two.a
        .service
        .register_thread(MOVED_THREAD.to_owned(), session_id);
    two.a.service.release_thread(MOVED_THREAD);
    two.b_session
        .scripted
        .service
        .register_thread(MOVED_THREAD.to_owned(), session_id);

    two.exports
        .read_telemetry_export(
            two.tag_a.holder(),
            export_tagged(&two.tag_a, vec![response_on(MOVED_THREAD, 333)]),
        )
        .await;

    let exported = two.next_exported().await;
    assert_eq!(exported.response.conversation_id, MOVED_THREAD);
    assert_eq!(exported.response.counts.input, Some(333));
    assert_eq!(
        exported.response.provider_account_id,
        Some(launch_a_account())
    );
    assert!(matches!(
        exported.placed,
        Some(CodexOffStreamPlacement::Released)
    ));
    assert_eq!(refused(&recorded), 0);
    assert_eq!(
        export_checks(&two.scheduler),
        1,
        "B's export check is armed"
    );
}

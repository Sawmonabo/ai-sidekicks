use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use opentelemetry_proto::tonic::resource::v1::Resource;
use serde_json::json;
use serde_json::value::to_raw_value;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;
use tokio::time::{Instant, sleep};

use super::{CodexExportTag, CodexExports};
use crate::driver::codex::event_normalizer::{
    CODEX_TURN_COMPLETED_METHOD, CODEX_TURN_STARTED_METHOD,
};
use crate::driver::codex::service::supervisor::CodexServiceId;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::thread_turns::CodexThreadTurns;
use crate::pricing::receiver::{TelemetryExport, TelemetryExportReader as _};

const THREAD: &str = "thread-1";

// How many export checks the scheduler holds.
fn export_checks(scheduler: &Scheduler) -> usize {
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
    exports.turn_settled(service_id, settled.made_request, settled.started_at);
}

// A log export whose one resource carries `tag`, as Codex's SDK reads it from the launch.
fn export_tagged(tag: &CodexExportTag) -> TelemetryExport {
    let attributes = tag.resource_attributes();
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
            ..Default::default()
        }],
    })
}

// The export status' budget: at most one export check per launch, none while idle. Real time,
// since the tracker reads a turn begun at its export's instant as exported. Killed by a check per
// turn (2 after two request turns), a check on a turn with no request (1 at the second step), an
// export that leaves the check armed or a tag the reader cannot find (1 after the export), and a
// relaunch keeping the old launch and its check (1 at the relaunch, or 2 at the end).
#[tokio::test]
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

    exports.read_telemetry_export(export_tagged(&tag)).await;
    assert_eq!(export_checks(&scheduler), 0);

    // A turn begun after the export, so the export does not count for it.
    sleep(Duration::from_millis(2)).await;
    settle_turn(&mut turns, &exports, service_id, "turn-4", true);
    assert_eq!(export_checks(&scheduler), 1);
    exports.launched(&scripted.service);
    assert_eq!(export_checks(&scheduler), 0);
    settle_turn(&mut turns, &exports, service_id, "turn-5", true);
    assert_eq!(export_checks(&scheduler), 1);
}

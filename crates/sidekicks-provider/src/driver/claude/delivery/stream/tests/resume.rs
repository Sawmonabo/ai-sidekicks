use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use jiff::{SignedDuration, Timestamp};
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::port_registration::PortRegistration;

use super::{helper_started, init, result};
use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeKeptCallsSource;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::test_registry::new_run_id;
use crate::port::held_tool_calls::{HeldToolCall, HeldToolCallReads};
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::LateAppendableRow;

// A session log's held calls, answered as given.
struct LoggedHeldCalls(Vec<HeldToolCall>);

impl HeldToolCallReads for LoggedHeldCalls {
    fn read_held_tool_calls(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<HeldToolCall>, Box<dyn Error + Send + Sync>>> {
        std::future::ready(Ok(self.0.clone())).boxed()
    }
}

// The log's held call `call_id` of the task `task_id`, on `run_id` and `binding`, opened at
// `invoked_at` and settled for `end_cause`.
fn held_call(
    call_id: &str,
    task_id: &str,
    (run_id, binding): (RunId, &str),
    invoked_at: Option<Timestamp>,
    end_cause: Option<ToolCallEndCause>,
) -> HeldToolCall {
    HeldToolCall {
        run_id,
        binding_id: binding_id(binding),
        tool_call_id: ToolCallId::new(call_id.to_owned()).expect("a call id fits"),
        tool_name: FreeFormText::new("mcp__files__export".to_owned()).expect("a tool name fits"),
        task_id: FreeFormText::new(task_id.to_owned()).expect("a task id fits"),
        survives_restart: true,
        invoked_at: invoked_at.and_then(EventOccurredAt::from_timestamp),
        end_cause,
    }
}

// Writes the conversation `conversation`'s file under `config_folder` and, beside it, the kept
// files `files`.
fn write_kept_files(config_folder: &Path, conversation: &str, files: &[(&str, Value)]) {
    let project = config_folder.join("projects").join("p");
    let kept = project.join(conversation).join("mcp-tasks");
    std::fs::create_dir_all(&kept).expect("the kept folder is made");
    std::fs::write(project.join(format!("{conversation}.jsonl")), "")
        .expect("the conversation file is written");
    for (name, contents) in files {
        std::fs::write(kept.join(name), contents.to_string()).expect("a kept file is written");
    }
}

// A call's record, which says it still runs.
fn record(call_id: &str) -> Value {
    json!({"toolUseId": call_id, "serverName": "files", "toolName": "export"})
}

// How a call closed: completed, or failed with why where it ended with no result.
#[derive(Debug, PartialEq)]
enum Ending {
    Completed,
    Failed(Option<ToolCallEndCause>),
}

// One close of a tool call.
#[derive(Debug, PartialEq)]
struct Close {
    tool_call_id: String,
    kind: &'static str,
    binding_id: Option<RuntimeBindingId>,
    run_id: RunId,
    ending: Ending,
    content: Option<String>,
    duration_ms: Option<u64>,
}

// Each close of a tool call delivered so far, sorted by the call's id.
fn closes(deliveries: Vec<RecordedDelivery>) -> Vec<Close> {
    let mut closes: Vec<_> = deliveries
        .into_iter()
        .filter_map(|delivery| {
            let row = delivery.row?;
            let (tool_call_id, run_id, duration_ms, ending) =
                if let LateAppendableRow::AgentToolCallCompleted(activity) = row {
                    (
                        activity.tool_call_id?,
                        activity.run_id,
                        activity.duration_ms,
                        Ending::Completed,
                    )
                } else if let LateAppendableRow::AgentToolCallFailed(failed) = row {
                    (
                        failed.tool_call_id?,
                        failed.run_id,
                        failed.duration_ms,
                        Ending::Failed(failed.end_cause),
                    )
                } else {
                    return None;
                };
            Some(Close {
                tool_call_id: tool_call_id.as_str().to_owned(),
                kind: delivery.kind,
                binding_id: delivery.binding_id,
                run_id,
                ending,
                content: delivery.content,
                duration_ms: duration_ms.map(SafeInt::get),
            })
        })
        .collect();
    closes.sort_by(|left, right| left.tool_call_id.cmp(&right.tool_call_id));
    closes
}

// The held calls of `calls`, read through a registered read.
fn registered(calls: Vec<HeldToolCall>) -> PortRegistration<Arc<dyn HeldToolCallReads>> {
    let held_calls = PortRegistration::new("held tool calls");
    held_calls
        .register(Arc::new(LoggedHeldCalls(calls)) as _)
        .expect("the read registers once");
    held_calls
}

// Fails when a resume leaves the log's held calls unrebuilt, ignores a saved ending, or times a
// rebuilt opening from the rebuild rather than its stored time. Mutations: the hook in
// `bring_up_and` removed (no close at all); `into_process_end` reading `Ended` as still running
// (no close for call-2); the opening timed from `Timestamp::now()` (call-1's duration near zero).
#[tokio::test(start_paused = true)]
async fn a_resume_rebuilds_the_held_calls_from_the_log_and_the_kept_files() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.closed_session().await;
    let params = resume_params(session_id);
    let run = (new_run_id(), "binding-a");
    let invoked_at = Timestamp::now() - SignedDuration::from_secs(90);
    fixture
        .services
        .ports
        .held_tool_calls
        .register(Arc::new(LoggedHeldCalls(vec![
            held_call(
                "call-5",
                "task-5",
                run,
                None,
                Some(ToolCallEndCause::DaemonRestart),
            ),
            held_call("call-3", "task-3", run, None, None),
            held_call("call-2", "task-2", run, None, None),
            held_call("call-1", "task-1", run, Some(invoked_at), None),
        ])) as _)
        .expect("the read registers once");
    write_kept_files(
        &fixture.home.join(".claude"),
        &params.resume_handle,
        &[
            (
                "mcp-task-task-2.outcome.json",
                json!({
                    "toolUseId": "call-2",
                    "status": "completed",
                    "statusMessage": "Exported",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
            ("mcp-task-task-3.meta.json", record("call-3")),
        ],
    );

    fixture
        .driver
        .resume_session(params)
        .await
        .expect("the resume answers");
    fixture.next_start().await;
    settle().await;

    let closes = closes(fixture.engine.deliveries());
    let shapes: Vec<_> = closes
        .iter()
        .map(|close| {
            (
                close.tool_call_id.as_str(),
                close.kind,
                close.binding_id.clone(),
                close.run_id,
                &close.ending,
                close.content.as_deref(),
            )
        })
        .collect();
    let binding = Some(binding_id("binding-a"));
    assert_eq!(
        shapes,
        [
            (
                "call-1",
                "afterRunRow",
                binding.clone(),
                run.0,
                &Ending::Failed(Some(ToolCallEndCause::ProcessExit)),
                None,
            ),
            (
                "call-2",
                "afterRunRow",
                binding,
                run.0,
                &Ending::Completed,
                Some("Exported")
            ),
        ]
    );
    let call_1_duration = closes[0].duration_ms.expect("the close is timed");
    assert!(
        call_1_duration >= 90_000,
        "call-1 took {call_1_duration} ms"
    );
}

// Fails when a call the resume held again from its record, or one the daemon had settled, does
// not close on its restored task's ending. Mutations: `keep_settled` skipped, or daemon-settled
// calls left out (no row for call-5); `hold_restored` skipped (no row for call-3).
#[tokio::test(start_paused = true)]
async fn a_restored_call_and_a_daemon_settled_one_land_their_endings() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let config_folder = tempfile::tempdir().expect("a scratch config folder");
    let conversation = "resumed-conversation";
    write_kept_files(
        config_folder.path(),
        conversation,
        &[("mcp-task-task-3.meta.json", record("call-3"))],
    );
    let run = (new_run_id(), "binding-a");
    let held_calls = registered(vec![
        held_call(
            "call-5",
            "task-5",
            run,
            None,
            Some(ToolCallEndCause::DaemonRestart),
        ),
        held_call("call-3", "task-3", run, None, None),
    ]);
    session
        .parts
        .establishment
        .task_services
        .delivery
        .rebuild_held_calls(
            &session.stream,
            &held_calls,
            &ClaudeKeptCallsSource::new(
                Some(config_folder.path().to_owned()),
                conversation.to_owned(),
            ),
        )
        .await
        .expect("the log reads");

    session.frame(&init());
    for (task_id, call_id) in [("task-3", "call-3"), ("task-5", "call-5")] {
        session.frame(&helper_started(task_id, "mcp_task", call_id));
        session.frame(&json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": task_id,
            "tool_use_id": call_id,
            "status": "completed",
            "summary": "Exported",
        }));
    }
    settle().await;

    let landed: Vec<_> = closes(session.engine.deliveries())
        .into_iter()
        .map(|close| (close.tool_call_id, close.kind, close.ending))
        .collect();
    assert_eq!(
        landed,
        [
            ("call-3".to_owned(), "afterRunRow", Ending::Completed),
            ("call-5".to_owned(), "afterRunRow", Ending::Completed),
        ]
    );
}

// Fails when a call held again from its record and never restored outlives the resumed process's
// first background list that leaves it out or, where that list names it, the first finished reply,
// or when either stop ends a call opened in the resumed turn. Mutations: the level arm's
// `end_unrestored` dropped (the list settles call-4 `stopped`); `end_turn`'s dropped (no close at
// the reply); `take_unlisted` ending the calls the list names (a close before the reply); either
// stop ending every open call (a row for call-9).
#[rstest]
#[case::left_out_of_the_first_list(None, json!({
    "type": "system",
    "subtype": "background_tasks_changed",
    "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    "tasks": [],
}))]
#[case::named_by_the_first_list_then_the_first_reply(
    Some(json!({
        "type": "system",
        "subtype": "background_tasks_changed",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "tasks": [{"task_id": "task-4", "task_type": "mcp_task"}],
    })),
    result(&json!({})),
)]
#[tokio::test(start_paused = true)]
async fn a_restored_call_waits_until_the_first_list_or_reply(
    #[case] first_list: Option<Value>,
    #[case] stop: Value,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let config_folder = tempfile::tempdir().expect("a scratch config folder");
    let conversation = "resumed-conversation";
    write_kept_files(
        config_folder.path(),
        conversation,
        &[("mcp-task-task-4.meta.json", record("call-4"))],
    );
    let run = (new_run_id(), "binding-a");
    session
        .parts
        .establishment
        .task_services
        .delivery
        .rebuild_held_calls(
            &session.stream,
            &registered(vec![held_call("call-4", "task-4", run, None, None)]),
            &ClaudeKeptCallsSource::new(
                Some(config_folder.path().to_owned()),
                conversation.to_owned(),
            ),
        )
        .await
        .expect("the log reads");
    session.frame(&init());
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call-9", "name": "mcp__files__read", "input": {}},
            ],
        },
    }));
    if let Some(first_list) = first_list {
        session.frame(&first_list);
        settle().await;
        assert_eq!(closes(session.engine.deliveries()), []);
    }

    session.frame(&stop);
    settle().await;

    let ended: Vec<_> = closes(session.engine.deliveries())
        .into_iter()
        .map(|close| {
            (
                close.tool_call_id,
                close.kind,
                close.binding_id,
                close.ending,
            )
        })
        .collect();
    assert_eq!(
        ended,
        [(
            "call-4".to_owned(),
            "afterRunRow",
            Some(binding_id("binding-a")),
            Ending::Failed(Some(ToolCallEndCause::ProcessExit)),
        )]
    );
}

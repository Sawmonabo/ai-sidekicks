//! A tool server's background calls on a scripted process: the frames that open and hold one, the
//! session log's held calls as the run engine's recorded closes leave them, the files Claude Code
//! keeps of them, and the closes the run engine recorded.

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use jiff::Timestamp;
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

use super::{SCRIPTED_PROVIDER_SESSION_ID, binding_id};
use crate::port::held_tool_calls::{HeldToolCall, HeldToolCallReads};
use crate::port::run_host::test_host::{RecordedDelivery, RecordingRunEngine};
use crate::run::delivery::LateAppendableRow;

/// The `system/init` frame a scripted process starts its turn with, on `opus`.
pub(crate) fn init() -> Value {
    json!({
        "type": "system",
        "subtype": "init",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "model": "opus",
    })
}

/// The start of the task `task_id` of `task_type`, which the call `tool_use_id` started.
pub(crate) fn helper_started(task_id: &str, task_type: &str, tool_use_id: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": task_id,
        "task_type": task_type,
        "tool_use_id": tool_use_id,
    })
}

/// The lead's message calling a tool server's tool that runs in the background, once per id in
/// `call_ids`.
pub(crate) fn export_calls(call_ids: &[&str]) -> Value {
    let calls: Vec<Value> = call_ids
        .iter()
        .map(|call_id| {
            json!({"type": "tool_use", "id": call_id, "name": "mcp__files__export", "input": {}})
        })
        .collect();
    json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": calls,
        },
    })
}

/// The stand-in result Claude Code answers the background call `call_id` with at once, in `words`.
pub(crate) fn stand_in(call_id: &str, words: &str) -> Value {
    json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": call_id, "content": words}],
        },
    })
}

/// The log's held call `call_id` of the task `task_id`, on `run_id` and `binding`, opened at
/// `invoked_at` and settled for `end_cause`.
pub(crate) fn held_call(
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

// A session log's held calls, each answered as the run engine's recorded closes leave it.
struct LoggedHeldCalls {
    calls: Vec<HeldToolCall>,
    engine: Arc<RecordingRunEngine>,
}

impl HeldToolCallReads for LoggedHeldCalls {
    fn read_held_tool_calls(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<HeldToolCall>, Box<dyn Error + Send + Sync>>> {
        let closes = closes(self.engine.deliveries());
        let calls = self
            .calls
            .iter()
            .filter_map(|call| {
                let newest = closes
                    .iter()
                    .rev()
                    .find(|close| close.tool_call_id == call.tool_call_id.as_str());
                match newest.map(|close| &close.ending) {
                    None => Some(call.clone()),
                    Some(Ending::Failed(Some(end_cause))) => Some(HeldToolCall {
                        end_cause: Some(*end_cause),
                        ..call.clone()
                    }),
                    Some(Ending::Completed | Ending::Failed(None)) => None,
                }
            })
            .collect();
        std::future::ready(Ok(calls)).boxed()
    }
}

/// The session log's held calls `calls`, read as the log reads them once `engine` recorded closes:
/// a call with no close answers as given, one whose newest close failed with a cause answers that
/// cause, and one with any other close is left out.
pub(crate) fn logged_held_calls(
    calls: Vec<HeldToolCall>,
    engine: &Arc<RecordingRunEngine>,
) -> Arc<dyn HeldToolCallReads> {
    Arc::new(LoggedHeldCalls {
        calls,
        engine: Arc::clone(engine),
    })
}

/// The held calls of `calls`, as [`logged_held_calls`] reads them over `engine`, through a
/// registered read.
pub(crate) fn registered(
    calls: Vec<HeldToolCall>,
    engine: &Arc<RecordingRunEngine>,
) -> PortRegistration<Arc<dyn HeldToolCallReads>> {
    let held_calls = PortRegistration::new("held tool calls");
    held_calls
        .register(logged_held_calls(calls, engine))
        .expect("the read registers once");
    held_calls
}

/// Writes the conversation `conversation`'s file under `config_folder` and, beside it, the kept
/// files `files`.
pub(crate) fn write_kept_files(config_folder: &Path, conversation: &str, files: &[(&str, Value)]) {
    let project = config_folder.join("projects").join("p");
    let kept = project.join(conversation).join("mcp-tasks");
    std::fs::create_dir_all(&kept).expect("the kept folder is made");
    std::fs::write(project.join(format!("{conversation}.jsonl")), "")
        .expect("the conversation file is written");
    for (name, contents) in files {
        std::fs::write(kept.join(name), contents.to_string()).expect("a kept file is written");
    }
}

/// A call's record, which says it still runs.
pub(crate) fn record(call_id: &str) -> Value {
    json!({"toolUseId": call_id, "serverName": "files", "toolName": "export"})
}

/// How a call closed: completed, or failed with why where it ended with no result.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Ending {
    /// It completed.
    Completed,
    /// It failed, with why where no result came.
    Failed(Option<ToolCallEndCause>),
}

/// One close of a tool call the run engine recorded.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Close {
    /// The call's id.
    pub(crate) tool_call_id: String,
    /// The delivery's kind.
    pub(crate) kind: &'static str,
    /// The binding it was appended on.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// The run it names.
    pub(crate) run_id: RunId,
    /// How the call closed.
    pub(crate) ending: Ending,
    /// Its body.
    pub(crate) content: Option<String>,
    /// How long the call ran, in milliseconds.
    pub(crate) duration_ms: Option<u64>,
}

/// Each close of a tool call in `deliveries`, in the order the run engine recorded them.
pub(crate) fn closes(deliveries: Vec<RecordedDelivery>) -> Vec<Close> {
    deliveries
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
        .collect()
}

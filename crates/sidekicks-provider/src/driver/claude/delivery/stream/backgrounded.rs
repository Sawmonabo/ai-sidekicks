//! A held tool-server call's stand-in result becomes its `agent.toolCall.backgrounded` row: the
//! stand-in is the row's body, and whether the task outlives the process is read from what Claude
//! Code keeps of it, else from the stand-in's words.

use std::error::Error;

use sidekicks_contracts::event::declared_variants::ToolCallBackgroundedPayload;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::delivery::mcp_tasks::restore::{ClaudeKeptCall, ClaudeKeptCalls};
use crate::driver::claude::delivery::run_readings::{ClaudeRow, ClaudeRowDelivery};
use crate::driver::reorder_buffer::{ReorderBufferedEvent, ReorderPairingRole};
use crate::run::delivery::LateAppendableRow;

/// The words of a stand-in whose task ends with the process.
const ENDS_WITH_THE_PROCESS: &str = "does not survive exiting this session";

/// The words of a stand-in whose task runs on the tool server itself.
const RUNS_ON_THE_SERVER: &str = "started server-side task";

impl ClaudeDeliveryStream {
    /// Sends each held call's stand-in in `stand_ins`, by the call's id with its words, as the
    /// call's `backgrounded` row on the run that opened it and that run's binding, appended after
    /// its run, so it lands even once a newer binding has dropped that one's cursor, and unpaired,
    /// the call's seen start forgotten so its later close never waits on it. What Claude Code keeps
    /// is read once; a failed read is logged and each call's survival read off its stand-in.
    pub(super) async fn send_backgrounded(
        &self,
        session: &ClaudeSessionStream,
        stand_ins: Vec<(String, String)>,
    ) {
        if stand_ins.is_empty() {
            return;
        }
        let kept = match session.kept_calls().read().await {
            Ok(kept) => Some(kept),
            Err(error) => {
                tracing::warn!(
                    session_id = %session.session_id,
                    error = &error as &(dyn Error + 'static),
                    "what Claude Code keeps of its background calls could not be read, so each \
                     call's survival is read off its stand-in"
                );
                None
            }
        };
        let rows = {
            let mut guard = session.lock();
            let readings = &mut *guard;
            let mut rows = Vec::with_capacity(stand_ins.len());
            for (tool_use_id, stand_in) in stand_ins {
                let Some((task_id, opened)) = readings.tool_server_tasks.held_call(&tool_use_id)
                else {
                    continue;
                };
                readings.buffer.forget_initiation(&tool_use_id);
                let survives_restart = survives(kept.as_ref(), (&tool_use_id, task_id), &stand_in);
                let (Ok(tool_call_id), Ok(task_id)) = (
                    ToolCallId::new(tool_use_id.clone()),
                    FreeFormText::new(task_id.to_owned()),
                ) else {
                    tracing::warn!(
                        session_id = %session.session_id,
                        tool_use_id = %tool_use_id,
                        "a Claude Code call moved to the background has an id or task id no row \
                         can carry, so its move is not recorded"
                    );
                    continue;
                };
                let run = opened.run();
                let payload = ToolCallBackgroundedPayload {
                    session_id: session.session_id,
                    run_id: run.run_id,
                    tool_name: opened.tool_name().clone(),
                    tool_call_id,
                    task_id,
                    survives_restart,
                    source_epoch: None,
                    source_position: None,
                    content_length: None,
                    content_encoding: None,
                };
                rows.push(ReorderBufferedEvent {
                    tool_call_id: None,
                    pairing_role: ReorderPairingRole::Unpaired,
                    event: ClaudeRowDelivery {
                        binding_id: run.binding_id.clone(),
                        operation: None,
                        row: ClaudeRow::AfterRun(LateAppendableRow::AgentToolCallBackgrounded(
                            payload,
                        )),
                        body: Some(stand_in),
                        message_key: None,
                    },
                });
            }
            rows
        };
        self.admit_rows(session, rows, "user").await;
    }
}

// Whether the held call `tool_use_id` of the task `task_id` outlives its process: a saved ending
// or a record says so, else its stand-in's words do, a task that names neither reading as one that
// ends.
fn survives(
    kept: Option<&ClaudeKeptCalls>,
    (tool_use_id, task_id): (&str, &str),
    stand_in: &str,
) -> bool {
    match kept.map(|kept| kept.call(tool_use_id, task_id)) {
        Some(ClaudeKeptCall::Ended { .. } | ClaudeKeptCall::Recorded) => true,
        Some(ClaudeKeptCall::Unkept) | None => {
            !stand_in.contains(ENDS_WITH_THE_PROCESS) && stand_in.contains(RUNS_ON_THE_SERVER)
        }
    }
}

//! The tool-server calls a process still held when it ended with nothing asking it to, each
//! settled by what Claude Code kept of it: a saved ending closes it as it ended, a record keeps it
//! running for the next process to restore, and a call with neither ended with the process.

use std::error::Error;

use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeKeptCall;
use crate::driver::claude::delivery::messages::{ClaudeOpenToolCall, ClaudeToolCallOutcome};
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};

impl ClaudeDeliveryStream {
    /// Settles the calls in `held`, each by its `tool_use_id` with its opening, that the
    /// session's process held as it ended unasked: a saved ending gives its close, a record
    /// writes nothing and keeps its status line, and neither closes it failed as ended with the
    /// process. What Claude Code keeps is read once; a failed read is logged and every call stays
    /// open, so the next resume or the session's close reads again.
    pub(crate) async fn settle_exit(
        &self,
        session: &ClaudeSessionStream,
        held: Vec<(String, ClaudeOpenToolCall)>,
    ) {
        if held.is_empty() {
            return;
        }
        let kept = match session.kept_calls().read().await {
            Ok(kept) => kept,
            Err(error) => {
                tracing::warn!(
                    session_id = %session.session_id,
                    error = &error as &(dyn Error + 'static),
                    "what Claude Code keeps of its background calls could not be read as its \
                     process ended, so its held calls stay open"
                );
                return;
            }
        };
        let ends = held
            .into_iter()
            .filter_map(|(tool_use_id, opened)| {
                let (outcome, text) = match kept.call(&tool_use_id) {
                    ClaudeKeptCall::Ended { outcome, text } => (outcome, text),
                    ClaudeKeptCall::Recorded => return None,
                    ClaudeKeptCall::Unkept => (
                        ClaudeToolCallOutcome::Failed {
                            end_cause: Some(ToolCallEndCause::ProcessExit),
                        },
                        None,
                    ),
                };
                Some(ClaudeHeldCallEnd {
                    tool_use_id,
                    opened,
                    outcome,
                    text,
                })
            })
            .collect();
        self.close_held_calls(session, ends, "process exit").await;
    }
}

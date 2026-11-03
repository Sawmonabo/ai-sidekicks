//! The tool-server calls a process still held when it ended while the daemon runs on and no
//! successor took its session, each settled by what Claude Code kept of it: a saved ending closes
//! it as it ended, a record keeps it running for the next process to restore, and a call with
//! neither ended with the process.

use std::error::Error;

use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeHeldCallSettle;
use crate::driver::claude::delivery::mcp_tasks::{ClaudeHeldCall, ClaudeHeldCallEnd};
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};

impl ClaudeDeliveryStream {
    /// Settles the calls in `held`, each by its task, that the session's process held as it
    /// ended: a saved ending gives its close, a record
    /// writes nothing and keeps its status line, and neither closes it failed as ended with the
    /// process. What Claude Code keeps is read once; a failed read is logged and every call stays
    /// open, so the next resume or the session's close reads again.
    pub(crate) async fn settle_exit(
        &self,
        session: &ClaudeSessionStream,
        held: Vec<(String, ClaudeHeldCall)>,
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
            .filter_map(|(task_id, held)| {
                let (outcome, text) = kept
                    .call(&held.tool_use_id, &task_id)
                    .into_end(ClaudeHeldCallSettle::ProcessExit)?;
                Some(ClaudeHeldCallEnd {
                    tool_use_id: held.tool_use_id,
                    opened: held.opened,
                    outcome,
                    text,
                })
            })
            .collect();
        self.close_held_calls(session, ends, "process exit").await;
    }
}

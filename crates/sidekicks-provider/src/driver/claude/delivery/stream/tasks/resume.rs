//! The tool-server calls a resumed session still held, rebuilt before its process starts from the
//! session's log and what Claude Code kept: a saved ending closes a call as it ended, a record
//! holds it again until the process restores its task, a call with neither ended with the process,
//! and a call the daemon settled is kept settled, so a restored task's ending still closes it.

use std::error::Error;
use std::sync::Arc;

use sidekicks_std::port_registration::PortRegistration;

use super::rebuilt_opening;
use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::mcp_tasks::restore::{
    ClaudeHeldCallSettle, ClaudeKeptCall, ClaudeKeptCallsSource,
};
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::port::held_tool_calls::HeldToolCallReads;

impl ClaudeDeliveryStream {
    /// Rebuilds the session's held calls from its log, read through `held_calls`, nothing where no
    /// read is registered, and what the resumed conversation keeps in `kept`, read once: each
    /// opening is timed from its stored time and each close goes out at once. A failed read of the
    /// kept files is logged and holds every open call until the process restores it or not. Fails
    /// when the session's log cannot be read.
    pub(crate) async fn rebuild_held_calls(
        &self,
        session: &ClaudeSessionStream,
        held_calls: &PortRegistration<Arc<dyn HeldToolCallReads>>,
        kept: &ClaudeKeptCallsSource,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let Some(reads) = held_calls.port() else {
            return Ok(());
        };
        let calls = reads.read_held_tool_calls(session.session_id).await?;
        let kept = if calls.iter().any(|call| call.end_cause.is_none()) {
            match kept.read().await {
                Ok(kept) => Some(kept),
                Err(error) => {
                    tracing::warn!(
                        session_id = %session.session_id,
                        error = &error as &(dyn Error + 'static),
                        "what Claude Code keeps of its background calls could not be read as its \
                         session resumed, so each call still open waits for the process to \
                         restore it"
                    );
                    None
                }
            }
        } else {
            None
        };
        let mut ends = Vec::new();
        {
            let mut guard = session.lock();
            let readings = &mut *guard;
            // The read answers newest first; settled calls go in oldest first, so past the
            // settled memory's cap the newest stay.
            for call in calls.into_iter().rev() {
                let opened = rebuilt_opening(&call);
                let tool_use_id = call.tool_call_id.into_string();
                let task_id = call.task_id.into_string();
                if call.end_cause.is_some() {
                    readings
                        .tool_server_tasks
                        .keep_settled(task_id, tool_use_id, opened);
                    continue;
                }
                let kept_call = kept.as_ref().map_or(ClaudeKeptCall::Recorded, |kept| {
                    kept.call(&tool_use_id, &task_id)
                });
                if let Some((outcome, text)) = kept_call.into_end(ClaudeHeldCallSettle::ProcessExit)
                {
                    ends.push(ClaudeHeldCallEnd {
                        tool_use_id,
                        opened,
                        outcome,
                        text,
                        notification: None,
                    });
                } else {
                    readings
                        .tool_server_tasks
                        .hold_restored(task_id.clone(), tool_use_id, opened);
                    readings.restored_calls.await_restore(task_id);
                }
            }
        }
        self.close_held_calls(session, ends, "resume").await;
        Ok(())
    }
}

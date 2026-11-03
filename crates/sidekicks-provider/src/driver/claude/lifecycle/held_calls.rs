//! The held tool-server calls of a closing session: the surviving tasks a live process is told to
//! stop, and the calls of a session no process runs, settled by the driver from the session's log
//! and what Claude Code kept of its conversation.

use std::error::Error;
use std::time::Duration;

use futures::future::join_all;
use sidekicks_contracts::session::id::SessionId;

use super::ClaudeDriver;
use crate::driver::claude::delivery::mcp_tasks::restore::{
    ClaudeHeldCallSettle, ClaudeKeptCalls, ClaudeKeptCallsSource,
};
use crate::driver::claude::session::restart::ended_process::ClaudeEndedConversation;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;

/// How long a person's close waits for Claude Code to take its surviving tasks' stops.
pub(super) const HELD_TASK_STOP_BOUND: Duration = Duration::from_secs(2);

/// Sends Claude Code's `stop_task` for each of `task_ids` on `channel`, all at once, and waits for
/// their answers at most `bound`. A refused or failed stop is logged; one still waiting at the
/// bound is dropped, which withdraws it.
pub(super) async fn stop_held_tasks(
    channel: &dyn ClaudeProcessChannel,
    task_ids: Vec<String>,
    bound: Duration,
) {
    let stops = task_ids.into_iter().map(|task_id| async move {
        let stop = ClaudeControlRequest::StopTask {
            task_id: task_id.clone(),
        };
        if let Err(error) = channel.send_control_request(stop).await {
            tracing::warn!(
                %task_id,
                error = &error as &(dyn Error + 'static),
                "Claude Code did not take the stop of a closed session's surviving task"
            );
        }
    });
    if tokio::time::timeout(bound, join_all(stops)).await.is_err() {
        tracing::warn!(
            "Claude Code had not answered every stop of a closed session's surviving tasks by the \
             close's bound, so the stops still waiting are withdrawn"
        );
    }
}

impl ClaudeDriver {
    /// Settles `session_id`'s open held calls for `settle`, by what `conversation` keeps of them,
    /// else the conversation the session's stored leg names; nothing before the log's read is
    /// registered. A failed read of the log, or a failed composition of the session pieces, is
    /// logged and settles nothing; a conversation or kept files that cannot be read are logged and
    /// read as nothing kept.
    pub(super) async fn settle_held_calls_at_rest(
        &self,
        session_id: SessionId,
        conversation: Option<ClaudeEndedConversation>,
        settle: ClaudeHeldCallSettle,
    ) {
        let Some(reads) = self.sources.ports.held_tool_calls.port() else {
            return;
        };
        let calls = match reads.read_held_tool_calls(session_id).await {
            Ok(calls) => calls,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &*error as &(dyn Error + 'static),
                    "a closed Claude Code session's held calls could not be read from its log, so \
                     none is settled"
                );
                return;
            }
        };
        if calls.iter().all(|call| call.end_cause.is_some()) {
            return;
        }
        let conversation = match conversation {
            Some(conversation) => Some(conversation),
            None => self
                .stored_conversation(session_id)
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        %session_id,
                        error = &error as &(dyn Error + 'static),
                        "the conversation of a closed Claude Code session could not be read, so \
                         its held calls are settled as nothing kept"
                    );
                    None
                }),
        };
        let kept = match conversation {
            Some(conversation) => ClaudeKeptCallsSource::of_conversation(&conversation)
                .read()
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        %session_id,
                        error = &error as &(dyn Error + 'static),
                        "what Claude Code keeps of a closed session's background calls could not \
                         be read, so each call still open ends with the process"
                    );
                    ClaudeKeptCalls::default()
                }),
            None => ClaudeKeptCalls::default(),
        };
        // Composed only once a call is open: a close in a fresh daemon may hold calls before any
        // session call composed the pieces.
        let parts = match self.parts() {
            Ok(parts) => parts,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "a closed Claude Code session's held calls could not be settled before the \
                     run engine is ready"
                );
                return;
            }
        };
        parts
            .establishment
            .task_services
            .delivery
            .settle_held_calls_at_rest(session_id, calls, &kept, settle)
            .await;
    }
}

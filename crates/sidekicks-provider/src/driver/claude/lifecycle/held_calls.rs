//! The held tool-server calls of a session whose process is gone or whose turns an undo cuts: the
//! surviving tasks a closing live process is told to stop, the calls of a session no process runs,
//! at its close or at the start after a restart or a Stop, settled by the driver from the session's
//! log and what Claude Code kept of its conversation, and the named calls of an undo's cut turns,
//! stopped on the live process and closed stopped.

use std::error::Error;
use std::time::Duration;

use futures::future::join_all;
use sidekicks_contracts::session::id::SessionId;
use tokio::time::timeout;

use super::ClaudeDriver;
use crate::driver::claude::delivery::mcp_tasks::restore::{
    ClaudeHeldCallSettle, ClaudeKeptCalls, ClaudeKeptCallsSource,
};
use crate::driver::claude::delivery::stream::ClaudeDeliveryStream;
use crate::driver::claude::session::conversation_home::read_claude_conversation_home;
use crate::driver::claude::session::naming::stored_claude_conversation;
use crate::driver::claude::session::restart::ended_process::ClaudeEndedConversation;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{HeldCallsSettle, SettleHeldToolCallsParams};
use crate::port::held_tool_calls::HeldToolCall;

/// How long a person's close, or an undo, waits for Claude Code to take its held tasks' stops.
pub(super) const HELD_TASK_STOP_BOUND: Duration = Duration::from_secs(2);

/// Sends Claude Code's `stop_task` for each of `task_ids` on `channel`, all at once, and waits for
/// their answers; the caller bounds the wait, and dropping it withdraws the stops still waiting. A
/// refused or failed stop is logged.
pub(super) async fn stop_held_tasks(channel: &dyn ClaudeProcessChannel, task_ids: Vec<String>) {
    join_all(
        task_ids
            .into_iter()
            .map(|task_id| stop_held_task(channel, task_id)),
    )
    .await;
}

// Sends Claude Code's `stop_task` for `task_id` on `channel` and answers whether Claude Code took
// it; a refused or failed stop is logged.
async fn stop_held_task(channel: &dyn ClaudeProcessChannel, task_id: String) -> bool {
    let stop = ClaudeControlRequest::StopTask {
        task_id: task_id.clone(),
    };
    match channel.send_control_request(stop).await {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(
                %task_id,
                error = &error as &(dyn Error + 'static),
                "Claude Code did not take the stop of a held background task"
            );
            false
        }
    }
}

/// The held background tasks of an undo's cut turns whose stop Claude Code refused or did not
/// answer within the bound, so their calls stay open and the undo does not go on.
#[derive(Debug, thiserror::Error)]
#[error("Claude Code did not take the stop of background task {}", .task_ids.join(", "))]
struct HeldTasksNotStopped {
    task_ids: Vec<String>,
}

impl ClaudeDriver {
    /// Settles the held calls of `params`' session: at the start after a restart or a Stop, from
    /// the conversation its stored leg names, as a closed session's close would, else as the
    /// restart or the Stop left them; for an undo, the calls it names, stopped on the live process.
    /// Fails as the conversation's composition fails, and an undo's as its live settle fails.
    pub(crate) async fn settle_held_tool_calls(
        &self,
        params: SettleHeldToolCallsParams,
    ) -> Result<(), DriverError> {
        let SettleHeldToolCallsParams {
            session_id,
            provider_account_id,
            conversation,
            runtime_metadata,
            settle,
        } = params;
        // An undo's calls end stopped whatever Claude Code kept, so no kept file is read for them.
        let settle = match settle {
            HeldCallsSettle::Undo { calls } => {
                return self.settle_cut_held_calls(session_id, calls).await;
            }
            HeldCallsSettle::Closed => ClaudeHeldCallSettle::SessionClose,
            HeldCallsSettle::Restarted => ClaudeHeldCallSettle::Restart,
            HeldCallsSettle::Stopped => ClaudeHeldCallSettle::Stop,
        };
        let conversation = stored_claude_conversation(
            &self.sources,
            session_id,
            provider_account_id,
            conversation,
            read_claude_conversation_home(&runtime_metadata).as_deref(),
        )
        .await?;
        self.settle_held_calls_at_rest(session_id, Some(conversation), settle)
            .await;
        Ok(())
    }

    // Ends each of `calls`, the open calls of the turns an undo cuts, stopped on `session_id`'s
    // live process: each is taken off the session's stream, its task stopped through Claude Code's
    // `stop_task`, each stop held to the bound alone, and the close of each stop Claude Code took
    // sent, landed before this answers. Fails `NoLiveSession` when no process of the session
    // lives, and naming each task whose stop was refused or not answered within the bound, whose
    // call stays open.
    async fn settle_cut_held_calls(
        &self,
        session_id: SessionId,
        calls: Vec<HeldToolCall>,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(session_id)?;
        let stream = parts.establishment.streams.get(session_id);
        let task_ids: Vec<String> = calls
            .iter()
            .map(|call| call.task_id.as_str().to_owned())
            .collect();
        let ends = ClaudeDeliveryStream::take_cut_held_calls(stream.as_deref(), calls);
        let channel = &*live.channel;
        let stops = join_all(task_ids.iter().map(|task_id: &String| async move {
            timeout(
                HELD_TASK_STOP_BOUND,
                stop_held_task(channel, task_id.clone()),
            )
            .await
            .unwrap_or(false)
        }))
        .await;
        let mut stopped = Vec::with_capacity(ends.len());
        let mut not_stopped = Vec::new();
        for ((end, task_id), is_stopped) in ends.into_iter().zip(task_ids).zip(stops) {
            if is_stopped {
                stopped.push(end);
            } else {
                not_stopped.push(task_id);
            }
        }
        parts
            .establishment
            .task_services
            .delivery
            .close_held_calls_directly(session_id, stopped)
            .await;
        if not_stopped.is_empty() {
            Ok(())
        } else {
            Err(DriverError::Internal(Box::new(HeldTasksNotStopped {
                task_ids: not_stopped,
            })))
        }
    }

    /// Settles `session_id`'s open held calls for `settle`, by what `conversation` keeps of them,
    /// else the conversation the session's stored leg names; nothing before the log's read is
    /// registered. A failed read of the log, or a failed composition of the session pieces, is
    /// logged and settles nothing; a conversation that cannot be read is logged and read as
    /// nothing kept, and so are kept files that cannot be read at a close, while after a restart or
    /// a Stop they are logged and leave every call open for Claude Code's own restore at the next
    /// resume.
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
                    "a resting Claude Code session's held calls could not be read from its log, so \
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
            Some(conversation) => {
                match ClaudeKeptCallsSource::of_conversation(&conversation)
                    .read()
                    .await
                {
                    Ok(kept) => kept,
                    Err(error) => match settle {
                        ClaudeHeldCallSettle::Restart | ClaudeHeldCallSettle::Stop => {
                            tracing::warn!(
                                %session_id,
                                error = &error as &(dyn Error + 'static),
                                "what Claude Code keeps of a session's background calls could \
                                 not be read after a restart or a Stop, so each call stays open \
                                 for the session's next resume"
                            );
                            return;
                        }
                        ClaudeHeldCallSettle::ProcessExit | ClaudeHeldCallSettle::SessionClose => {
                            tracing::warn!(
                                %session_id,
                                error = &error as &(dyn Error + 'static),
                                "what Claude Code keeps of a closed session's background calls \
                                 could not be read, so each call still open ends with the process"
                            );
                            ClaudeKeptCalls::default()
                        }
                    },
                }
            }
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
                    "a resting Claude Code session's held calls could not be settled before the \
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

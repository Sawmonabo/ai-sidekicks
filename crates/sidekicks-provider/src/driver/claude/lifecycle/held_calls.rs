//! The held tool-server calls of a session whose process is gone: the surviving tasks a closing
//! live process is told to stop, and the calls of a session no process runs, at its close or at the
//! start after a restart or a Stop, settled by the driver from the session's log and what Claude
//! Code kept of its conversation. A person's close of a session no process runs, and the start
//! that finishes a close a restart cut short, first stops its surviving tasks in a process resumed
//! for that alone, which runs no turn.

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use futures::stream::{FuturesUnordered, StreamExt};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout_at};

use super::ClaudeDriver;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::mcp_tasks::restore::{
    ClaudeHeldCallSettle, ClaudeKeptCall, ClaudeKeptCalls, ClaudeKeptCallsSource,
};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::session::conversation_home::read_claude_conversation_home;
use crate::driver::claude::session::naming::{compose_resting_legs, stored_claude_conversation};
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::restart::ended_process::ClaudeEndedConversation;
use crate::driver::claude::session::tool_server_calls::{
    ClaudeToolServerCallContext, ClaudeToolServerCalls,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::launch::bring_up::{ClaudeBringUpRequest, ClaudeSessionSpawn};
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcessArrival, ForwardedArrivals,
};
use crate::driver::claude::spawn::launch::one_turn::answer_unwatched;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{HeldCallsSettle, SettleHeldToolCallsParams};
use crate::port::held_tool_calls::HeldToolCall;

/// How long a person's close waits for Claude Code to take its surviving tasks' stops; at rest,
/// from the moment the resumed process is up to the last answer.
pub(super) const HELD_TASK_STOP_BOUND: Duration = Duration::from_secs(2);

/// Sends Claude Code's `stop_task` for each of `task_ids` on `channel`, all at once, and waits for
/// their answers; the caller bounds the wait, and dropping it withdraws the stops still waiting. A
/// refused or failed stop is logged.
pub(super) async fn stop_held_tasks(channel: &dyn ClaudeProcessChannel, task_ids: Vec<String>) {
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
    join_all(stops).await;
}

impl ClaudeDriver {
    /// Settles the held calls of `params`' session at the start after a restart or a Stop, from the
    /// conversation its stored leg names: as a person's close of a session at rest would, its
    /// surviving tasks stopped first, else as the restart or the Stop left them. Fails only as the
    /// conversation's composition fails.
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
        let conversation = stored_claude_conversation(
            &self.sources,
            session_id,
            provider_account_id,
            conversation,
            read_claude_conversation_home(&runtime_metadata).as_deref(),
        )
        .await?;
        let (settle, stops_surviving_tasks) = match settle {
            HeldCallsSettle::Closed => (ClaudeHeldCallSettle::SessionClose, true),
            HeldCallsSettle::Restarted => (ClaudeHeldCallSettle::Restart, false),
            HeldCallsSettle::Stopped => (ClaudeHeldCallSettle::Stop, false),
        };
        self.settle_held_calls_at_rest(
            session_id,
            Some(conversation),
            settle,
            stops_surviving_tasks,
        )
        .await;
        Ok(())
    }

    /// Settles `session_id`'s open held calls for `settle`, by what `conversation` keeps of them,
    /// else the conversation the session's stored leg names; nothing before the log's read is
    /// registered. Where `stops_surviving_tasks`, each call's task Claude Code's record says still
    /// runs is first stopped in a process resumed on the conversation, and what Claude Code keeps
    /// is read again once it closed. A failed read of the log, or a failed composition of the
    /// session pieces, is logged and settles nothing; a conversation that cannot be read is logged
    /// and read as nothing kept, and so are kept files that cannot be read at a close, while after
    /// a restart or a Stop they are logged and leave every call open for Claude Code's own restore
    /// at the next resume.
    pub(super) async fn settle_held_calls_at_rest(
        &self,
        session_id: SessionId,
        conversation: Option<ClaudeEndedConversation>,
        settle: ClaudeHeldCallSettle,
        stops_surviving_tasks: bool,
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
                    Ok(kept) if stops_surviving_tasks => {
                        self.stop_surviving_tasks_at_rest(session_id, &calls, &conversation, kept)
                            .await
                    }
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

    // Stops, in a process resumed on `conversation` that runs no turn, the task of each open call
    // in `calls` that `kept` reads as recorded, one outliving the session's last process, and
    // answers what Claude Code keeps once that process closed. It takes the process's bring-up,
    // then at most `HELD_TASK_STOP_BOUND` for the stops, then the close's own wait, up to the
    // request deadline, while the process's requests are still answered. Answers `kept` itself
    // when no task survives, and, each logged, when the session has no stored leg, its legs cannot
    // be composed, the process cannot start, or the new read fails.
    async fn stop_surviving_tasks_at_rest(
        &self,
        session_id: SessionId,
        calls: &[HeldToolCall],
        conversation: &ClaudeEndedConversation,
        kept: ClaudeKeptCalls,
    ) -> ClaudeKeptCalls {
        let surviving: Vec<String> = calls
            .iter()
            .filter(|call| {
                call.end_cause.is_none()
                    && kept.call(call.tool_call_id.as_str(), call.task_id.as_str())
                        == ClaudeKeptCall::Recorded
            })
            .map(|call| call.task_id.as_str().to_owned())
            .collect();
        if surviving.is_empty() {
            return kept;
        }
        let leg = match self.read_session_leg(session_id).await {
            Ok(Some(leg)) => leg,
            Ok(None) => {
                tracing::warn!(
                    %session_id,
                    "a closed Claude Code session's surviving tasks have no stored leg to resume \
                     them on, so none of them is stopped"
                );
                return kept;
            }
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "a closed Claude Code session's stored leg could not be read, so none of its \
                     surviving tasks is stopped"
                );
                return kept;
            }
        };
        let spawn_config = leg.spawn_config;
        let account = spawn_config.provider_account_id;
        let legs = match compose_resting_legs(
            &self.sources,
            session_id,
            account.clone(),
            read_claude_conversation_home(&leg.runtime_metadata).as_deref(),
            spawn_config.tool_servers,
            spawn_config.execution_posture,
        )
        .await
        {
            Ok(legs) => legs,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the process that stops a closed Claude Code session's surviving tasks could \
                     not be composed, so none of them is stopped"
                );
                return kept;
            }
        };
        let servers = self.sources.ports.in_process_tool_servers.port();
        let (listener, mut arrivals) = ForwardedArrivals::open();
        let resume_handle = conversation.provider_session_id.clone();
        let started = self
            .starts
            .start_session(ClaudeBringUpRequest {
                spawn: ClaudeSessionSpawn {
                    legs: &legs,
                    session_rules: &[],
                    step_bound: None,
                    in_process_servers: servers,
                    path_rules: PathRules::NATIVE,
                },
                provider_session_id: resume_handle.clone(),
                account: ClaudeProcessAccount::new(Some(account.clone())),
                conversation: ClaudeConversationStart::Resume { resume_handle },
                listener,
                turn_holds: None,
                permission_mode: None,
                messaging_socket: None,
            })
            .await;
        let channel = match started {
            Ok(started) => started.channel,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the process that stops a closed Claude Code session's surviving tasks did not \
                     start, so none of them is stopped"
                );
                return kept;
            }
        };
        let tool_calls = ClaudeToolServerCalls::default();
        let context = ClaudeToolServerCallContext {
            session_id,
            provider_account_id: account,
            channel: Arc::clone(&channel),
            servers: servers.cloned(),
        };
        let stops = stop_restored_tasks(&tool_calls, &context, &mut arrivals, surviving);
        if timeout_at(Instant::now() + HELD_TASK_STOP_BOUND, stops)
            .await
            .is_err()
        {
            tracing::warn!(
                %session_id,
                "Claude Code had not restored and stopped every surviving task of a closed session \
                 by the close's deadline, so the stops still waiting are withdrawn"
            );
        }
        tool_calls.cancel_all();
        close_answering(&tool_calls, &context, &mut arrivals).await;
        ClaudeKeptCallsSource::of_conversation(conversation)
            .read()
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "what Claude Code keeps of a closed session's background calls could not be \
                     read again after their stops, so they settle as read before"
                );
                kept
            })
    }
}

// Sends `stop_task` on `context`'s process for each of `task_ids` once Claude Code names it
// restored, by its `task_started` or a background list, answering what the process asks meanwhile
// as a process no one watches does, its in-process tool-server calls held in `tool_calls`. Ends
// once every task's stop is answered, or the process exits.
async fn stop_restored_tasks(
    tool_calls: &ClaudeToolServerCalls,
    context: &ClaudeToolServerCallContext,
    arrivals: &mut mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
    mut waiting: Vec<String>,
) {
    let mut stops = FuturesUnordered::new();
    while !waiting.is_empty() || !stops.is_empty() {
        tokio::select! {
            Some(()) = stops.next(), if !stops.is_empty() => {}
            arrival = arrivals.recv() => match arrival {
                Some(ClaudeShortProcessArrival::Frame(frame)) => {
                    let restored = take_restored_tasks(&frame, &mut waiting);
                    if !restored.is_empty() {
                        stops.push(stop_held_tasks(&*context.channel, restored));
                    }
                }
                Some(ClaudeShortProcessArrival::Request(event)) => {
                    answer_request_event(tool_calls, context, event).await;
                }
                Some(ClaudeShortProcessArrival::Exit) | None => return,
            },
        }
    }
}

// Closes `context`'s process, answering what it asks meanwhile as `stop_restored_tasks` does, so
// a turn Claude Code starts on its tasks' notifications ends rather than holding the close.
async fn close_answering(
    tool_calls: &ClaudeToolServerCalls,
    context: &ClaudeToolServerCallContext,
    arrivals: &mut mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
) {
    let mut closing = std::pin::pin!(context.channel.close());
    loop {
        tokio::select! {
            () = &mut closing => return,
            arrival = arrivals.recv() => match arrival {
                Some(ClaudeShortProcessArrival::Request(event)) => {
                    answer_request_event(tool_calls, context, event).await;
                }
                Some(ClaudeShortProcessArrival::Frame(_)) => {}
                Some(ClaudeShortProcessArrival::Exit) | None => {
                    closing.await;
                    return;
                }
            },
        }
    }
}

// Answers a request the process asks as a process no one watches does, its in-process tool-server
// calls held in `tool_calls`, or withdraws the call a cancel names.
async fn answer_request_event(
    tool_calls: &ClaudeToolServerCalls,
    context: &ClaudeToolServerCallContext,
    event: ClaudeInboundRequestEvent,
) {
    match event {
        ClaudeInboundRequestEvent::Request(asked) => {
            let context = ClaudeToolServerCallContext {
                session_id: context.session_id,
                provider_account_id: context.provider_account_id.clone(),
                channel: Arc::clone(&context.channel),
                servers: context.servers.clone(),
            };
            answer_unwatched(tool_calls, context, asked).await;
        }
        ClaudeInboundRequestEvent::Cancel { request_id } => {
            tool_calls.cancel(&request_id);
        }
    }
}

// Takes out of `waiting` each task `frame` names restored: a `task_started`'s task and a
// background list's tasks.
fn take_restored_tasks(frame: &ClaudeStreamFrame, waiting: &mut Vec<String>) -> Vec<String> {
    let Some(task) = ClaudeTaskFrame::read(&frame.text) else {
        return Vec::new();
    };
    let named: Vec<&str> = match ClaudeWireFrameKind::read(&frame.observation.frame_kind) {
        Some(ClaudeWireFrameKind::SystemTaskStarted) => task.task_id().into_iter().collect(),
        Some(ClaudeWireFrameKind::SystemBackgroundTasksChanged) => task
            .listed_task_ids()
            .map_or_else(Vec::new, Iterator::collect),
        _ => Vec::new(),
    };
    let (restored, still_waiting): (Vec<String>, Vec<String>) = std::mem::take(waiting)
        .into_iter()
        .partition(|task_id| named.contains(&task_id.as_str()));
    *waiting = still_waiting;
    restored
}

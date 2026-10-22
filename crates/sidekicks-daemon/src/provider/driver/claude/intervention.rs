//! The Claude driver's interventions on a running turn: a steer is a user message written into the
//! turn with its staged files, which Claude Code reads at its next step, and an interrupt is Claude
//! Code's `interrupt`.
//!
//! A typed refusal of the interrupt means Claude Code answered: `Degraded`, with no fallback. An
//! interrupt left unanswered past its deadline, or whose write was cut partway, stops the process
//! instead, which ends the turn as surely. Any other failure propagates. A choice Claude Code holds
//! the run on is settled first, each helper running in the foreground moves to the background so
//! the interrupt spares it, and the turn end the interrupt causes is held until Claude Code
//! answers, then delivered `interrupted`. An interrupt whose choice takes waiting messages back
//! asks Claude Code to drop the ones it holds and answers their ids, on a build that can; one that
//! cannot answers `Degraded` with the plain interrupt as its fallback.

mod foreground_helpers;
mod held_steers;
mod steers;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

pub(crate) use self::foreground_helpers::ClaudeForegroundHelpers;
use self::held_steers::ClaudeHeldSteers;
use crate::mutex_lock::lock;
use crate::provider::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::provider::driver::claude::delivery::requests::ClaudeInboundRequests;
use crate::provider::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::provider::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::provider::driver::claude::run::controls::{ClaudeChoiceSettling, settle_claude_choice};
use crate::provider::driver::claude::run::start::{ClaudeRunStart, claude_session_unavailable};
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, ClaudeUnansweredCause,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeBackgroundTasksReply, ClaudeControlRequest, ClaudeInterruptReceipt,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptPayload, InterruptPendingChoice,
    InterventionResultStatus,
};

// The capability a build declares when its interrupt can drop the messages it holds and list them.
const CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY: &str = "interrupt_cancel_queued_v1";

// The fallback a build without that capability takes: a plain interrupt.
const CLAUDE_PLAIN_INTERRUPT_FALLBACK: &str = "plain-interrupt";

/// How Claude Code settled an interrupt: answered, or stopped because it gave no answer in time.
#[derive(Debug)]
pub(crate) enum ClaudeInterruptOutcome {
    /// Claude Code answered, with its receipt.
    Answered(ClaudeInterruptReceipt),
    /// The process was stopped, which ends its turn as surely.
    Stopped,
}

/// Sends `interrupt`; a process that does not answer within the request deadline, or whose input
/// took only part of the request's line, is stopped, and its exit takes the restart path. Fails as
/// the request fails otherwise, a refusal included.
pub(crate) async fn send_claude_interrupt(
    live: &LiveClaudeSession,
    cancel_queued: bool,
) -> Result<ClaudeInterruptOutcome, ClaudeSessionError> {
    match live
        .channel
        .send_control_request(ClaudeControlRequest::Interrupt { cancel_queued })
        .await
    {
        Ok(answer) => Ok(ClaudeInterruptOutcome::Answered(
            answer
                .response
                .and_then(|response| serde_json::from_str(response.get()).ok())
                .unwrap_or_default(),
        )),
        // A cut line leaves the process's input mid-frame, so no later write would read whole.
        Err(ClaudeSessionError::Unanswered {
            cause: ClaudeUnansweredCause::Deadline | ClaudeUnansweredCause::WriteCut,
            ..
        }) => {
            live.channel.terminate().await;
            Ok(ClaudeInterruptOutcome::Stopped)
        }
        Err(error) => Err(error),
    }
}

/// The driver's own interrupt of `run_id`'s turn: the run is marked so the turn end Claude Code
/// then sends is delivered `interrupted`, and unmarked when the interrupt fails, a refusal
/// included, since returning would claim an interrupt that did not happen.
pub(crate) async fn interrupt_claude_turn(
    live: &LiveClaudeSession,
    stream: Option<&ClaudeSessionStream>,
    run_id: RunId,
) -> Result<(), ClaudeSessionError> {
    if let Some(stream) = stream {
        stream.mark_interrupted(run_id);
    }
    let sent = send_claude_interrupt(live, false).await;
    if let (Err(_), Some(stream)) = (&sent, stream) {
        stream.unmark_interrupted(run_id);
    }
    sent.map(drop)
}

// What a steer's write reaches, shared with the task that writes the rows a `Send now` held.
#[derive(Clone)]
struct ClaudeSteerWriter {
    start: ClaudeRunStart,
    dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
    held: Arc<Mutex<ClaudeHeldSteers>>,
}

/// Applies interventions to live Claude runs.
pub(crate) struct ClaudeInterventions {
    writer: ClaudeSteerWriter,
    requests: Arc<ClaudeInboundRequests>,
    helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
    foreground_helpers: Arc<Mutex<ClaudeForegroundHelpers>>,
    // Each session's steers, in the order handed over: a fair lock, which waiters take in the
    // order they first asked.
    steer_order: Mutex<HashMap<SessionId, Arc<tokio::sync::Mutex<()>>>>,
}

impl ClaudeInterventions {
    /// Interventions starting next turns through `start`, settling choices through `dialogs`,
    /// holding a `Send now` while `requests` holds an ask open, and reaching helpers through
    /// `helper_steers` and `foreground_helpers`, which the session's hooks and frames fill.
    pub(crate) fn new(
        start: ClaudeRunStart,
        dialogs: Arc<ClaudeProviderDialogs<ClaudeStreamDialogPorts>>,
        requests: Arc<ClaudeInboundRequests>,
        helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
        foreground_helpers: Arc<Mutex<ClaudeForegroundHelpers>>,
    ) -> Self {
        Self {
            writer: ClaudeSteerWriter {
                start,
                dialogs,
                held: Arc::new(Mutex::new(ClaudeHeldSteers::default())),
            },
            requests,
            helper_steers,
            foreground_helpers,
            steer_order: Mutex::new(HashMap::new()),
        }
    }

    /// Writes a steer into its run's turn, or carries out an interrupt. Steers on one session are
    /// written in the order they were handed over, however long their files take to read. Fails
    /// `NoLiveRun` when the run has no live process, with `SteerTurnEnded` when the run's turn
    /// ended before its steer could go, as the files' read fails before anything is sent, and as a
    /// write or the interrupt fails; nothing is written twice.
    pub(crate) async fn apply_intervention(
        &self,
        params: ApplyInterventionParams,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        match params {
            ApplyInterventionParams::Steer {
                target_run_id,
                client_idempotency_key,
                payload,
                ..
            } => {
                self.steer(target_run_id, client_idempotency_key, payload)
                    .await
            }
            ApplyInterventionParams::Interrupt {
                target_run_id,
                payload,
                ..
            } => self.interrupt(target_run_id, &payload).await,
        }
    }

    /// Withdraws a steer held behind a `Send now`, which never reached Claude Code; answers
    /// whether it was held.
    pub(crate) fn withdraw_held(&self, session_id: SessionId, message_id: &QueueItemId) -> bool {
        lock(&self.writer.held).withdraw(session_id, message_id)
    }

    /// Forgets a session whose process is gone: its held steers are dropped unwritten, the queue
    /// handing them again, and its helpers' tracking goes.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.writer.held).take_all(session_id);
        lock(&self.foreground_helpers).forget_session(session_id);
        lock(&self.helper_steers).forget_session(session_id);
        lock(&self.steer_order).remove(&session_id);
    }

    async fn interrupt(
        &self,
        run_id: RunId,
        payload: &InterruptPayload,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        let routes = &self.writer.start.routes;
        // A run apart from the session's process stops its own process, whose end the daemon
        // writes.
        if routes.stop_apart_run(run_id, true) {
            return Ok(applied());
        }
        let live = self.writer.start.live_session_for_run(run_id)?;
        let session_id = live.session_id;
        let stream = self.writer.start.streams.get(session_id);
        if settle_claude_choice(
            &self.writer.dialogs,
            &live,
            run_id,
            ClaudeChoiceSettling::Interrupt,
        )
        .await?
        {
            return Ok(applied());
        }
        self.background_foreground_helpers(&live).await;
        if let Some(stream) = &stream {
            stream.hold_turn_end_for_interrupt(run_id);
        }
        let takes_messages_back =
            payload.reorders_waiting || payload.pending != InterruptPendingChoice::NextTurn;
        let can_cancel_queued = self.declares_cancel_queued(&live);
        let outcome = send_claude_interrupt(&live, takes_messages_back && can_cancel_queued).await;
        let is_answered = match &outcome {
            Ok(_) | Err(ClaudeSessionError::ControlRequestRefused { .. }) => true,
            Err(_) => false,
        };
        if let Some(stream) = &stream {
            if is_answered {
                stream.interrupt_daemon_end(run_id);
            } else {
                stream.release_daemon_end(run_id);
            }
        }
        let is_stopped = matches!(outcome, Ok(ClaudeInterruptOutcome::Stopped));
        let mut response = match outcome {
            Ok(ClaudeInterruptOutcome::Answered(receipt)) => {
                let mut response = applied();
                response.cancelled = self.take_cancelled(session_id, receipt);
                if takes_messages_back && !can_cancel_queued {
                    response.status = InterventionResultStatus::Degraded;
                    response.fallback_action = Some(
                        FreeFormText::new(CLAUDE_PLAIN_INTERRUPT_FALLBACK.to_owned())
                            .expect("the plain interrupt's name fits a fallback"),
                    );
                }
                response
            }
            Ok(ClaudeInterruptOutcome::Stopped) => applied(),
            Err(ClaudeSessionError::ControlRequestRefused { .. }) => ApplyInterventionResponse {
                status: InterventionResultStatus::Degraded,
                ..applied()
            },
            Err(error) => return Err(error.into()),
        };
        // The rows held behind a `Send now`: taken back with the waiting messages, or written
        // after the interrupt, in order and with no mark, so they open the next turn; a stopped
        // process drops them unwritten, and the queue hands them again.
        let held = lock(&self.writer.held).take_all(session_id);
        if takes_messages_back {
            response
                .cancelled
                .extend(held.into_iter().map(|row| row.message_id));
        } else if !is_stopped {
            self.writer.write_released(&live, held, false).await;
        }
        Ok(response)
    }

    // Moves each helper running in the foreground to the background, one request per helper, all
    // sent at once so the interrupt waits one request deadline at most; never the bare request,
    // which would move a running command too, which the interrupt is meant to end. A refusal is
    // recorded and the interrupt still goes.
    async fn background_foreground_helpers(&self, live: &LiveClaudeSession) {
        let tool_use_ids = lock(&self.foreground_helpers).tool_use_ids(live.session_id);
        let moves = tool_use_ids.into_iter().map(|tool_use_id| async move {
            if let Err(error) = background_claude_task(live, &tool_use_id).await {
                tracing::warn!(
                    session_id = %live.session_id,
                    tool_use_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a Claude Code helper could not move to the background before an interrupt"
                );
            }
        });
        futures::future::join_all(moves).await;
    }

    fn declares_cancel_queued(&self, live: &LiveClaudeSession) -> bool {
        self.writer
            .start
            .handshakes
            .held_handshake_for(live.session_id, &live.provider_session_id)
            .is_some_and(|held| {
                held.declaration
                    .capabilities
                    .iter()
                    .any(|capability| capability == CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY)
            })
    }

    // The receipt's dropped messages that read as queue items, each settled with no report.
    fn take_cancelled(
        &self,
        session_id: SessionId,
        receipt: ClaudeInterruptReceipt,
    ) -> Vec<QueueItemId> {
        let mut prompts = lock(&self.writer.start.prompts);
        receipt
            .cancelled
            .map(|cancelled| cancelled.0)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|uuid| {
                let item_id = QueueItemId::new(&uuid).ok()?;
                prompts.record_dropped(session_id, &uuid);
                Some(item_id)
            })
            .collect()
    }
}

/// Moves the foreground work one tool call started (a command, a helper) to the background, and
/// answers whether any moved: `false` when the call matched no foreground work. Fails as the
/// request fails, refused where background tasks are turned off.
pub(crate) async fn background_claude_task(
    live: &LiveClaudeSession,
    tool_use_id: &str,
) -> Result<bool, ClaudeSessionError> {
    let answer = live
        .channel
        .send_control_request(ClaudeControlRequest::BackgroundTasks {
            tool_use_id: Some(tool_use_id.to_owned()),
        })
        .await?;
    let reply: ClaudeBackgroundTasksReply = answer
        .response
        .and_then(|response| serde_json::from_str(response.get()).ok())
        .unwrap_or_default();
    // A build that does not say moved it.
    Ok(reply.backgrounded.unwrap_or(true))
}

fn applied() -> ApplyInterventionResponse {
    ApplyInterventionResponse {
        status: InterventionResultStatus::Applied,
        fallback_action: None,
        delivered_run_id: None,
        cancelled: Vec::new(),
    }
}

fn no_live_run(run_id: RunId) -> ClaudeSessionError {
    ClaudeSessionError::Unavailable {
        reason: ClaudeSessionUnavailableReason::NoLiveRun,
        detail: None,
        session_id: None,
        run_id: Some(run_id),
    }
}

// The refusal while another run's turn or a command holds the session.
fn turn_in_flight(session_id: SessionId) -> ClaudeSessionError {
    claude_session_unavailable(
        ClaudeSessionUnavailableReason::SessionTurnInFlight,
        session_id,
        None,
    )
}

#[cfg(test)]
mod tests;

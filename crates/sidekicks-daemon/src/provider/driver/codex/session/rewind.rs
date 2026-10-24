//! Cutting a Codex conversation back in place with `thread/revert`: to before one of the person's
//! messages, its running turns stopped first, and to before a turn too long for the model's window,
//! so the next message does not carry it again. Codex cuts only the conversation; the files the
//! cut turns wrote are the daemon's to restore.

use std::collections::HashMap;
use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::task::TaskTracker;

use crate::provider::driver::codex::app_server_protocol::ThreadRevertParams;
use crate::provider::driver::codex::run::control::interrupt_codex_run;
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::history::read_codex_turn_id_by_client_message_id;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::rewind::{RewindConversationParams, RewindConversationResult};

const THREAD_REVERT_METHOD: &str = "thread/revert";

/// The fallback a rewind takes for a message the conversation does not hold.
const REWIND_TARGET_UNKNOWN: &str = "rewind-target-not-a-recorded-boundary";

/// The fallback a rewind takes when a running turn did not stop in time.
const REWIND_TURN_IN_PROGRESS: &str = "rewind-deferred-turn-in-progress";

/// What the session recorded of the turn one of the person's messages started.
pub(crate) struct CodexMessageTurn {
    /// The connection the session's conversation is on, or why the service has none.
    pub(crate) connection: Result<Arc<CodexAppServerConnection>, CodexError>,
    /// The session's conversation.
    pub(crate) thread_id: String,
    /// The turn, `None` when the session recorded none still in the conversation.
    pub(crate) turn_id: Option<String>,
}

/// Cuts sessions' conversations back in place, each cut inside its session's claimed slot.
pub(crate) struct CodexConversationRewind {
    slots: Arc<CodexSessionSlots>,
    config_forks: Arc<CodexConfigForks>,
    tasks: TaskTracker,
}

impl CodexConversationRewind {
    /// A rewind claiming each session's slot through `slots`, after the config forks in flight,
    /// and cutting an oversized turn as a task of `tasks`.
    pub(crate) fn new(
        slots: Arc<CodexSessionSlots>,
        config_forks: Arc<CodexConfigForks>,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            slots,
            config_forks,
            tasks,
        }
    }

    /// Cuts the conversation back to before one of the person's messages; a running turn is
    /// stopped and its end awaited first, up to the request deadline. A message the session
    /// recorded no turn for is looked up in the conversation's history. Degrades for a message
    /// not in the conversation and for a turn that did not stop; fails with
    /// `CodexError::Transport` when the session was established anew meanwhile.
    pub(crate) async fn rewind(
        &self,
        params: &RewindConversationParams,
    ) -> Result<RewindConversationResult, CodexError> {
        self.config_forks.join(params.session_id).await;
        let inbound = self.slots.require_live(params.session_id)?;
        let Some((thread_id, before_turn_id)) = self
            .read_message_turn(&inbound, &params.target_message_id)
            .await?
        else {
            return Ok(degraded(REWIND_TARGET_UNKNOWN));
        };
        if !stop_running_turns(&inbound).await? {
            return Ok(degraded(REWIND_TURN_IN_PROGRESS));
        }
        let _claim = self.slots.claim_establishing(params.session_id).await?;
        let is_cut = call_codex_session(&inbound, |reply| CodexSessionCall::RevertBefore {
            thread_id,
            turn_id: before_turn_id,
            reply,
        })
        .await??;
        if !is_cut {
            return Err(CodexError::Transport {
                detail: format!(
                    "Codex session \"{}\" was re-established while its turn was stopping.",
                    params.session_id
                ),
                cause: None,
            });
        }
        Ok(RewindConversationResult::Applied {
            binding_id: None,
            cut_message_text: None,
        })
    }

    /// Hands a turn too long for the model's window back by cutting it out of the conversation
    /// `thread_id`, as a task of its own inside the session's slot; a session that moved to
    /// another conversation meanwhile keeps it. A failure is reported; the run already failed.
    pub(crate) fn cut_oversized_turn(&self, session_id: SessionId, thread_id: &str, turn_id: &str) {
        let slots = Arc::clone(&self.slots);
        let thread_id = thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        self.tasks.spawn(async move {
            let cut = async {
                let claim = slots.claim_establishing(session_id).await?;
                let Some(inbound) = claim.live() else {
                    return Ok(());
                };
                call_codex_session(&inbound, |reply| CodexSessionCall::RevertBefore {
                    thread_id,
                    turn_id,
                    reply,
                })
                .await??;
                Ok::<(), CodexError>(())
            };
            if let Err(error) = cut.await {
                CodexTransportDiagnostic::OversizedTurnCutFailed {
                    session_id,
                    error: Box::new(error),
                }
                .report();
            }
        });
    }

    // The conversation and the turn one of the person's messages started: the session's own
    // record, else the conversation's history, which also serves a conversation this daemon did
    // not start or has forked. `None` for a message the conversation does not hold.
    async fn read_message_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        message_id: &str,
    ) -> Result<Option<(String, String)>, CodexError> {
        let recorded = call_codex_session(inbound, |reply| CodexSessionCall::ReadMessageTurn {
            message_id: message_id.to_owned(),
            reply,
        })
        .await?;
        if let Some(turn_id) = recorded.turn_id {
            return Ok(Some((recorded.thread_id, turn_id)));
        }
        let from_history =
            read_codex_turn_id_by_client_message_id(&*recorded.connection?, &recorded.thread_id)
                .await?;
        let turn_id = from_history.get(message_id).cloned();
        // A session whose task ended keeps no turns to record.
        let _unheard = inbound.push(CodexSessionInbound::Call(
            CodexSessionCall::RecordMessageTurns {
                thread_id: recorded.thread_id.clone(),
                turn_id_by_client_message_id: from_history,
            },
        ));
        Ok(turn_id.map(|turn_id| (recorded.thread_id, turn_id)))
    }
}

// Interrupts every run whose turn runs and waits, within the request deadline, for each turn the
// interrupts stopped to end; `false` when one is still live or ending past it.
async fn stop_running_turns(inbound: &CodexSessionInboundSender) -> Result<bool, CodexError> {
    let reading = call_codex_session(inbound, |reply| CodexSessionCall::ReadSession {
        thread_id: None,
        reply,
    })
    .await?;
    let mut runs: Vec<RunId> = Vec::new();
    for run_id in reading.live_turn_runs {
        if !runs.contains(&run_id) {
            runs.push(run_id);
        }
    }
    if runs.is_empty() {
        return Ok(true);
    }
    for run_id in runs {
        interrupt_codex_run(inbound, run_id).await?;
    }
    let deadline = CodexTurnEndDeadline::for_request();
    let has_stopped =
        wait_for_codex_turns(inbound, CodexTurnWait::StoppedTurns, Some(&deadline)).await?;
    let after = call_codex_session(inbound, |reply| CodexSessionCall::ReadSession {
        thread_id: None,
        reply,
    })
    .await?;
    Ok(has_stopped && after.live_turn_runs.is_empty())
}

/// What the session recorded of the turn `message_id` started, read on the session's task.
pub(crate) fn read_codex_message_turn(
    record: &CodexSessionRecord,
    message_id: &str,
) -> CodexMessageTurn {
    CodexMessageTurn {
        connection: record.service.connection(),
        thread_id: record.thread_id.clone(),
        turn_id: record
            .turn_id_by_client_message_id
            .get(message_id)
            .filter(|turn_id| record.turn_boundaries.contains(turn_id))
            .cloned(),
    }
}

/// Records the turns of the person's messages that `thread_id`'s history listed, on the
/// session's task; a session that moved to another conversation meanwhile records none.
pub(crate) fn record_codex_message_turns(
    record: &mut CodexSessionRecord,
    thread_id: &str,
    turn_id_by_client_message_id: HashMap<String, String>,
) {
    if record.thread_id == thread_id {
        record
            .turn_id_by_client_message_id
            .extend(turn_id_by_client_message_id);
    }
}

/// Cuts the conversation back to before `turn_id` on the session's task and drops the turns and
/// messages the cut removed; `false`, with nothing sent, once the session moved off `thread_id`.
/// Fails as `thread/revert` fails, the record then left as it was.
pub(crate) async fn revert_codex_turns(
    record: &mut CodexSessionRecord,
    thread_id: &str,
    turn_id: &str,
) -> Result<bool, CodexError> {
    if record.thread_id != thread_id {
        return Ok(false);
    }
    record
        .service
        .connection()?
        .request(
            THREAD_REVERT_METHOD,
            &ThreadRevertParams {
                thread_id: thread_id.to_owned(),
                before_turn_id: turn_id.to_owned(),
            },
        )
        .await?;
    if let Some(cut) = record
        .turn_boundaries
        .iter()
        .position(|boundary| boundary == turn_id)
    {
        record.turn_boundaries.truncate(cut);
    }
    let kept = &record.turn_boundaries;
    record
        .turn_id_by_client_message_id
        .retain(|_, turn_id| kept.contains(turn_id));
    Ok(true)
}

fn degraded(fallback_action: &str) -> RewindConversationResult {
    RewindConversationResult::Degraded {
        fallback_action: Some(fallback_action.to_owned()),
    }
}

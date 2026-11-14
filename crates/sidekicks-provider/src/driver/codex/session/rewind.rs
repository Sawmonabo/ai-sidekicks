//! Cutting a Codex conversation back in place with `thread/revert`: to before one of the person's
//! messages, its running turns stopped first, and to before a turn too long for the model's window,
//! so the next message does not carry it again. Codex cuts only the conversation; the files the
//! cut turns wrote are the daemon's to restore.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use tokio_util::task::TaskTracker;

use crate::driver::codex::app_server_protocol::ThreadRevertParams;
use crate::driver::codex::run::control::interrupt_codex_run;
use crate::driver::codex::run::start::CodexRunStart;
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::history::{
    CodexSoughtMessage, CodexTurnListing, find_codex_turn, read_codex_turns,
};
use crate::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::rewind::{
    RewindConversationParams, RewindConversationResult, RewindTargetPresence,
};

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
    /// Whether a cut of the session's conversation took the message.
    pub(crate) is_cut: bool,
}

/// Cuts sessions' conversations back in place, each cut inside its session's claimed slot.
pub(crate) struct CodexConversationRewind {
    slots: Arc<CodexSessionSlots>,
    config_forks: Arc<CodexConfigForks>,
    run_start: Arc<CodexRunStart>,
    tasks: TaskTracker,
}

impl CodexConversationRewind {
    /// A rewind claiming each session's slot through `slots`, after the config forks in flight,
    /// holding the session's turn starts through `run_start`, and cutting an oversized turn as a
    /// task of `tasks`.
    pub(crate) fn new(
        slots: Arc<CodexSessionSlots>,
        config_forks: Arc<CodexConfigForks>,
        run_start: Arc<CodexRunStart>,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            slots,
            config_forks,
            run_start,
            tasks,
        }
    }

    /// Cuts the conversation back to before one of the person's messages; a running turn is
    /// stopped and its end awaited first, up to the request deadline, and no turn starts from the
    /// stop until the cut is done. A message the session recorded no turn for is looked up in the
    /// conversation's history, and where Codex lists no turn holding it the cut goes before the
    /// turn the daemon's log names. A cut Codex refuses for a turn its own record does not hold is
    /// followed by the history read again: the turn holding the message is cut before, and a
    /// conversation that holds none is `TargetNotHeld`, the record then showing the cut Codex
    /// already made. Degrades for a message not in the conversation and for a turn that did not
    /// stop; fails with `CodexError::Transport` when the session was established anew meanwhile.
    pub(crate) async fn rewind(
        &self,
        params: &RewindConversationParams,
    ) -> Result<RewindConversationResult, CodexError> {
        self.config_forks.join(params.session_id).await;
        let inbound = self.slots.require_live(params.session_id)?;
        let Some((thread_id, before_turn_id)) = self.read_message_turn(&inbound, params).await?
        else {
            return Ok(degraded(REWIND_TARGET_UNKNOWN));
        };
        // The turn starts are held before the claim, the order a turn start that forks takes them.
        let cut = self
            .run_start
            .send_apart_from_turn_starts(params.session_id, async {
                let _claim = self.slots.claim_establishing(params.session_id).await?;
                if !stop_running_turns(&inbound).await? {
                    return Ok(None);
                }
                let reverted = revert_before(&inbound, &thread_id, &before_turn_id).await;
                let cut = match reverted {
                    Err(error) if error.is_turn_not_found(&before_turn_id) => {
                        cut_after_refusal(&inbound, params, thread_id).await?
                    }
                    reverted => CodexCut::Sent { is_cut: reverted? },
                };
                Ok::<_, CodexError>(Some(cut))
            })
            .await?;
        match cut {
            None => Ok(degraded(REWIND_TURN_IN_PROGRESS)),
            Some(CodexCut::Sent { is_cut: true }) => Ok(RewindConversationResult::Applied {
                fork: None,
                cut_message_text: None,
            }),
            Some(CodexCut::Sent { is_cut: false }) => Err(CodexError::Transport {
                detail: format!(
                    "Codex session \"{}\" was re-established while its turn was stopping.",
                    params.session_id
                ),
                cause: None,
            }),
            Some(CodexCut::AlreadyMade) => Ok(RewindConversationResult::TargetNotHeld {
                fallback_action: Some(REWIND_TARGET_UNKNOWN.to_owned()),
            }),
            Some(CodexCut::NoTurn) => Ok(degraded(REWIND_TARGET_UNKNOWN)),
        }
    }

    /// Whether the conversation still holds one of the person's messages, by Codex's own record:
    /// a message a cut of this session took reads cut away. Any other is looked for in the turns
    /// Codex lists, read newest first with no items and stopped at the first turn started before
    /// the message's send: the turn the session recorded or the daemon's log named for it, or a
    /// turn holding the message's id or its turn opener's ([`find_codex_turn`]). Where Codex lists
    /// turns and none of them is that, the message reads cut away when no turn of it is known,
    /// and unconfirmed when one is, since Codex's listing can lag the record its cut reads: the
    /// cut sent before the known turn then tells the two apart ([`Self::rewind`]). A known turn
    /// is where the search looks first, never the proof of a cut, since a retry's fork drops it
    /// and sends the message again on a new turn. Wherever the listing cannot show it gone the
    /// message reads held, a conversation Codex lists no turn of among them, where the cut tells
    /// the same apart. Fails with `CodexError::Transport` when the session is not live, and as a
    /// request fails.
    pub(crate) async fn read_target(
        &self,
        params: &RewindConversationParams,
    ) -> Result<RewindTargetPresence, CodexError> {
        let inbound = self.slots.require_live(params.session_id)?;
        let message_id = params.target_message_id.as_str();
        let recorded = call_codex_session(&inbound, |reply| CodexSessionCall::ReadMessageTurn {
            message_id: message_id.to_owned(),
            reply,
        })
        .await?;
        if recorded.is_cut {
            return Ok(RewindTargetPresence::CutAway);
        }
        // A revert whose answer was lost leaves the record as it was, so Codex is asked.
        let sought = CodexSoughtMessage {
            message_id,
            opener_id: params.target_turn_opener_id.as_deref(),
            turn_id: recorded
                .turn_id
                .as_deref()
                .or(params.target_turn_id.as_ref().map(ProviderTurnId::as_str)),
        };
        let listing = find_codex_turn(&*recorded.connection?, &recorded.thread_id, sought).await?;
        Ok(match listing {
            CodexTurnListing::Listed { turn_id } => {
                if recorded.turn_id.is_none() {
                    record_message_turn(&inbound, recorded.thread_id, message_id, turn_id);
                }
                RewindTargetPresence::Held
            }
            CodexTurnListing::Unlisted if sought.turn_id.is_some() => {
                RewindTargetPresence::UnconfirmedCut
            }
            CodexTurnListing::Unlisted => RewindTargetPresence::CutAway,
            CodexTurnListing::Empty | CodexTurnListing::Indeterminate => RewindTargetPresence::Held,
        })
    }

    /// Brings the session's record to a cut before one of the person's messages that Codex
    /// already made, as a landed [`Self::rewind`] leaves it: its turns become those Codex lists,
    /// and the message and every message of a turn no longer listed read cut away. Fails with
    /// `CodexError::Transport` when the session is not live, and as the list's request fails.
    pub(crate) async fn adopt(&self, params: &RewindConversationParams) -> Result<(), CodexError> {
        let inbound = self.slots.require_live(params.session_id)?;
        let recorded = call_codex_session(&inbound, |reply| CodexSessionCall::ReadMessageTurn {
            message_id: params.target_message_id.clone(),
            reply,
        })
        .await?;
        let listed = read_codex_turns(&*recorded.connection?, &recorded.thread_id).await?;
        adopt_listed_turns(
            &inbound,
            recorded.thread_id,
            listed.into_iter().map(|turn| turn.id).collect(),
            &params.target_message_id,
        );
        Ok(())
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
                revert_before(&inbound, &thread_id, &turn_id).await?;
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

    // The conversation and the turn the cut goes before for one of the person's messages: the
    // session's own record, else the conversation's history, which also serves a conversation this
    // daemon did not start or has forked, else, where Codex lists no turn holding it, the turn the
    // daemon's log names. `None` where none of them names a turn.
    async fn read_message_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        params: &RewindConversationParams,
    ) -> Result<Option<(String, String)>, CodexError> {
        let message_id = params.target_message_id.as_str();
        let recorded = call_codex_session(inbound, |reply| CodexSessionCall::ReadMessageTurn {
            message_id: message_id.to_owned(),
            reply,
        })
        .await?;
        if let Some(turn_id) = recorded.turn_id {
            return Ok(Some((recorded.thread_id, turn_id)));
        }
        let listing = find_codex_turn(
            &*recorded.connection?,
            &recorded.thread_id,
            CodexSoughtMessage {
                message_id,
                opener_id: params.target_turn_opener_id.as_deref(),
                turn_id: params.target_turn_id.as_ref().map(ProviderTurnId::as_str),
            },
        )
        .await?;
        let turn_id = match listing {
            CodexTurnListing::Listed { turn_id } => {
                record_message_turn(
                    inbound,
                    recorded.thread_id.clone(),
                    message_id,
                    turn_id.clone(),
                );
                turn_id
            }
            // Codex looks the turn up in its own record before it cuts, so the cut lands where
            // the turn is only missing from the listing, and is refused where a cut took it.
            CodexTurnListing::Empty | CodexTurnListing::Unlisted => match &params.target_turn_id {
                Some(turn_id) => turn_id.as_str().to_owned(),
                None => return Ok(None),
            },
            CodexTurnListing::Indeterminate => return Ok(None),
        };
        Ok(Some((recorded.thread_id, turn_id)))
    }
}

/// What a cut sent inside the session's claim came to.
enum CodexCut {
    /// `thread/revert` answered; `false` where the session moved to another conversation first.
    Sent {
        /// Whether the cut was sent on the session's conversation.
        is_cut: bool,
    },
    /// Codex holds no turn with the message: a cut it already made took it.
    AlreadyMade,
    /// Nothing Codex lists names a turn to cut before.
    NoTurn,
}

// Sends the cut before `turn_id` of `thread_id` on the session's task.
async fn revert_before(
    inbound: &CodexSessionInboundSender,
    thread_id: &str,
    turn_id: &str,
) -> Result<bool, CodexError> {
    call_codex_session(inbound, |reply| CodexSessionCall::RevertBefore {
        thread_id: thread_id.to_owned(),
        turn_id: turn_id.to_owned(),
        reply,
    })
    .await?
}

// After Codex refused a cut for a turn its own record lacks, which it reads having first brought
// its listing up to that record, reads the history again for the message: a turn holding it is cut
// before, recorded as the message's; a conversation listing no turn holding it has the cut adopted
// on the record with the turns it lists, so the ask that follows the refusal reads it. Fails as a
// request fails.
async fn cut_after_refusal(
    inbound: &CodexSessionInboundSender,
    params: &RewindConversationParams,
    thread_id: String,
) -> Result<CodexCut, CodexError> {
    let message_id = params.target_message_id.as_str();
    let recorded = call_codex_session(inbound, |reply| CodexSessionCall::ReadMessageTurn {
        message_id: message_id.to_owned(),
        reply,
    })
    .await?;
    let sought = CodexSoughtMessage {
        message_id,
        opener_id: params.target_turn_opener_id.as_deref(),
        turn_id: None,
    };
    let connection = recorded.connection?;
    Ok(
        match find_codex_turn(&connection, &thread_id, sought).await? {
            CodexTurnListing::Listed { turn_id } => {
                record_message_turn(inbound, thread_id.clone(), message_id, turn_id.clone());
                CodexCut::Sent {
                    is_cut: revert_before(inbound, &thread_id, &turn_id).await?,
                }
            }
            CodexTurnListing::Empty => {
                adopt_listed_turns(inbound, thread_id, Vec::new(), message_id);
                CodexCut::AlreadyMade
            }
            CodexTurnListing::Unlisted => {
                let listed = read_codex_turns(&connection, &thread_id).await?;
                let listed_turn_ids = listed.into_iter().map(|turn| turn.id).collect();
                adopt_listed_turns(inbound, thread_id, listed_turn_ids, message_id);
                CodexCut::AlreadyMade
            }
            CodexTurnListing::Indeterminate => CodexCut::NoTurn,
        },
    )
}

// Brings the record on the session's task to a cut Codex already made before `message_id` of
// `thread_id`, its turns those Codex lists; a session whose task ended keeps no turns to adopt.
fn adopt_listed_turns(
    inbound: &CodexSessionInboundSender,
    thread_id: String,
    listed_turn_ids: Vec<String>,
    message_id: &str,
) {
    let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::AdoptCut {
        thread_id,
        listed_turn_ids,
        message_id: message_id.to_owned(),
    }));
}

// Records on the session's task the turn Codex listed holding `message_id` on `thread_id`; a
// session whose task ended keeps no turns to record.
fn record_message_turn(
    inbound: &CodexSessionInboundSender,
    thread_id: String,
    message_id: &str,
    turn_id: String,
) {
    let _unheard = inbound.push(CodexSessionInbound::Call(
        CodexSessionCall::RecordMessageTurn {
            thread_id,
            message_id: message_id.to_owned(),
            turn_id,
        },
    ));
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
        is_cut: record.cut_client_message_ids.contains(message_id),
    }
}

/// Records the turn of the person's message `message_id` that `thread_id`'s history listed, on
/// the session's task; a session that moved to another conversation meanwhile records none.
pub(crate) fn record_codex_message_turn(
    record: &mut CodexSessionRecord,
    thread_id: &str,
    message_id: String,
    turn_id: String,
) {
    if record.thread_id == thread_id {
        record
            .turn_id_by_client_message_id
            .insert(message_id, turn_id);
    }
}

/// Brings the record to a cut of `thread_id` before the person's message `message_id` that Codex
/// already made, on the session's task: its turns become `listed_turn_ids`, oldest first, as Codex
/// lists them, and the message and every message of a turn no longer kept read cut away. A
/// session that moved to another conversation meanwhile adopts nothing.
pub(crate) fn adopt_codex_cut(
    record: &mut CodexSessionRecord,
    thread_id: &str,
    listed_turn_ids: Vec<String>,
    message_id: String,
) {
    if record.thread_id != thread_id {
        return;
    }
    record.turn_boundaries = listed_turn_ids;
    forget_cut_turns(record);
    record.cut_client_message_ids.insert(message_id);
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
    forget_cut_turns(record);
    Ok(true)
}

// Moves each of the person's messages whose turn `turn_boundaries` no longer keeps from the
// message-to-turn map to the messages a cut took.
fn forget_cut_turns(record: &mut CodexSessionRecord) {
    let kept = &record.turn_boundaries;
    let cut = &mut record.cut_client_message_ids;
    record
        .turn_id_by_client_message_id
        .retain(|message_id, turn_id| {
            let is_kept = kept.contains(turn_id);
            if !is_kept {
                cut.insert(message_id.clone());
            }
            is_kept
        });
}

fn degraded(fallback_action: &str) -> RewindConversationResult {
    RewindConversationResult::Degraded {
        fallback_action: Some(fallback_action.to_owned()),
    }
}

#[cfg(test)]
mod tests;

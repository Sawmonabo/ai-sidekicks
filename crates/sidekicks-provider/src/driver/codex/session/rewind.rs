//! Cutting a Codex conversation back in place with `thread/revert`: to before one of the person's
//! messages, its running turns stopped first, and to before a turn too long for the model's window,
//! so the next message does not carry it again. Codex cuts only the conversation; the files the
//! cut turns wrote are the daemon's to restore.

use std::collections::HashMap;
use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::task::TaskTracker;

use crate::driver::codex::app_server_protocol::ThreadRevertParams;
use crate::driver::codex::run::control::interrupt_codex_run;
use crate::driver::codex::run::start::CodexRunStart;
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::history::read_codex_turn_id_by_client_message_id;
use crate::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};

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
    /// conversation's history. Degrades for a message not in the conversation and for a turn that
    /// did not stop; fails with `CodexError::Transport` when the session was established anew
    /// meanwhile.
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
        // The turn starts are held before the claim, the order a turn start that forks takes them.
        let cut = self
            .run_start
            .send_apart_from_turn_starts(params.session_id, async {
                let _claim = self.slots.claim_establishing(params.session_id).await?;
                if !stop_running_turns(&inbound).await? {
                    return Ok(None);
                }
                let is_cut = call_codex_session(&inbound, |reply| CodexSessionCall::RevertBefore {
                    thread_id,
                    turn_id: before_turn_id,
                    reply,
                })
                .await??;
                Ok::<_, CodexError>(Some(is_cut))
            })
            .await?;
        let Some(is_cut) = cut else {
            return Ok(degraded(REWIND_TURN_IN_PROGRESS));
        };
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_std::mutex_lock::lock;
    use tokio_util::task::TaskTracker;

    use super::CodexConversationRewind;
    use crate::driver::codex::run::routes::CodexRunBinding;
    use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
    use crate::driver::codex::run::start::record::CodexTurnRequest;
    use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
    use crate::driver::codex::session::fork::config_change::CodexConfigForks;
    use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
    use crate::driver::codex::session::state::CodexTurnMessage;
    use crate::driver::codex::session::test_session::{TestCodexSession, turn_reply};
    use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
    use crate::driver::test_registry::new_run_id;

    /// How long the test waits before it counts the rewind and the start as deadlocked.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    // Killed by stopping the running turns before the turn starts and the claim are held, which
    // lets a turn start between the stop and the revert.
    #[tokio::test(start_paused = true)]
    async fn a_turn_start_racing_a_rewind_waits_until_the_revert_is_done() {
        let mut session = TestCodexSession::start().await;
        let session_id = session.task.record.session_id;
        let binding_id = session.record_binding().await;
        let run_id = new_run_id();
        session.task.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: binding_id.clone(),
                agent_id: session.daemon_turn_bindings.agent_id,
                step_bound: None,
            },
        );
        session.daemon_turn_bindings.open_on(binding_id.clone());
        let record = &mut session.task.record;
        record.turn_boundaries = vec!["turn-1".to_owned()];
        record
            .turn_id_by_client_message_id
            .insert("message-0".to_owned(), "turn-1".to_owned());
        let rewind = CodexConversationRewind::new(
            Arc::clone(&session.slots),
            Arc::new(CodexConfigForks::new(
                Arc::clone(&session.slots),
                TaskTracker::new(),
            )),
            Arc::clone(&session.run_start),
            TaskTracker::new(),
        );
        let params = RewindConversationParams {
            session_id,
            binding_id: binding_id.clone(),
            target_message_id: "message-0".to_owned(),
        };
        // The service answers the revert and the turn's start, and keeps the order it was asked.
        let asked = Arc::new(Mutex::new(Vec::new()));
        let mut script = session.scripted.script;
        let service_side = tokio::spawn({
            let asked = Arc::clone(&asked);
            async move {
                loop {
                    let sent = script.next_sent().await;
                    let method = sent["method"].as_str().map(str::to_owned);
                    match method.as_deref() {
                        Some("thread/revert") => script.answer(&sent, &json!({})),
                        Some("turn/start") => script.answer(&sent, &turn_reply("turn-9")),
                        method => panic!("the service was not asked {method:?}"),
                    }
                    lock(&asked).push(method);
                }
            }
        });
        let (gate, opened) = tokio::sync::oneshot::channel::<()>();
        let run_start = Arc::clone(&session.run_start);
        let inbound = session.task.record.inbound.clone();
        let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
        let racing_start = async {
            opened.await.expect("the test opens the gate");
            run_start
                .start_turn(
                    &inbound,
                    run_id,
                    binding_id,
                    CodexTurnRequest {
                        messages: vec![CodexTurnMessage {
                            text: "Go on.".to_owned(),
                            skills: Vec::new(),
                            attachments: Vec::new(),
                        }],
                        client_message_ids: vec!["message-1".to_owned()],
                        model: None,
                        output_speed: None,
                        output_speed_for_turn: None,
                        output_schema: None,
                        level: Some(PermissionLevel::Ask),
                    },
                    None,
                    &deadline,
                )
                .await
        };
        let mut both = std::pin::pin!(async { tokio::join!(rewind.rewind(&params), racing_start) });
        let task = &mut session.task;

        let (rewound, started) = tokio::time::timeout(DEADLOCK_BOUND, async {
            // The rewind reads its message's turn, then reads the session to stop its turns:
            // the start races it from there.
            let up_to_the_stop = async {
                task.handle_next().await;
                let stop_read = task.next_item().await;
                assert!(matches!(
                    stop_read,
                    CodexSessionInbound::Call(CodexSessionCall::ReadSession { .. })
                ));
                gate.send(()).expect("the start waits on the gate");
                // The start waits on the session's turn sends, which nothing announces: with the
                // clock paused this sleep ends only once every task is idle, the start's wait among
                // them, so the stop is handled after it.
                tokio::time::sleep(Duration::from_millis(1)).await;
                task.handle(stop_read).await;
            };
            tokio::select! {
                biased;
                _ = &mut both => unreachable!("the rewind waits on its stop's read"),
                () = up_to_the_stop => {}
            }
            task.drive(&mut both).await
        })
        .await
        .expect("the rewind and the start settle");

        assert_eq!(
            rewound.expect("the rewind is answered"),
            RewindConversationResult::Applied {
                binding_id: None,
                cut_message_text: None,
            }
        );
        started.expect("the run's turn starts once the revert is done");
        assert_eq!(
            *lock(&asked),
            [
                Some("thread/revert".to_owned()),
                Some("turn/start".to_owned())
            ]
        );
        service_side.abort();
    }
}

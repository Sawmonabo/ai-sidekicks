//! Cutting a Codex conversation back in place with `thread/revert`: to before one of the person's
//! messages, its running turns stopped first, and to before a turn too long for the model's window,
//! so the next message does not carry it again. Codex cuts only the conversation; the files the
//! cut turns wrote are the daemon's to restore.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use tokio_util::task::TaskTracker;

use crate::driver::codex::app_server_protocol::{ThreadRevertParams, TurnItemsView};
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
    /// conversation's history. Degrades for a message not in the conversation and for a turn that
    /// did not stop; fails with `CodexError::Transport` when the session was established anew
    /// meanwhile.
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
            fork: None,
            cut_message_text: None,
        })
    }

    /// Whether the conversation still holds one of the person's messages, by Codex's own record:
    /// a message a cut of this session took reads cut away; one whose turn the session recorded,
    /// or the daemon's log named, reads cut away once `thread/turns/list` no longer lists that
    /// turn, and one with no turn known, as after a restart, once no turn listed since its send
    /// holds the message's id, the list read newest first with no items and stopped at the first
    /// turn started before the send ([`find_codex_turn`]). A conversation no message reached
    /// reads held. Fails with `CodexError::Transport` when the session is not live, and as a
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
            CodexTurnListing::Unlisted => RewindTargetPresence::CutAway,
            CodexTurnListing::Unmaterialized => RewindTargetPresence::Held,
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
        let listed = read_codex_turns(
            &*recorded.connection?,
            &recorded.thread_id,
            Some(TurnItemsView::NotLoaded),
        )
        .await?;
        // A session whose task ended keeps no turns to adopt.
        let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::AdoptCut {
            thread_id: recorded.thread_id,
            listed_turn_ids: listed.into_iter().map(|turn| turn.id).collect(),
            message_id: params.target_message_id.clone(),
        }));
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
                turn_id: params.target_turn_id.as_ref().map(ProviderTurnId::as_str),
            },
        )
        .await?;
        let CodexTurnListing::Listed { turn_id } = listing else {
            return Ok(None);
        };
        record_message_turn(
            inbound,
            recorded.thread_id.clone(),
            message_id,
            turn_id.clone(),
        );
        Ok(Some((recorded.thread_id, turn_id)))
    }
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
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_std::mutex_lock::lock;
    use tokio_util::task::TaskTracker;

    use sidekicks_contracts::turn::ProviderTurnId;

    use super::CodexConversationRewind;
    use crate::driver::codex::run::routes::CodexRunBinding;
    use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
    use crate::driver::codex::run::start::record::CodexTurnRequest;
    use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
    use crate::driver::codex::session::fork::config_change::CodexConfigForks;
    use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
    use crate::driver::codex::session::state::CodexTurnMessage;
    use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_reply};
    use crate::driver::rewind::{
        RewindConversationParams, RewindConversationResult, RewindTargetPresence,
    };
    use crate::driver::test_registry::new_run_id;

    /// How long the test waits before it counts the rewind and the start as deadlocked.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    fn rewind_on(session: &TestCodexSession) -> CodexConversationRewind {
        CodexConversationRewind::new(
            Arc::clone(&session.slots),
            Arc::new(CodexConfigForks::new(
                Arc::clone(&session.slots),
                TaskTracker::new(),
            )),
            Arc::clone(&session.run_start),
            TaskTracker::new(),
        )
    }

    // A record started fresh holds no message's turn, as after a restart. The ask pages the turns
    // newest first with no items and stops at the first turn started before the message's send
    // second: a turn id the daemon's log names is found among them, and a message with none is
    // found by its id in the items of the turns passed, oldest first. Killed by answering held for
    // a message whose turn is no longer listed, which cuts a cut Codex already made again, by a
    // page read past the send, by a turn's items asked in full or for a known turn, and by the
    // adopt reading items.
    #[tokio::test(start_paused = true)]
    async fn a_cut_codex_made_before_a_restart_reads_cut_away_and_is_adopted() {
        // Three messages sent in one second, 1,700,000,000, as their UUIDv7 ids date them.
        const SENT: i64 = 1_700_000_000;
        const OPENED: &str = "018bcfe5-6800-7000-8000-000000000001";
        const STEERED: &str = "018bcfe5-6800-7000-8000-000000000002";
        const CUT: &str = "018bcfe5-6800-7000-8000-000000000009";
        let mut session = TestCodexSession::start().await;
        let session_id = session.task.record.session_id;
        let binding_id = session.record_binding().await;
        let rewind = rewind_on(&session);
        let asked = Arc::new(Mutex::new(Vec::new()));
        let turn = |id: &str, started: i64| json!({"id": id, "items": [], "startedAt": started});
        let mut script = session.scripted.script;
        let service_side = tokio::spawn({
            let asked = Arc::clone(&asked);
            async move {
                loop {
                    let sent = script.next_sent().await;
                    let params = &sent["params"];
                    let reply = match sent["method"].as_str() {
                        Some("thread/turns/list") => {
                            lock(&asked).push(json!([params["itemsView"], params["cursor"]]));
                            if params["cursor"].is_null() {
                                json!({"data": [
                                    turn("turn-3", SENT + 20),
                                    turn("turn-2", SENT + 10),
                                    turn("turn-1", SENT),
                                    turn("turn-0", SENT - 50),
                                ], "nextCursor": "older"})
                            } else {
                                let old = json!({"id": "turn-old", "items": []});
                                json!({"data": [old], "nextCursor": null})
                            }
                        }
                        Some("thread/items/list") => {
                            lock(&asked).push(json!(["items", params["turnId"], params["cursor"]]));
                            let message = |client_id: &str| {
                                json!({"turnId": params["turnId"], "item": {
                                    "type": "userMessage", "id": "i", "clientId": client_id,
                                }})
                            };
                            // Turn 1's items come in two pages, so the cursor goes back as sent.
                            match (params["turnId"].as_str(), params["cursor"].as_str()) {
                                (Some("turn-1"), None) => {
                                    json!({"data": [message(OPENED)], "nextCursor": "rest"})
                                }
                                (Some("turn-0"), None) => {
                                    json!({"data": [message(STEERED)], "nextCursor": null})
                                }
                                _ => json!({"data": [], "nextCursor": null}),
                            }
                        }
                        method => panic!("the service was not asked {method:?}"),
                    };
                    script.answer(&sent, &reply);
                }
            }
        });
        let params = |message_id: &str, turn_id: Option<&str>| RewindConversationParams {
            session_id,
            binding_id: binding_id.clone(),
            target_message_id: message_id.to_owned(),
            target_turn_id: turn_id
                .map(|turn_id| ProviderTurnId::new(turn_id.to_owned()).expect("a turn id")),
        };
        let task = &mut session.task;
        let take_asked = || std::mem::take(&mut *lock(&asked));
        let first_page = json!(["notLoaded", null]);

        let opened = task
            .drive(rewind.read_target(&params(OPENED, Some("turn-1"))))
            .await;
        task.handle_next().await;
        assert_eq!(
            opened.expect("the ask is answered"),
            RewindTargetPresence::Held
        );
        assert_eq!(take_asked(), std::slice::from_ref(&first_page));
        let steered = task.drive(rewind.read_target(&params(STEERED, None))).await;
        task.handle_next().await;
        assert_eq!(
            steered.expect("the ask is answered"),
            RewindTargetPresence::Held
        );
        assert_eq!(
            take_asked(),
            [
                first_page.clone(),
                json!(["items", "turn-1", null]),
                json!(["items", "turn-1", "rest"]),
                json!(["items", "turn-0", null]),
            ]
        );
        assert_eq!(
            task.record.turn_id_by_client_message_id.get(STEERED),
            Some(&"turn-0".to_owned())
        );
        let cut = task
            .drive(rewind.read_target(&params(CUT, Some("turn-9"))))
            .await;
        assert_eq!(
            cut.expect("the ask is answered"),
            RewindTargetPresence::CutAway
        );
        assert_eq!(take_asked(), std::slice::from_ref(&first_page));
        task.drive(rewind.adopt(&params(CUT, Some("turn-9"))))
            .await
            .expect("the cut is adopted");
        task.handle_next().await;
        assert_eq!(take_asked(), [first_page, json!(["notLoaded", "older"])]);
        assert_eq!(
            task.record.turn_boundaries,
            ["turn-old", "turn-0", "turn-1", "turn-2", "turn-3"]
        );
        assert!(task.record.cut_client_message_ids.contains(CUT));
        assert_eq!(task.record.cut_client_message_ids.len(), 1);
        let again = task.drive(rewind.read_target(&params(CUT, None))).await;
        assert_eq!(
            again.expect("the ask is answered"),
            RewindTargetPresence::CutAway
        );
        service_side.abort();
    }

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
        let rewind = rewind_on(&session);
        let params = RewindConversationParams {
            session_id,
            binding_id: binding_id.clone(),
            target_message_id: "message-0".to_owned(),
            target_turn_id: None,
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
                fork: None,
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

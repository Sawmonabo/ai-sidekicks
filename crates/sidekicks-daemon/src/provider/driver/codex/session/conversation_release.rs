//! Letting go of a conversation a session moved off. Codex unloads a conversation once no client
//! holds it, and the commands it still runs end with it, so the old conversation stays subscribed,
//! its command rows reaching the session, until `thread/backgroundTerminals/list` reads no command
//! of it running. Each command's end, and each turn's end the conversation reports, reads the list
//! again, with no timer, and a list that could not be read is read again at the conversation's
//! next frame. A connection opened again subscribes to each held conversation again, and a service
//! a build move retires stays up until it holds none.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::watch;

use crate::codex::app_server_protocol::{ThreadResumeParams, ThreadUnsubscribeParams};
use crate::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_STATUS_CHANGED_METHOD,
};
use crate::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::codex::session::background_terminals::{
    end_codex_running_commands, list_codex_running_commands,
};
use crate::codex::session::errors::CodexError;
use crate::codex::session::inbound::CodexSessionInbound;
use crate::codex::session::slots::THREAD_UNSUBSCRIBE_METHOD;
use crate::codex::transport::connection::read_codex_object;
use crate::codex::transport::diagnostics::{CodexTeardownStep, CodexTransportDiagnostic};
use sidekicks_std::mutex_lock::lock;

const THREAD_RESUME_METHOD: &str = "thread/resume";

/// The item type of a command Codex runs.
const CODEX_COMMAND_ITEM_TYPE: &str = "commandExecution";

/// The status type of a conversation with no turn running.
const CODEX_IDLE_THREAD_STATUS: &str = "idle";

// A conversation held only for the commands it still runs, and the session it belonged to.
struct HeldConversation {
    service: Weak<CodexService>,
    service_id: CodexServiceId,
    session_id: SessionId,
    // Set when its running-command list could not be read, so its next frame reads it again.
    is_list_read_owed: bool,
    // Told apart from a later hold of the same conversation, so a stale read lets nothing go.
    generation: u64,
}

#[derive(Default)]
struct ReleaseState {
    // By conversation; an entry leaves once its conversation is let go or its service is gone.
    held: HashMap<String, HeldConversation>,
    next_generation: u64,
    // How many conversations each service holds here, for those waiting for none.
    held_counts: HashMap<CodexServiceId, watch::Sender<usize>>,
}

impl ReleaseState {
    fn count_on(&self, service_id: CodexServiceId) -> usize {
        self.held
            .values()
            .filter(|held| held.service_id == service_id)
            .count()
    }

    // Publishes how many conversations `service_id` holds now.
    fn publish_count(&mut self, service_id: CodexServiceId) {
        let count = self.count_on(service_id);
        self.held_counts
            .entry(service_id)
            .or_insert_with(|| watch::channel(count).0)
            .send_replace(count);
    }
}

// The members of a frame the release reads: the item's type on `item/completed` and the status's
// type on `thread/status/changed`.
#[derive(Deserialize)]
struct ReleaseFrame {
    item: Option<TypedMember>,
    status: Option<TypedMember>,
}

#[derive(Deserialize)]
struct TypedMember {
    #[serde(rename = "type")]
    member_type: Option<Box<RawValue>>,
}

fn read_member_type(member: Option<TypedMember>) -> Option<String> {
    member?
        .member_type
        .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
}

// The members of a `thread/unsubscribe` reply the release reads; any of its three statuses
// counts as let go.
#[derive(Deserialize)]
struct UnsubscribeReply {
    #[serde(rename = "status")]
    _status: Option<Box<RawValue>>,
}

/// Holds each conversation a session moved off until no command of it runs, then lets it go.
#[derive(Default)]
pub(crate) struct CodexConversationRelease {
    state: Mutex<ReleaseState>,
}

impl CodexConversationRelease {
    fn lock(&self) -> MutexGuard<'_, ReleaseState> {
        lock(&self.state)
    }

    /// Lets go of `thread_id` now, or once the commands it still runs have ended; until then its
    /// frames stay routed to `session_id`, its command frames as the session's own. The holding
    /// is done before the first await, so no frame of the conversation finds it unregistered.
    pub(crate) async fn let_go(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        thread_id: String,
        session_id: SessionId,
    ) {
        let generation = {
            let mut state = self.lock();
            state.next_generation += 1;
            let generation = state.next_generation;
            state.held.insert(
                thread_id.clone(),
                HeldConversation {
                    service: Arc::downgrade(service),
                    service_id: service.id(),
                    session_id,
                    is_list_read_owed: false,
                    generation,
                },
            );
            state.publish_count(service.id());
            generation
        };
        service.register_thread(thread_id.clone(), session_id);
        // A session whose task ended has no frames left to admit.
        let _unheard = service.push_session_item(
            &session_id,
            CodexSessionInbound::HeldThread {
                thread_id: thread_id.clone(),
                is_held: true,
            },
        );
        self.release_once_idle(thread_id, generation).await;
    }

    /// Whether a frame of `thread_id` on the service `service_id` belongs to a conversation held
    /// only for the commands it still runs. A command's end there, the conversation going idle,
    /// or any frame of one whose list was unreadable reads the list again. Called on the service's
    /// reader, so the decision is made in the frame's place.
    pub(crate) fn observe_frame(
        self: &Arc<Self>,
        service_id: CodexServiceId,
        thread_id: &str,
        method: &str,
        params: &RawValue,
    ) -> bool {
        let generation = {
            let mut state = self.lock();
            let Some(held) = state.held.get_mut(thread_id) else {
                return false;
            };
            if held.service_id != service_id {
                return false;
            }
            let rereads = held.is_list_read_owed || is_list_change(method, params);
            if !rereads {
                return true;
            }
            held.is_list_read_owed = false;
            held.generation
        };
        let release = Arc::clone(self);
        let thread_id = thread_id.to_owned();
        tokio::spawn(async move { release.release_once_idle(thread_id, generation).await });
        true
    }

    /// Forgets every conversation a session holds on `service`, its helpers' included, that
    /// `is_released` names, except those held here, whose frames keep reaching the session until
    /// their commands end.
    pub(crate) fn release_session_threads(
        &self,
        service: &CodexService,
        session_id: &SessionId,
        is_released: impl Fn(&str) -> bool,
    ) {
        let held: Vec<String> = self.lock().held.keys().cloned().collect();
        for thread_id in service.threads_of(session_id) {
            if !held.contains(&thread_id) && is_released(&thread_id) {
                service.release_thread(&thread_id);
            }
        }
    }

    /// Answers once no conversation on the service `service_id` is held here.
    pub(crate) async fn when_none_held_on(&self, service_id: CodexServiceId) {
        let mut count = {
            let mut state = self.lock();
            state.publish_count(service_id);
            state.held_counts[&service_id].subscribe()
        };
        // The sender lives in the release itself, which outlives every wait on it.
        let _ended = count.wait_for(|held| *held == 0).await;
    }

    /// Subscribes again to each conversation held on a service whose connection was opened again,
    /// since a new connection holds none of the daemon's subscriptions, before any of them is let
    /// go; each then reads its list again. A conversation that cannot be subscribed to again is
    /// reported and dropped: no client holds it, so Codex unloads it and its commands end with it.
    pub(crate) async fn resubscribe_service(self: &Arc<Self>, service: &Arc<CodexService>) {
        let held: Vec<(String, SessionId, u64)> = self
            .lock()
            .held
            .iter()
            .filter(|(_, held)| held.service_id == service.id())
            .map(|(thread_id, held)| (thread_id.clone(), held.session_id, held.generation))
            .collect();
        for (thread_id, session_id, generation) in held {
            let resumed = match service.connection() {
                Ok(connection) => connection
                    .request(
                        THREAD_RESUME_METHOD,
                        &ThreadResumeParams {
                            thread_id: thread_id.clone(),
                            exclude_turns: Some(true),
                            approval_policy: None,
                            approvals_reviewer: None,
                            base_instructions: None,
                            config: None,
                            cwd: None,
                            developer_instructions: None,
                            history: None,
                            initial_turns_page: None,
                            model: None,
                            model_provider: None,
                            path: None,
                            permissions: None,
                            personality: None,
                            runtime_workspace_roots: None,
                            sandbox: None,
                            service_tier: None,
                        },
                    )
                    .await
                    .map(drop),
                Err(error) => Err(error),
            };
            if let Err(error) = resumed {
                CodexTransportDiagnostic::ConversationResumeFailed {
                    thread_id: thread_id.clone(),
                    error: Box::new(error),
                }
                .report();
                self.drop_if_current(&thread_id, generation);
                continue;
            }
            service.register_thread(thread_id.clone(), session_id);
            self.release_once_idle(thread_id, generation).await;
        }
    }

    /// Ends the commands of each conversation a closing session still holds, as its close does
    /// for its own, then reads each list again and lets each go once it is empty.
    pub(crate) async fn forget_session(self: &Arc<Self>, session_id: &SessionId) {
        let held: Vec<(String, Weak<CodexService>, u64)> = self
            .lock()
            .held
            .iter()
            .filter(|(_, held)| held.session_id == *session_id)
            .map(|(thread_id, held)| (thread_id.clone(), held.service.clone(), held.generation))
            .collect();
        for (thread_id, service, generation) in held {
            let connection = service
                .upgrade()
                .and_then(|service| service.connection().ok());
            if let Some(connection) = connection {
                end_codex_running_commands(&connection, &thread_id, true).await;
            }
            self.release_once_idle(thread_id, generation).await;
        }
    }

    /// Forgets the conversations held on a service whose process ended, or which the daemon
    /// stopped: the commands they ran ended with it.
    pub(crate) fn forget_service(&self, service_id: CodexServiceId) {
        let dropped: Vec<(String, u64)> = self
            .lock()
            .held
            .iter()
            .filter(|(_, held)| held.service_id == service_id)
            .map(|(thread_id, held)| (thread_id.clone(), held.generation))
            .collect();
        for (thread_id, generation) in dropped {
            self.drop_if_current(&thread_id, generation);
        }
        self.lock().publish_count(service_id);
    }

    // Reads the list and lets the conversation go once it is empty. An unreadable list keeps it
    // held, reported, and its next frame reads the list again: letting it go would end a command
    // that may still run. A service no longer running counts as empty.
    async fn release_once_idle(&self, thread_id: String, generation: u64) {
        let Some(service) = self.held_service(&thread_id, generation) else {
            return;
        };
        let connection = service
            .as_ref()
            .and_then(|service| service.connection().ok());
        if let Some(connection) = &connection {
            match list_codex_running_commands(connection, &thread_id).await {
                Ok(process_ids) if !process_ids.is_empty() => return,
                Ok(_none) => {}
                Err(error) => {
                    report_step_failed(CodexTeardownStep::BackgroundTerminalList, error);
                    if let Some(held) = self.lock().held.get_mut(&thread_id)
                        && held.generation == generation
                    {
                        held.is_list_read_owed = true;
                    }
                    return;
                }
            }
        }
        // Another read, or the session's close, let it go first.
        let Some(held) = self.take_if_current(&thread_id, generation) else {
            return;
        };
        if let Some(service) = &service {
            service.release_thread(&thread_id);
            // A session whose task ended has no frames left to admit.
            let _unheard = service.push_session_item(
                &held.session_id,
                CodexSessionInbound::HeldThread {
                    thread_id: thread_id.clone(),
                    is_held: false,
                },
            );
        }
        if let Some(connection) = connection {
            let unsubscribed = connection
                .request(
                    THREAD_UNSUBSCRIBE_METHOD,
                    &ThreadUnsubscribeParams {
                        thread_id: thread_id.clone(),
                    },
                )
                .await
                .and_then(|reply| {
                    read_codex_object::<UnsubscribeReply>(reply.get())
                        .map(drop)
                        .ok_or_else(|| CodexError::Transport {
                            detail: format!(
                                "The Codex service's \"{THREAD_UNSUBSCRIBE_METHOD}\" reply is \
                                 unreadable."
                            ),
                            cause: None,
                        })
                });
            if let Err(error) = unsubscribed {
                report_step_failed(CodexTeardownStep::ThreadUnsubscribe, error);
            }
        }
        self.lock().publish_count(held.service_id);
    }

    // The service of a conversation still held under `generation`: `None` when it is not, and
    // `Some(None)` when its service is gone.
    #[expect(
        clippy::option_option,
        reason = "not held and held on a gone service are two different answers"
    )]
    fn held_service(&self, thread_id: &str, generation: u64) -> Option<Option<Arc<CodexService>>> {
        let state = self.lock();
        let held = state.held.get(thread_id)?;
        (held.generation == generation).then(|| held.service.upgrade())
    }

    fn take_if_current(&self, thread_id: &str, generation: u64) -> Option<HeldConversation> {
        let mut state = self.lock();
        if state.held.get(thread_id)?.generation != generation {
            return None;
        }
        state.held.remove(thread_id)
    }

    // Forgets a held conversation with no request to Codex, which no longer holds it for the
    // daemon.
    fn drop_if_current(&self, thread_id: &str, generation: u64) {
        let Some(held) = self.take_if_current(thread_id, generation) else {
            return;
        };
        if let Some(service) = held.service.upgrade() {
            service.release_thread(thread_id);
            // A session whose task ended has no frames left to admit.
            let _unheard = service.push_session_item(
                &held.session_id,
                CodexSessionInbound::HeldThread {
                    thread_id: thread_id.to_owned(),
                    is_held: false,
                },
            );
        }
        self.lock().publish_count(held.service_id);
    }
}

// Whether a frame may have changed what the conversation runs: a command's end, or the
// conversation going idle at a turn's end.
fn is_list_change(method: &str, params: &RawValue) -> bool {
    let is_watched =
        method == CODEX_ITEM_COMPLETED_METHOD || method == CODEX_THREAD_STATUS_CHANGED_METHOD;
    if !is_watched {
        return false;
    }
    let Some(frame) = read_codex_object::<ReleaseFrame>(params.get()) else {
        return false;
    };
    if method == CODEX_ITEM_COMPLETED_METHOD {
        return read_member_type(frame.item).as_deref() == Some(CODEX_COMMAND_ITEM_TYPE);
    }
    read_member_type(frame.status).as_deref() == Some(CODEX_IDLE_THREAD_STATUS)
}

fn report_step_failed(step: CodexTeardownStep, error: CodexError) {
    CodexTransportDiagnostic::TeardownStepFailed {
        step,
        error: Box::new(error),
    }
    .report();
}

#[cfg(test)]
mod tests;

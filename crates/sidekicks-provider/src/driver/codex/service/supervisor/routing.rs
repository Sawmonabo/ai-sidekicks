//! Where each notification a service's connection reads goes, decided on the reader in arrival
//! order: a frame naming a conversation to the session that holds it, a helper's conversation
//! registered under its parent's session first, a frame naming none to every session on the
//! service, and the frames of a conversation a session moved off only while its commands still
//! run. A frame whose conversation a start or fork in flight is about to claim is held until the
//! claim lands, within a bound.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;

use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_METHOD_PREFIX, CODEX_THREAD_STARTED_METHOD, derive_codex_child_thread_announcement,
    resolve_codex_frame_emission_route,
};
use crate::driver::codex::service::config_warnings::CodexConfigWarnings;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::threads::{CodexHeldThreadFrame, CodexThreadFrameHold};
use crate::driver::codex::session::inbound::{CodexSessionInbound, CodexSessionInboundSender};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::codex::usage_limit_signal::{
    CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD, CodexRateLimitObservation,
    observe_codex_rate_limit_update,
};
use crate::driver::diagnostics::OnceReportedDiagnostics;
use crate::thread_frame_router::ChildThreadAnnouncement;

/// Sent once a conversation is unloaded, so another service may take it.
pub(crate) const CODEX_THREAD_CLOSED_METHOD: &str = "thread/closed";

/// The service-wide config warning, which names no conversation and goes to every session.
pub(crate) const CODEX_CONFIG_WARNING_METHOD: &str = "configWarning";

/// Lifecycle broadcasts every connection sees for every conversation on the service, the person's
/// own and a throwaway title conversation among them; never a fault when no session holds it.
const CODEX_UNHELD_THREAD_BROADCASTS: [&str; 2] =
    [CODEX_THREAD_STARTED_METHOD, CODEX_THREAD_CLOSED_METHOD];

/// What one service's routing keeps beside its thread index: each session's queue, the waits on a
/// conversation's unload, the config warnings and the account's rate-limit readings.
#[derive(Default)]
pub(super) struct CodexServiceRouting {
    /// The queue of each session on the service.
    sessions: HashMap<SessionId, CodexSessionInboundSender>,
    /// The waits on each conversation's `thread/closed`.
    closed_waiters: HashMap<String, Vec<oneshot::Sender<()>>>,
    /// The config warnings the service sent, and who was told each.
    pub(super) config_warnings: CodexConfigWarnings,
    /// The account's rate-limit readings; the account outlives a connection, so a reconnect keeps
    /// them.
    pub(super) rate_limits: CodexRateLimitObservation,
    /// The out-of-table methods already reported on the current connection.
    reports: OnceReportedDiagnostics,
}

impl CodexServiceRouting {
    /// Starts a new connection's reports and config warnings: the service sends its warnings again
    /// to each connection.
    pub(super) fn start_connection(&mut self) {
        self.reports = OnceReportedDiagnostics::default();
        self.config_warnings.start_connection();
    }

    /// Sends a session's frames to `sender` from now on.
    pub(super) fn attach(&mut self, sender: CodexSessionInboundSender) {
        self.sessions.insert(sender.session_id(), sender);
    }

    /// Stops sending a session its frames and forgets the warnings it was told; answers whether it
    /// was attached.
    pub(super) fn detach(&mut self, session_id: &SessionId) -> bool {
        self.config_warnings.forget_session(session_id);
        self.sessions.remove(session_id).is_some()
    }

    /// The queue of one session, when it is attached.
    pub(super) fn session(&self, session_id: &SessionId) -> Option<&CodexSessionInboundSender> {
        self.sessions.get(session_id)
    }

    /// The queue of every session attached.
    pub(super) fn attached(&self) -> Vec<CodexSessionInboundSender> {
        self.sessions.values().cloned().collect()
    }

    /// Waits on `thread_id`'s unload.
    pub(super) fn wait_for_closed(&mut self, thread_id: String) -> oneshot::Receiver<()> {
        let (closed, receiver) = oneshot::channel();
        let waiters = self.closed_waiters.entry(thread_id).or_default();
        waiters.retain(|waiter| !waiter.is_closed());
        waiters.push(closed);
        receiver
    }

    /// Settles the waits on one conversation, or on every one when `thread_id` is `None`: the end
    /// of a connection unloads every conversation on it.
    pub(super) fn settle_closed(&mut self, thread_id: Option<&str>) {
        let waiters: Vec<oneshot::Sender<()>> = match thread_id {
            Some(thread_id) => self.closed_waiters.remove(thread_id).unwrap_or_default(),
            None => self
                .closed_waiters
                .drain()
                .flat_map(|(_, waiters)| waiters)
                .collect(),
        };
        for waiter in waiters {
            // A wait no one holds any more needs no answer.
            let _unheard = waiter.send(());
        }
    }
}

// The members of a frame's params that name its conversation: `threadId`, and `thread.id` on
// `thread/started`, each kept raw so one of another type reads as none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameConversation {
    thread_id: Option<Box<RawValue>>,
    conversation_id: Option<Box<RawValue>>,
    thread: Option<StartedThread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartedThread {
    id: Option<Box<RawValue>>,
    parent_thread_id: Option<Box<RawValue>>,
    source: Option<Box<RawValue>>,
    agent_nickname: Option<Box<RawValue>>,
    agent_role: Option<Box<RawValue>>,
}

// A thread's `source` as far as helpers go: its `subAgent` arm, where it has one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSource {
    sub_agent: Option<SubAgentSource>,
}

// The arms of `source.subAgent` this release names; an arm a newer Codex adds reads as no source.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubAgentSource {
    Review,
    Compact,
    ThreadSpawn { agent_path: Option<Value> },
    MemoryConsolidation,
    Other(IgnoredAny),
}

// A helper thread's source: the path in Codex's tree of helpers, which only a spawned one has.
struct HelperSource {
    agent_path: Option<String>,
}

// The helper a thread's `source` makes it, whose spend is its own: a review, a spawned helper,
// with its path, or another Codex names. A compaction or a memory consolidation is Codex's
// housekeeping for the parent, whose spend stays the parent run's, as is an arm a newer Codex adds
// or a thread with no source.
fn read_helper_source(source: Option<&RawValue>) -> Option<HelperSource> {
    let sub_agent = crate::driver::codex::transport::connection::read_codex_object::<ThreadSource>(
        source?.get(),
    )?
    .sub_agent?;
    match sub_agent {
        SubAgentSource::Review | SubAgentSource::Other(_) => {
            Some(HelperSource { agent_path: None })
        }
        SubAgentSource::ThreadSpawn { agent_path } => Some(HelperSource {
            agent_path: agent_path
                .as_ref()
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(str::to_owned),
        }),
        SubAgentSource::Compact | SubAgentSource::MemoryConsolidation => None,
    }
}

// A raw member read as non-empty text.
fn read_text(raw: Option<&RawValue>) -> Option<String> {
    raw.and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
        .filter(|text| !text.is_empty())
}

fn read_frame_conversation(params: &RawValue) -> Option<FrameConversation> {
    crate::driver::codex::transport::connection::read_codex_object(params.get())
}

/// The conversation a frame names: `thread.id` on `thread/started`, `threadId` otherwise; `None`
/// when it names none as non-empty text.
pub(crate) fn read_codex_frame_thread_id(method: &str, params: &RawValue) -> Option<String> {
    let conversation = read_frame_conversation(params)?;
    if method == CODEX_THREAD_STARTED_METHOD {
        return read_text(conversation.thread?.id.as_deref());
    }
    read_text(conversation.thread_id.as_deref())
}

/// The conversation an ask names: its `threadId`, or an older approval's `conversationId`.
pub(crate) fn read_codex_ask_thread_id(params: &RawValue) -> Option<String> {
    let conversation = read_frame_conversation(params)?;
    read_text(conversation.thread_id.as_deref())
        .or_else(|| read_text(conversation.conversation_id.as_deref()))
}

/// The helper conversation a `thread/started` announces, with the parent it declares; `None` when
/// it names no parent, as the session's own conversation starting does.
pub(crate) fn read_codex_child_thread_announcement(
    params: &RawValue,
) -> Option<ChildThreadAnnouncement> {
    let thread = read_frame_conversation(params)?.thread?;
    let thread_id = read_text(thread.id.as_deref())?;
    let parent_thread_id = read_text(thread.parent_thread_id.as_deref())?;
    let is_subagent = read_helper_source(thread.source.as_deref()).is_some();
    Some(derive_codex_child_thread_announcement(
        thread_id,
        Some(parent_thread_id),
        is_subagent,
    ))
}

/// The names Codex gives a helper on its `thread/started`, each `None` where Codex gives none or
/// one the contract refuses.
pub(crate) struct CodexHelperNames {
    /// Its nickname, `agentNickname`.
    pub(crate) name: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The role it was started in, `agentRole`.
    pub(crate) role: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// Its path in Codex's tree of helpers, a spawned helper's `agent_path`.
    pub(crate) provider_path: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
}

/// The names a `thread/started`'s params give the helper it announces: its nickname, its role
/// and, for a spawned helper, its path. A blank value, one holding NUL or one over the cap reads as
/// none.
pub(crate) fn read_codex_helper_names(params: &RawValue) -> CodexHelperNames {
    let thread = read_frame_conversation(params).and_then(|conversation| conversation.thread);
    let thread = thread.as_ref();
    let provider_path = thread
        .and_then(|thread| read_helper_source(thread.source.as_deref()))
        .and_then(|source| source.agent_path);
    CodexHelperNames {
        name: read_handle(thread.and_then(|thread| read_text(thread.agent_nickname.as_deref()))),
        role: read_handle(thread.and_then(|thread| read_text(thread.agent_role.as_deref()))),
        provider_path: read_handle(provider_path),
    }
}

// A name as the contract holds it; one it refuses reads as none, never cut.
fn read_handle(text: Option<String>) -> Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>> {
    text.and_then(|text| FreeFormText::new(text).ok())
}

/// Whether a frame belongs to one session or every session on the service.
enum FrameAudience {
    /// The sessions the routing found.
    Sessions(Vec<SessionId>),
    /// No session.
    Nobody,
}

impl CodexService {
    /// Routes one notification the connection `dial` read: called on its reader, so every
    /// decision here is made in arrival order and nothing awaits.
    pub(super) fn route(self: &Arc<Self>, dial: u64, method: &str, params: Box<RawValue>) {
        if !self.is_routed_dial(dial) {
            return;
        }
        let thread_id = read_codex_frame_thread_id(method, &params);
        let (audience, has_rate_limits_changed) = {
            let mut routing = self.lock_routing();
            let rate_limits_before = (method == CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD)
                .then(|| routing.rate_limits.clone());
            // Only reported here, once per connection, when the method is outside the table; the
            // session's frame handler reads the route itself.
            let _route = resolve_codex_frame_emission_route(
                method,
                self.home().provider_account_id().cloned(),
                &mut routing.reports,
            );
            if method == CODEX_THREAD_CLOSED_METHOD
                && let Some(thread_id) = &thread_id
            {
                routing.settle_closed(Some(thread_id));
            }
            let audience = match &thread_id {
                None => self.route_unthreaded(&mut routing, method, &params),
                Some(_) => FrameAudience::Nobody,
            };
            let has_rate_limits_changed =
                rate_limits_before.is_some_and(|before| before != routing.rate_limits);
            (audience, has_rate_limits_changed)
        };
        if has_rate_limits_changed {
            self.dependencies.events.rate_limits_observed(self);
        }
        // Codex sends every client each unload, so a conversation of the person's ending in their
        // terminal may leave a joined service free.
        if method == CODEX_THREAD_CLOSED_METHOD {
            self.last_conversation_closed();
        }
        if let FrameAudience::Sessions(sessions) = audience {
            for session_id in sessions {
                self.deliver(&session_id, method, &params);
            }
            return;
        }
        let Some(thread_id) = thread_id else {
            return;
        };
        self.register_announced_child(&thread_id, &params);
        let session_id = self.lock_threads().session_for(&thread_id).copied();
        if let Some(session_id) = session_id {
            self.deliver_thread_frame(&session_id, &thread_id, method, params);
            return;
        }
        let held = self.lock_threads().hold(CodexHeldThreadFrame {
            method: method.to_owned(),
            params,
            thread_id,
        });
        match held {
            CodexThreadFrameHold::Held => {}
            CodexThreadFrameHold::NotHeld(frame) => {
                if !CODEX_UNHELD_THREAD_BROADCASTS.contains(&frame.method.as_str()) {
                    CodexTransportDiagnostic::UnroutedThreadFrame {
                        method: frame.method,
                        thread_id: frame.thread_id,
                    }
                    .report();
                }
            }
            CodexThreadFrameHold::PushedOut(frame) => {
                CodexTransportDiagnostic::PendingThreadFrameDropped {
                    method: frame.method,
                    thread_id: frame.thread_id,
                }
                .report();
            }
        }
    }

    // A frame naming no conversation: a config warning to the sessions not told it yet, a rate
    // limit read into the account's readings, and every frame to every session on the service.
    fn route_unthreaded(
        &self,
        routing: &mut CodexServiceRouting,
        method: &str,
        params: &RawValue,
    ) -> FrameAudience {
        let sessions = self.lock_threads().sessions();
        if method == CODEX_CONFIG_WARNING_METHOD {
            // Only the sessions not told it already, so a reconnect repeats nothing.
            return FrameAudience::Sessions(
                routing
                    .config_warnings
                    .record_warning(params.to_owned(), &sessions),
            );
        }
        if method == CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD {
            match serde_json::from_str::<Value>(params.get()) {
                Ok(update) => {
                    routing.rate_limits =
                        observe_codex_rate_limit_update(routing.rate_limits.clone(), &update);
                }
                Err(_unreadable) => return FrameAudience::Nobody,
            }
        }
        FrameAudience::Sessions(sessions)
    }

    // A helper's conversation belongs to the session its parent's does.
    fn register_announced_child(&self, thread_id: &str, params: &RawValue) {
        if self.lock_threads().session_for(thread_id).is_some() {
            return;
        }
        let Some(parent_thread_id) = read_codex_child_thread_announcement(params)
            .and_then(|announcement| announcement.declared_parent_thread_id)
        else {
            return;
        };
        let parent_session_id = self.lock_threads().session_for(&parent_thread_id).copied();
        if let Some(parent_session_id) = parent_session_id {
            self.register_thread(thread_id.to_owned(), parent_session_id);
        }
    }

    // A frame of a conversation a session holds. One the session moved off reaches it only
    // through the rows of the commands it still runs.
    pub(super) fn deliver_thread_frame(
        &self,
        session_id: &SessionId,
        thread_id: &str,
        method: &str,
        params: Box<RawValue>,
    ) {
        let is_moved_off =
            self.dependencies()
                .release
                .observe_frame(self.id(), thread_id, method, &params);
        if is_moved_off && !method.starts_with(CODEX_ITEM_METHOD_PREFIX) {
            return;
        }
        self.push_frame(session_id, method.to_owned(), params);
    }

    // A frame naming no conversation, copied to one session.
    fn deliver(&self, session_id: &SessionId, method: &str, params: &RawValue) {
        self.push_frame(session_id, method.to_owned(), params.to_owned());
    }

    fn push_frame(&self, session_id: &SessionId, method: String, params: Box<RawValue>) {
        let routing = self.lock_routing();
        let Some(session) = routing.session(session_id) else {
            return;
        };
        if !session.push(CodexSessionInbound::Frame { method, params }) {
            tracing::debug!(
                session_id = %session_id,
                "a Codex frame reached a session whose task has ended"
            );
        }
    }
}

//! Where each notification a service's connection reads goes, decided on the reader in arrival
//! order: a frame naming a conversation to the session that holds it, the helpers a spawn item
//! names registered under its parent's session first, a frame naming none to every session on the
//! service, and the frames of a conversation a session moved off only while its commands still
//! run. A frame naming a conversation not registered yet, a start's or a fork's in flight or a
//! spawned helper's ahead of its spawn item, is held until it is, within a bound and a timeout.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_ITEM_METHOD_PREFIX, CODEX_ITEM_STARTED_METHOD,
    CODEX_THREAD_STARTED_METHOD, resolve_codex_frame_emission_route,
};
use crate::driver::codex::service::config_warnings::CodexConfigWarnings;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::rate_limit_readings::CodexRateLimitReadings;
use crate::driver::codex::service::threads::{CodexHeldThreadFrame, CodexServiceThreads};
use crate::driver::codex::session::inbound::{CodexSessionInbound, CodexSessionInboundSender};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::codex::usage_limit_signal::CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD;
use crate::driver::diagnostics::OnceReportedDiagnostics;

/// Sent once a conversation is unloaded, so another service may take it.
pub(crate) const CODEX_THREAD_CLOSED_METHOD: &str = "thread/closed";

/// The service-wide config warning, which names no conversation and goes to every session.
pub(crate) const CODEX_CONFIG_WARNING_METHOD: &str = "configWarning";

/// The item Codex's v2 helper tools put on the parent's turn at each step of a helper's life.
pub(crate) const CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE: &str = "subAgentActivity";

/// The `subAgentActivity` kind that announces a spawned helper; `interacted`, `interrupted` and
/// `completed` follow it.
pub(crate) const CODEX_SPAWNED_ACTIVITY_KIND: &str = "started";

/// The item of a call to one of Codex's v1 helper tools.
pub(crate) const CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE: &str = "collabAgentToolCall";

/// The v1 helper tool that spawns a helper.
pub(crate) const CODEX_SPAWN_AGENT_TOOL: &str = "spawnAgent";

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
    /// The account's rate-limit readings.
    pub(super) rate_limits: CodexRateLimitReadings,
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

// The members of a frame's params the routing reads: those naming its conversation, `threadId`,
// and `thread.id` on `thread/started`, and an item frame's `item`, each kept raw so one of another
// type reads as none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameConversation {
    thread_id: Option<Box<RawValue>>,
    conversation_id: Option<Box<RawValue>>,
    thread: Option<StartedThread>,
    item: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct StartedThread {
    id: Option<Box<RawValue>>,
}

// The members of an item that say whether it spawned a helper, and which: v2's `subAgentActivity`
// of kind `started` names one by `agentThreadId`, v1's `collabAgentToolCall` `spawnAgent` names
// each by `receiverThreadIds` once it completes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnItem {
    #[serde(rename = "type")]
    item_type: Option<Box<RawValue>>,
    id: Option<Box<RawValue>>,
    kind: Option<Box<RawValue>>,
    tool: Option<Box<RawValue>>,
    agent_thread_id: Option<Box<RawValue>>,
    agent_path: Option<Box<RawValue>>,
    receiver_thread_ids: Option<Box<RawValue>>,
    model: Option<Box<RawValue>>,
    reasoning_effort: Option<Box<RawValue>>,
}

/// A helper Codex spawned, as the spawn item on its parent's turn names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSpawnedHelper {
    /// The helper's own conversation.
    pub(crate) thread_id: String,
    /// The spawn call that started it, the item's `id`.
    pub(crate) call_id: Option<String>,
    /// Its path in Codex's tree of helpers, v2's `agentPath`.
    pub(crate) provider_path: Option<String>,
    /// The model it runs on, the item's `model`.
    pub(crate) model: Option<String>,
    /// The effort it runs at, the item's `reasoningEffort`.
    pub(crate) reasoning_effort: Option<String>,
}

/// The conversation a frame names and the helpers its spawn item names, read in one parse.
pub(crate) struct CodexFrameThreads {
    /// The conversation the frame names, `None` when it names none as non-empty text.
    pub(crate) thread_id: Option<String>,
    /// The helpers a spawn item names: one for v2's `subAgentActivity` of kind `started` on
    /// `item/started` or `item/completed`, one per receiver for v1's completed `spawnAgent`.
    pub(crate) spawned_helpers: Vec<CodexSpawnedHelper>,
}

// A raw member read as non-empty text.
fn read_text(raw: Option<&RawValue>) -> Option<String> {
    raw.and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
        .filter(|text| !text.is_empty())
}

fn read_frame_conversation(params: &RawValue) -> Option<FrameConversation> {
    crate::driver::codex::transport::connection::read_codex_object(params.get())
}

// The conversation a read frame names.
fn frame_thread_id(method: &str, conversation: FrameConversation) -> Option<String> {
    if method == CODEX_THREAD_STARTED_METHOD {
        return read_text(conversation.thread?.id.as_deref());
    }
    read_text(conversation.thread_id.as_deref())
}

/// The conversation a frame names: `thread.id` on `thread/started`, `threadId` otherwise; `None`
/// when it names none as non-empty text.
pub(crate) fn read_codex_frame_thread_id(method: &str, params: &RawValue) -> Option<String> {
    frame_thread_id(method, read_frame_conversation(params)?)
}

/// The conversation an ask names: its `threadId`, or an older approval's `conversationId`.
pub(crate) fn read_codex_ask_thread_id(params: &RawValue) -> Option<String> {
    let conversation = read_frame_conversation(params)?;
    read_text(conversation.thread_id.as_deref())
        .or_else(|| read_text(conversation.conversation_id.as_deref()))
}

/// The conversation a frame names and the helpers its spawn item names; the item is read only on
/// `item/started` and `item/completed`.
pub(crate) fn read_codex_frame_threads(method: &str, params: &RawValue) -> CodexFrameThreads {
    let Some(mut conversation) = read_frame_conversation(params) else {
        return CodexFrameThreads {
            thread_id: None,
            spawned_helpers: Vec::new(),
        };
    };
    let item = conversation.item.take();
    let spawned_helpers = match item {
        Some(item)
            if method == CODEX_ITEM_STARTED_METHOD || method == CODEX_ITEM_COMPLETED_METHOD =>
        {
            read_spawned_helpers(method == CODEX_ITEM_COMPLETED_METHOD, &item)
        }
        Some(_) | None => Vec::new(),
    };
    CodexFrameThreads {
        thread_id: frame_thread_id(method, conversation),
        spawned_helpers,
    }
}

// The helpers a spawn item names; `is_completed` when it rides `item/completed`, the only frame
// v1's names its receivers on. Any other item names none.
fn read_spawned_helpers(is_completed: bool, item: &RawValue) -> Vec<CodexSpawnedHelper> {
    let Some(item) =
        crate::driver::codex::transport::connection::read_codex_object::<SpawnItem>(item.get())
    else {
        return Vec::new();
    };
    let call_id = read_text(item.id.as_deref());
    let model = read_text(item.model.as_deref()).filter(|model| !model.trim().is_empty());
    let reasoning_effort =
        read_text(item.reasoning_effort.as_deref()).filter(|effort| !effort.trim().is_empty());
    match read_text(item.item_type.as_deref()).as_deref() {
        Some(CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE)
            if read_text(item.kind.as_deref()).as_deref() == Some(CODEX_SPAWNED_ACTIVITY_KIND) =>
        {
            read_text(item.agent_thread_id.as_deref())
                .map(|thread_id| CodexSpawnedHelper {
                    thread_id,
                    call_id,
                    provider_path: read_text(item.agent_path.as_deref()),
                    model,
                    reasoning_effort,
                })
                .into_iter()
                .collect()
        }
        Some(CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE)
            if is_completed
                && read_text(item.tool.as_deref()).as_deref() == Some(CODEX_SPAWN_AGENT_TOOL) =>
        {
            let receivers = item
                .receiver_thread_ids
                .and_then(|ids| serde_json::from_str::<Vec<Box<RawValue>>>(ids.get()).ok())
                .unwrap_or_default();
            receivers
                .iter()
                .filter_map(|receiver| read_text(Some(receiver)))
                .map(|thread_id| CodexSpawnedHelper {
                    thread_id,
                    call_id: call_id.clone(),
                    provider_path: None,
                    model: model.clone(),
                    reasoning_effort: reasoning_effort.clone(),
                })
                .collect()
        }
        Some(_) | None => Vec::new(),
    }
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
    /// decision here is made in arrival order and nothing awaits. Each one first reports the held
    /// frames past their timeout.
    pub(super) fn route(self: &Arc<Self>, dial: u64, method: &str, params: Box<RawValue>) {
        if !self.is_routed_dial(dial) {
            return;
        }
        let now = Instant::now();
        CodexServiceThreads::report_expired(&self.threads, now);
        let CodexFrameThreads {
            thread_id,
            spawned_helpers,
        } = read_codex_frame_threads(method, &params);
        let (audience, has_rate_limits_changed) = {
            let mut routing = self.lock_routing();
            // Only reported here, once per connection, when the method is outside the table; the
            // session's frame handler reads the route itself.
            let _route = resolve_codex_frame_emission_route(
                method,
                self.provider_account_id(),
                &mut routing.reports,
            );
            if method == CODEX_THREAD_CLOSED_METHOD
                && let Some(thread_id) = &thread_id
            {
                routing.settle_closed(Some(thread_id));
            }
            match &thread_id {
                None => self.route_unthreaded(&mut routing, method, &params),
                Some(_) => (FrameAudience::Nobody, false),
            }
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
        let session_id = self.lock_threads().session_for(&thread_id).copied();
        if let Some(session_id) = session_id {
            self.register_spawned_helpers(session_id, spawned_helpers);
            self.deliver_thread_frame(&session_id, &thread_id, method, params);
            return;
        }
        let pushed_out = self.lock_threads().hold(
            CodexHeldThreadFrame {
                method: method.to_owned(),
                params,
                thread_id,
            },
            now,
        );
        if let Some(frame) = pushed_out {
            CodexTransportDiagnostic::PendingThreadFrameDropped {
                method: frame.method,
                thread_id: frame.thread_id,
            }
            .report();
        }
    }

    // A frame naming no conversation: a config warning to the sessions not told it yet, a rate
    // limit read into the account's readings, and every frame to every session on the service;
    // answers whether the readings changed.
    fn route_unthreaded(
        &self,
        routing: &mut CodexServiceRouting,
        method: &str,
        params: &RawValue,
    ) -> (FrameAudience, bool) {
        let sessions = self.lock_threads().sessions();
        if method == CODEX_CONFIG_WARNING_METHOD {
            // Only the sessions not told it already, so a reconnect repeats nothing.
            return (
                FrameAudience::Sessions(
                    routing
                        .config_warnings
                        .record_warning(params.to_owned(), &sessions),
                ),
                false,
            );
        }
        let mut has_rate_limits_changed = false;
        if method == CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD {
            match serde_json::from_str::<Value>(params.get()) {
                Ok(update) => has_rate_limits_changed = routing.rate_limits.merge_update(&update),
                Err(_unreadable) => return (FrameAudience::Nobody, false),
            }
        }
        (FrameAudience::Sessions(sessions), has_rate_limits_changed)
    }

    // A spawned helper's conversation belongs to the session of the parent whose turn spawned it,
    // registered before the spawn item itself is delivered; one already registered, as v2's second
    // item finds it, stays as it is.
    fn register_spawned_helpers(
        &self,
        session_id: SessionId,
        spawned_helpers: Vec<CodexSpawnedHelper>,
    ) {
        for helper in spawned_helpers {
            let is_registered = self.lock_threads().session_for(&helper.thread_id).is_some();
            if !is_registered {
                self.register_thread(helper.thread_id, session_id);
            }
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

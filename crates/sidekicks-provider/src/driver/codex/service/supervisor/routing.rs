//! Where each notification a service's connection reads goes, decided on the reader in arrival
//! order: a frame naming a conversation to the session that holds it, the helpers a spawn item
//! names registered under its parent's session first, a frame naming none to every session on the
//! service, and the frames of a conversation a session moved off only while its commands still
//! run. A frame naming a conversation not registered yet, a start's or a fork's in flight or a
//! spawned helper's ahead of its spawn item, is held until it is, within a frame count, a byte
//! bound and a timeout.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::codex::delivery::rows::{
    CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE, CODEX_SPAWN_AGENT_TOOL, CODEX_SPAWNED_ACTIVITY_KIND,
    CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE,
};
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_ITEM_METHOD_PREFIX, CODEX_ITEM_STARTED_METHOD,
    CODEX_THREAD_STARTED_METHOD, resolve_codex_frame_emission_route,
};
use crate::driver::codex::service::config_warnings::CodexConfigWarnings;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::rate_limit_readings::CodexRateLimitReadings;
use crate::driver::codex::service::threads::{CodexHeldThreadFrame, CodexThreadFrameRoute};
use crate::driver::codex::session::inbound::{CodexSessionInbound, CodexSessionInboundSender};
use crate::driver::codex::transport::connection::read_codex_given_text;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::codex::usage_limit_signal::CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD;
use crate::driver::diagnostics::OnceReportedDiagnostics;

/// Sent once a conversation is unloaded, so another service may take it.
pub(crate) const CODEX_THREAD_CLOSED_METHOD: &str = "thread/closed";

/// The service-wide config warning, which names no conversation and goes to every session.
pub(crate) const CODEX_CONFIG_WARNING_METHOD: &str = "configWarning";

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
    /// The conversation the frame names, `None` when it names none as non-blank text.
    pub(crate) thread_id: Option<String>,
    /// The helpers a spawn item names: one for v2's `subAgentActivity` of kind `started` on
    /// `item/started` or `item/completed`, one per receiver for v1's completed `spawnAgent`.
    pub(crate) spawned_helpers: Vec<CodexSpawnedHelper>,
}

fn read_frame_conversation(params: &RawValue) -> Option<FrameConversation> {
    crate::driver::codex::transport::connection::read_codex_object(params.get())
}

// The conversation a read frame names.
fn frame_thread_id(method: &str, conversation: FrameConversation) -> Option<String> {
    if method == CODEX_THREAD_STARTED_METHOD {
        return conversation
            .thread?
            .id
            .as_deref()
            .and_then(read_codex_given_text);
    }
    conversation
        .thread_id
        .as_deref()
        .and_then(read_codex_given_text)
}

/// The conversation a frame names: `thread.id` on `thread/started`, `threadId` otherwise; `None`
/// when it names none as non-empty text.
pub(crate) fn read_codex_frame_thread_id(method: &str, params: &RawValue) -> Option<String> {
    frame_thread_id(method, read_frame_conversation(params)?)
}

/// The conversation an ask names: its `threadId`, or an older approval's `conversationId`.
pub(crate) fn read_codex_ask_thread_id(params: &RawValue) -> Option<String> {
    let conversation = read_frame_conversation(params)?;
    conversation
        .thread_id
        .as_deref()
        .and_then(read_codex_given_text)
        .or_else(|| {
            conversation
                .conversation_id
                .as_deref()
                .and_then(read_codex_given_text)
        })
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
    let call_id = item.id.as_deref().and_then(read_codex_given_text);
    let model = item.model.as_deref().and_then(read_codex_given_text);
    let reasoning_effort = item
        .reasoning_effort
        .as_deref()
        .and_then(read_codex_given_text);
    match item
        .item_type
        .as_deref()
        .and_then(read_codex_given_text)
        .as_deref()
    {
        Some(CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE)
            if item
                .kind
                .as_deref()
                .and_then(read_codex_given_text)
                .as_deref()
                == Some(CODEX_SPAWNED_ACTIVITY_KIND) =>
        {
            item.agent_thread_id
                .as_deref()
                .and_then(read_codex_given_text)
                .map(|thread_id| CodexSpawnedHelper {
                    thread_id,
                    call_id,
                    provider_path: item.agent_path.as_deref().and_then(read_codex_given_text),
                    model,
                    reasoning_effort,
                })
                .into_iter()
                .collect()
        }
        Some(CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE)
            if is_completed
                && item
                    .tool
                    .as_deref()
                    .and_then(read_codex_given_text)
                    .as_deref()
                    == Some(CODEX_SPAWN_AGENT_TOOL) =>
        {
            let receivers = item
                .receiver_thread_ids
                .and_then(|ids| serde_json::from_str::<Vec<Box<RawValue>>>(ids.get()).ok())
                .unwrap_or_default();
            receivers
                .iter()
                .filter_map(|receiver| read_codex_given_text(receiver))
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
    /// The session holding `thread_id` on this service, `None` where none does.
    pub(crate) fn session_of_thread(&self, thread_id: &str) -> Option<SessionId> {
        self.lock_threads().session_for(thread_id).copied()
    }

    /// The session `thread_id` was bound to when this service released it; `None` for a thread
    /// the service holds now, never held or forgot.
    pub(crate) fn former_session_of_thread(&self, thread_id: &str) -> Option<SessionId> {
        self.lock_threads().former_session_for(thread_id)
    }

    /// Routes one notification the connection `dial` read: called on its reader, so every
    /// decision here is made in arrival order and nothing awaits.
    pub(super) fn route(self: &Arc<Self>, dial: u64, method: &str, params: Box<RawValue>) {
        if !self.is_routed_dial(dial) {
            return;
        }
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
        let frame = CodexHeldThreadFrame {
            method: method.to_owned(),
            params,
            thread_id,
        };
        // Looked up and queued under the routing lock, which a let-go holds while it forgets the
        // conversation and tells its session, so no frame looked up first is queued after.
        let routing = self.lock_routing();
        let route = self.lock_threads().route_or_hold(frame, Instant::now());
        let pushed_out = match route {
            CodexThreadFrameRoute::Session(session_id, frame) => {
                self.register_spawned_helpers(&routing, session_id, spawned_helpers);
                self.deliver_thread_frame(
                    &routing,
                    &session_id,
                    &frame.thread_id,
                    method,
                    frame.params,
                );
                return;
            }
            CodexThreadFrameRoute::Held(pushed_out) => pushed_out,
        };
        drop(routing);
        for frame in pushed_out {
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
        routing: &CodexServiceRouting,
        session_id: SessionId,
        spawned_helpers: Vec<CodexSpawnedHelper>,
    ) {
        for helper in spawned_helpers {
            let is_registered = self.lock_threads().session_for(&helper.thread_id).is_some();
            if !is_registered {
                self.register_routed_thread(routing, helper.thread_id, session_id);
            }
        }
    }

    /// Records a conversation as a session's and queues the frames held for it, in order, under
    /// the caller's `routing` lock, so no frame the reader routes meanwhile comes between them.
    pub(super) fn register_routed_thread(
        &self,
        routing: &CodexServiceRouting,
        thread_id: String,
        session_id: SessionId,
    ) {
        let held = self.lock_threads().register(thread_id, session_id);
        for frame in held {
            self.deliver_thread_frame(
                routing,
                &session_id,
                &frame.thread_id,
                &frame.method,
                frame.params,
            );
        }
    }

    /// Queues `item` for a session and records a conversation as that session's in a single step
    /// against the reader's routing, the frames held for the conversation queued after `item`, so
    /// no frame of it the reader routes meanwhile comes before `item`; answers whether an attached
    /// session's queue took it.
    pub(crate) fn register_thread_and_queue(
        &self,
        thread_id: String,
        session_id: SessionId,
        item: CodexSessionInbound,
    ) -> bool {
        let routing = self.lock_routing();
        let is_queued = routing
            .session(&session_id)
            .is_some_and(|session| session.push(item));
        self.register_routed_thread(&routing, thread_id, session_id);
        is_queued
    }

    /// Forgets one conversation and queues `item` for one session in a single step against the
    /// reader's routing, so no frame of the conversation the reader looked up before the forget is
    /// queued after `item`; answers whether an attached session's queue took it.
    pub(crate) fn release_thread_and_queue(
        &self,
        thread_id: &str,
        session_id: &SessionId,
        item: CodexSessionInbound,
    ) -> bool {
        let routing = self.lock_routing();
        self.lock_threads().release(thread_id);
        routing
            .session(session_id)
            .is_some_and(|session| session.push(item))
    }

    // A frame of a conversation a session holds, queued under the caller's `routing` lock. One
    // the session moved off reaches it only through the rows of the commands it still runs.
    fn deliver_thread_frame(
        &self,
        routing: &CodexServiceRouting,
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
        push_frame(routing, session_id, method.to_owned(), params);
    }

    // A frame naming no conversation, copied to one session.
    fn deliver(&self, session_id: &SessionId, method: &str, params: &RawValue) {
        push_frame(
            &self.lock_routing(),
            session_id,
            method.to_owned(),
            params.to_owned(),
        );
    }
}

// Queues a frame for one session under `routing`, the frame dropped when the session is not
// attached.
fn push_frame(
    routing: &CodexServiceRouting,
    session_id: &SessionId,
    method: String,
    params: Box<RawValue>,
) {
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

//! The client's calls: each one's id and encoded request, the calls held behind the call cap or
//! while no link is open, the keyed calls a dropped link left to send again, and how each settles.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use serde_json::value::{RawValue, to_raw_value};
use sidekicks_contracts::daemon::lifecycle::DaemonStop;
use sidekicks_contracts::jsonrpc::framing::MessageBody;
use sidekicks_contracts::jsonrpc::message::{
    CANCEL_REQUEST_METHOD, CancelRequestParams, ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS,
    JsonRpcId, JsonRpcMessage, MAX_CALLS_IN_FLIGHT,
};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::jsonrpc::streaming::{
    SUBSCRIPTION_CANCEL_METHOD, SubscriptionCancel, SubscriptionCancelRequest, SubscriptionId,
};
use sidekicks_contracts::method::Method;
use sidekicks_contracts::terminal::TerminalWrite;
use sidekicks_contracts::wire::attachment::AttachmentError;
use tokio::sync::oneshot;

use super::{RawReply, RawRequest, typed_request};
use crate::error::{ClientError, LinkFault, RemoteError, ReplyError, RequestError};
use crate::transport::link::LinkShared;
use crate::transport::subscription::{
    OpenedSubscription, SubscriptionHandle, SubscriptionShared, probe_subscription_id,
};

/// The methods that take no call slot: the daemon answers each without waiting on another call,
/// so they go out past the cap.
const SLOTLESS_METHODS: [&str; 3] = [
    SUBSCRIPTION_CANCEL_METHOD,
    <DaemonStop as Method>::DESCRIPTOR.method,
    <TerminalWrite as Method>::DESCRIPTOR.method,
];

/// A call's key in the client's table: the id it first took, kept when a resend takes another.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CallKey(u64);

/// Where a call stands: held in the client, or in flight on one link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Held,
    InFlight { generation: u64 },
}

/// Who a call's answer goes to.
pub(crate) enum Answer {
    /// A caller waiting for the reply.
    Call(oneshot::Sender<Result<RawReply, ClientError>>),
    /// A caller waiting for a subscription's acknowledgment and stream.
    Subscribe(oneshot::Sender<Result<OpenedSubscription, ClientError>>),
    /// Nobody: the cancel a stream sends as it is dropped; a failure is logged.
    Detached,
}

impl Answer {
    /// Settles the call with `error`.
    fn fail(self, error: ClientError) {
        match self {
            Self::Call(sender) => deliver(sender, Err(error)),
            Self::Subscribe(sender) => deliver(sender, Err(error)),
            Self::Detached => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "A dropped stream's cancel failed"
            ),
        }
    }
}

/// Hands `answer` to its caller; a caller that went away is no fault.
fn deliver<T>(sender: oneshot::Sender<Result<T, ClientError>>, answer: Result<T, ClientError>) {
    if sender.send(answer).is_err() {
        tracing::debug!("A call's caller went away before its answer");
    }
}

/// One call the client holds or has in flight.
struct Call {
    method: String,
    /// Whether it counts against the call cap.
    takes_slot: bool,
    /// A keyed call's request, kept so a dropped link's call can be sent again under a new id.
    resend: Option<RawRequest>,
    /// The encoded message, until it is sent.
    message: Option<Bytes>,
    /// The id it is sent under.
    id: u64,
    phase: Phase,
    /// Whether its `$/cancelRequest` went out.
    is_cancel_sent: bool,
    answer: Answer,
}

/// Whether the client has a link: none yet or one being replaced, one open, or none coming back.
#[derive(Default)]
enum LinkStatus {
    #[default]
    Waiting,
    Open(Arc<LinkShared>),
    Down(LinkFault),
}

/// Every call and the link status, under one lock.
#[derive(Default)]
struct ClientState {
    link: LinkStatus,
    calls: HashMap<CallKey, Call>,
    /// Each in-flight call's key by the id its answer comes under.
    answers: HashMap<u64, CallKey>,
    /// Held calls in the order they go out: a dropped link's keyed calls first, then the rest.
    held: VecDeque<CallKey>,
    /// The slot-taking calls in flight on the open link.
    slots_in_use: usize,
}

impl ClientState {
    /// Sends the call `key` on `link`, encoding it again under a new id when it is a resend.
    fn send(&mut self, ids: &AtomicU64, key: CallKey, link: &Arc<LinkShared>) {
        let call = self
            .calls
            .get_mut(&key)
            .expect("a call being sent is in the table");
        let message = match call.message.take() {
            Some(message) => message,
            None => {
                let request = call
                    .resend
                    .clone()
                    .expect("a call sent again keeps its request");
                call.id = take_id(ids);
                match encode_request(call.id, request) {
                    Ok(message) => message,
                    Err(error) => {
                        if let Some(call) = self.calls.remove(&key) {
                            call.answer.fail(error);
                        }
                        return;
                    }
                }
            }
        };
        if call.takes_slot {
            self.slots_in_use += 1;
        }
        call.phase = Phase::InFlight {
            generation: link.generation(),
        };
        self.answers.insert(call.id, key);
        link.push_message(message);
    }

    /// Sends held calls from the front while slots are free; while a link is open only slot-taking
    /// calls are held.
    fn drain(&mut self, ids: &AtomicU64) {
        let LinkStatus::Open(link) = &self.link else {
            return;
        };
        let link = Arc::clone(link);
        while self.slots_in_use < MAX_CALLS_IN_FLIGHT
            && let Some(key) = self.held.pop_front()
        {
            self.send(ids, key, &link);
        }
    }

    /// Sends every held call a newly opened link can take, in order: each slotless one, and the
    /// slot-taking ones up to the cap.
    fn drain_all(&mut self, ids: &AtomicU64, link: &Arc<LinkShared>) {
        for key in std::mem::take(&mut self.held) {
            let takes_slot = self.calls.get(&key).is_some_and(|call| call.takes_slot);
            if takes_slot && self.slots_in_use >= MAX_CALLS_IN_FLIGHT {
                self.held.push_back(key);
            } else {
                self.send(ids, key, link);
            }
        }
    }

    /// Takes the calls in flight on the link `generation` off it: a keyed one not canceled is held
    /// again, ahead of every held call and in id order, and every other is answered back.
    fn take_link_calls(&mut self, generation: u64) -> Vec<Call> {
        let in_flight: Vec<CallKey> = self
            .calls
            .iter()
            .filter(|(_, call)| call.phase == Phase::InFlight { generation })
            .map(|(key, _)| *key)
            .collect();
        let mut resent = Vec::new();
        let mut failed = Vec::new();
        for key in in_flight {
            let call = self
                .calls
                .get_mut(&key)
                .expect("a call in flight is in the table");
            self.answers.remove(&call.id);
            if call.resend.is_some() && !call.is_cancel_sent {
                call.phase = Phase::Held;
                resent.push((call.id, key));
            } else if let Some(call) = self.calls.remove(&key) {
                failed.push(call);
            }
        }
        resent.sort_unstable_by_key(|(id, _)| *id);
        for (_, key) in resent.into_iter().rev() {
            self.held.push_front(key);
        }
        failed
    }
}

/// The client's shared state: every handle and the link handles hold it strongly, the link tasks
/// weakly, so the last handle's drop ends the open link and closes its socket.
#[derive(Default)]
pub(crate) struct ClientShared {
    next_id: AtomicU64,
    next_generation: AtomicU64,
    state: Mutex<ClientState>,
}

impl ClientShared {
    /// A number for a new link, never reused.
    pub(crate) fn next_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::Relaxed)
    }

    /// Registers a call now, so calls go out in the order they were made: it is sent on the open
    /// link, or on `pinned` past the cap, or held; one that cannot be written, one made while the
    /// client is down and one pinned to a link that ended settle at once.
    pub(crate) fn register(
        &self,
        request: RawRequest,
        answer: Answer,
        pinned: Option<&Arc<LinkShared>>,
    ) -> CallKey {
        let id = take_id(&self.next_id);
        let key = CallKey(id);
        let method = request.method.clone();
        let takes_slot = pinned.is_none() && !SLOTLESS_METHODS.contains(&method.as_str());
        let resend = is_keyed(request.params.as_deref()).then(|| request.clone());
        let message = match encode_request(id, request) {
            Ok(message) => message,
            Err(error) => {
                answer.fail(error);
                return key;
            }
        };
        let call = Call {
            method,
            takes_slot,
            resend,
            message: Some(message),
            id,
            phase: Phase::Held,
            is_cancel_sent: false,
            answer,
        };
        let mut guard = self.lock();
        let state = &mut *guard;
        if let Some(link) = pinned {
            // Checked under the client's lock: a link that ends after this settles the call.
            if let Some(fault) = link.fault() {
                drop(guard);
                call.answer.fail(ClientError::link_down(fault));
                return key;
            }
            state.calls.insert(key, call);
            state.send(&self.next_id, key, link);
            return key;
        }
        match &state.link {
            LinkStatus::Down(fault) => {
                let fault = fault.clone();
                drop(guard);
                call.answer.fail(ClientError::link_down(fault));
            }
            LinkStatus::Open(link)
                if !takes_slot
                    || (state.slots_in_use < MAX_CALLS_IN_FLIGHT && state.held.is_empty()) =>
            {
                let link = Arc::clone(link);
                state.calls.insert(key, call);
                state.send(&self.next_id, key, &link);
            }
            LinkStatus::Open(_) | LinkStatus::Waiting => {
                state.calls.insert(key, call);
                state.held.push_back(key);
            }
        }
        key
    }

    /// Cancels the call `key`: a held one leaves the client with nothing sent, answering true; one
    /// in flight gets its one `$/cancelRequest` and keeps waiting for its answer.
    pub(crate) fn cancel(&self, key: CallKey) -> bool {
        let mut guard = self.lock();
        let state = &mut *guard;
        let Some(call) = state.calls.get_mut(&key) else {
            return false;
        };
        match call.phase {
            Phase::Held => {
                state.calls.remove(&key);
                state.held.retain(|held| *held != key);
                true
            }
            Phase::InFlight { generation } => {
                if !call.is_cancel_sent {
                    call.is_cancel_sent = true;
                    if let LinkStatus::Open(link) = &state.link
                        && link.generation() == generation
                    {
                        send_cancel_request(link, call.id);
                    }
                }
                false
            }
        }
    }

    /// Drops the call `key` while it is still held, as its caller went away; one in flight keeps
    /// its slot until its answer.
    pub(crate) fn withdraw(&self, key: CallKey) {
        let mut guard = self.lock();
        let state = &mut *guard;
        if state
            .calls
            .get(&key)
            .is_some_and(|call| call.phase == Phase::Held)
        {
            state.calls.remove(&key);
            state.held.retain(|held| *held != key);
        }
    }

    /// Settles the call answered under `id` on `link`; a freed slot sends the next held call. A
    /// subscribe call's success admits its lane and registers its stream before the next frame is
    /// read. An answer to no call in flight is dropped.
    pub(crate) fn receive_answer(
        self: &Arc<Self>,
        link: &Arc<LinkShared>,
        id: &JsonRpcId,
        outcome: Result<RawReply, RemoteError>,
    ) {
        let number = match id {
            JsonRpcId::Number(number) => number.as_u64(),
            JsonRpcId::String(_) | JsonRpcId::Null => None,
        };
        let call = {
            let mut guard = self.lock();
            let state = &mut *guard;
            let Some(key) = number.and_then(|number| state.answers.remove(&number)) else {
                tracing::debug!("An answer under an id no call is waiting on was dropped");
                return;
            };
            let call = state
                .calls
                .remove(&key)
                .expect("an id in flight names a call");
            if call.takes_slot {
                state.slots_in_use -= 1;
                state.drain(&self.next_id);
            }
            call
        };
        match call.answer {
            Answer::Call(sender) => deliver(sender, outcome.map_err(ClientError::Remote)),
            Answer::Subscribe(sender) => {
                let opened = outcome
                    .map_err(ClientError::Remote)
                    .and_then(|acknowledgment| {
                        self.open_subscription(link, call.method, acknowledgment)
                    });
                // A caller gone by now drops the stream, which cancels it.
                deliver(sender, opened);
            }
            Answer::Detached => {
                if let Err(error) = outcome {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "A dropped stream's cancel was refused"
                    );
                }
            }
        }
    }

    /// Admits the lane a subscribe call's success opens and registers its stream by the
    /// acknowledgment's `subscriptionId`; fails where the acknowledgment carries none.
    fn open_subscription(
        self: &Arc<Self>,
        link: &Arc<LinkShared>,
        method: String,
        acknowledgment: RawReply,
    ) -> Result<OpenedSubscription, ClientError> {
        link.admit_lane();
        let subscription_id = match probe_subscription_id(&acknowledgment.json) {
            Ok(subscription_id) => subscription_id,
            Err(error) => {
                return Err(ClientError::Reply {
                    method,
                    source: ReplyError::Read(AttachmentError::Json(error)),
                });
            }
        };
        let shared = SubscriptionShared::new(method);
        link.register_subscription(subscription_id, Arc::clone(&shared));
        Ok(OpenedSubscription {
            acknowledgment,
            handle: SubscriptionHandle::new(
                subscription_id,
                shared,
                Arc::clone(link),
                Arc::downgrade(self),
            ),
        })
    }

    /// Sends a dropped stream's `$/subscription/cancel` on its link, its answer awaited by nobody.
    pub(crate) fn cancel_subscription_detached(
        &self,
        link: &Arc<LinkShared>,
        subscription_id: SubscriptionId,
    ) {
        match typed_request::<SubscriptionCancel>(&SubscriptionCancelRequest { subscription_id }) {
            Ok(request) => {
                self.register(request, Answer::Detached, Some(link));
            }
            Err(error) => Answer::Detached.fail(error),
        }
    }

    /// Ends `link` for `fault`: its keyed calls not canceled wait to be sent again on the next
    /// link, every other call on it settles `ClientError::link_down(fault)`, and the client waits
    /// for a link again. A link already ended is left as it is.
    pub(crate) fn end_link(&self, link: &Arc<LinkShared>, fault: LinkFault) {
        let Some(fault) = link.end(fault) else {
            return;
        };
        let generation = link.generation();
        let failed = {
            let mut state = self.lock();
            if matches!(&state.link, LinkStatus::Open(open) if open.generation() == generation) {
                state.link = LinkStatus::Waiting;
                state.slots_in_use = 0;
            }
            state.take_link_calls(generation)
        };
        for call in failed {
            call.answer.fail(ClientError::link_down(fault.clone()));
        }
    }

    /// Makes `link` the client's, closing any link open before it, then sends the held calls, a
    /// dropped link's keyed calls first; fails with the link's fault where it ended meanwhile.
    pub(crate) fn install(&self, link: &Arc<LinkShared>) -> Result<(), ClientError> {
        if let Some(previous) = self.open_link() {
            self.end_link(&previous, LinkFault::Closed);
        }
        let mut state = self.lock();
        if let Some(fault) = link.fault() {
            return Err(ClientError::link_down(fault));
        }
        state.link = LinkStatus::Open(Arc::clone(link));
        state.slots_in_use = 0;
        state.drain_all(&self.next_id, link);
        Ok(())
    }

    /// Takes the client down for `cause`: the open link ends, every held call and every call
    /// waiting to be sent again settles `ClientError::link_down(cause)`, and so does every call
    /// made until a link opens again.
    pub(crate) fn abandon(&self, cause: LinkFault) {
        if let Some(link) = self.open_link() {
            self.end_link(&link, cause.clone());
        }
        let mut guard = self.lock();
        let state = &mut *guard;
        for key in std::mem::take(&mut state.held) {
            if let Some(call) = state.calls.remove(&key) {
                call.answer.fail(ClientError::link_down(cause.clone()));
            }
        }
        state.link = LinkStatus::Down(cause);
    }

    /// The open link, if there is one.
    pub(crate) fn open_link(&self) -> Option<Arc<LinkShared>> {
        match &self.lock().link {
            LinkStatus::Open(link) => Some(Arc::clone(link)),
            LinkStatus::Waiting | LinkStatus::Down(_) => None,
        }
    }

    fn lock(&self) -> MutexGuard<'_, ClientState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for ClientShared {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        if let LinkStatus::Open(link) = &state.link {
            link.end(LinkFault::Closed);
        }
    }
}

/// The next id: ids increase for the client's life and are never reused.
fn take_id(ids: &AtomicU64) -> u64 {
    ids.fetch_add(1, Ordering::Relaxed) + 1
}

/// The one member a keyed call's params carry at their top level.
#[derive(Deserialize)]
struct IdempotencyKeyProbe {
    #[serde(rename = "clientIdempotencyKey")]
    client_idempotency_key: Option<IgnoredAny>,
}

/// Whether `params` is an object carrying a top-level `clientIdempotencyKey`, so the call may be
/// sent again on the next link after a drop.
fn is_keyed(params: Option<&RawValue>) -> bool {
    params
        .and_then(|params| serde_json::from_str::<IdempotencyKeyProbe>(params.get()).ok())
        .is_some_and(|probe| probe.client_idempotency_key.is_some())
}

/// `request` as one frame-codec message under `id`, carrying this build's protocol version unless
/// its method is exempt; fails as `ClientError::Request` past a cap or where the JSON fails.
fn encode_request(id: u64, request: RawRequest) -> Result<Bytes, ClientError> {
    let RawRequest {
        method,
        params,
        attachments,
    } = request;
    let protocol_version = (!ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS.contains(&method.as_str()))
        .then(|| Value::String(CURRENT_PROTOCOL_VERSION.to_owned()));
    let failed_method = method.clone();
    let message = JsonRpcMessage::Request {
        id: JsonRpcId::Number(id.into()),
        method,
        params,
        protocol_version,
    };
    let encoded = message
        .to_vec()
        .map_err(RequestError::from)
        .and_then(|json| {
            MessageBody {
                json: Bytes::from(json),
                attachments,
            }
            .encode()
            .map_err(RequestError::from)
        });
    encoded.map_err(|source| ClientError::Request {
        method: failed_method,
        source,
    })
}

/// Sends `$/cancelRequest` for the call `id` on `link`; it cannot fail but in serde itself, which
/// is logged.
fn send_cancel_request(link: &LinkShared, id: u64) {
    let encoded = to_raw_value(&CancelRequestParams {
        id: JsonRpcId::Number(id.into()),
    })
    .and_then(|params| {
        JsonRpcMessage::Notification {
            method: CANCEL_REQUEST_METHOD.to_owned(),
            params: Some(params),
        }
        .to_vec()
    })
    .map_err(RequestError::from)
    .and_then(|json| {
        MessageBody {
            json: Bytes::from(json),
            attachments: Vec::new(),
        }
        .encode()
        .map_err(RequestError::from)
    });
    match encoded {
        Ok(message) => link.push_message(message),
        Err(error) => tracing::error!(
            error = &error as &(dyn Error + 'static),
            "A call's $/cancelRequest could not be written"
        ),
    }
}

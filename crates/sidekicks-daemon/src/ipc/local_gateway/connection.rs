//! One connection of the local socket: the reader, which returns each message's credit as it takes
//! it and holds every request to its gates in order (the id's bound, the envelope's
//! `protocolVersion`, a call slot, the subscription limit) before it dispatches it; the table of
//! calls a `$/cancelRequest` can reach; and the close every path ends in. At most
//! `SLOTLESS_REPLIES_MAX` replies to messages that took no slot wait unsent; past it the reader
//! takes no message, though it reads every frame. A subscription cancel, a stop or a ping takes a
//! running count, at most `MAX_CALLS_IN_FLIGHT`, and one that finds none waits, in arrival order,
//! while every other message is taken; a `terminal.write` is bounded instead by its handler's
//! per-shell window, past which it answers `terminal.write.limitReached`.
//! What a client can make a connection hold meanwhile is lane 0's window, the only lane the
//! daemon admits: a waiting message keeps its credit, and credit owed for a partial message goes
//! back only once no message waits.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::incoming::{IncomingLanes, IncomingMessage};
use sidekicks_contracts::jsonrpc::framing::{FramingError, MessageBody};
use sidekicks_contracts::jsonrpc::message::{
    CANCEL_REQUEST_METHOD, CancelRequestParams, ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS,
    JsonRpcId, JsonRpcMessage, MAX_CALLS_IN_FLIGHT, MessageError, ObservedType,
    ProtocolVersionInvalidDetails, ProtocolVersionInvalidReason,
};
use sidekicks_contracts::jsonrpc::negotiation::ProtocolVersion;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SUBSCRIPTION_CANCEL_METHOD, SubscriptionCancel};
use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
use sidekicks_contracts::method_descriptor;
use sidekicks_contracts::terminal::TerminalWrite;
use sidekicks_contracts::wire::attachment::parse_received;
use sidekicks_platforms::PinnedProcess;
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::codec::{FramedRead, FramedWrite};
use tokio_util::sync::CancellationToken;

use super::writer::{Outbox, drive_subscription, encode_message, encode_response, write_pieces};
use super::{
    CONNECTION_CLOSE_WAIT, GatewayServices, SupervisionDisconnectReason, SupervisionHooks,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::jsonrpc_error_mapping::{CallFailure, map_json_rpc_error};
use crate::ipc::registry::{
    AfterReply, DispatchError, HandlerContext, Reply, Request, TransportId,
};
use crate::ipc::stream::subscriptions::subscription_limit_reached;
use crate::mutex_lock::lock;

/// The contract of `method` the gateway's gates read: the protocol's own subscription cancel, or
/// the method a contract table declares.
fn method_contract(method: &str) -> Option<&'static MethodDescriptor> {
    if method == SUBSCRIPTION_CANCEL_METHOD {
        Some(const { &<SubscriptionCancel as Method>::DESCRIPTOR })
    } else {
        method_descriptor(method)
    }
}

/// Whether `method` takes no call slot: the daemon answers it without waiting on another call, so
/// a client sends it past the cap.
fn is_slotless(method: &str) -> bool {
    method_contract(method).is_some_and(|descriptor| !descriptor.takes_call_slot)
}

/// Whether `method` is a slotless method whose running calls are counted: every one but
/// `terminal.write`, which is bounded instead by its handler's per-shell window, past which it
/// answers [`RefusalCode::TerminalWriteLimitReached`].
fn is_counted(method: &str) -> bool {
    is_slotless(method) && method != <TerminalWrite as Method>::DESCRIPTOR.method
}

/// The most replies to messages that took no call slot lane 0 holds unsent; past it the reader
/// takes no further message until one is cut, though it still reads frames.
const SLOTLESS_REPLIES_MAX: usize = 100;

/// Serves one accepted connection until it closes, its replies and streams going out through
/// `outbox`: the reader runs here, the writer on its own task. Every close cancels every call in
/// flight, drops the connection's subscriptions and handshake state, lets the writer send what
/// lane 0 holds for at most [`CONNECTION_CLOSE_WAIT`], and reports exactly one `on_disconnect`.
pub(crate) async fn serve_connection<S>(
    stream: S,
    outbox: Arc<Outbox>,
    transport: TransportId,
    caller_process: Option<PinnedProcess>,
    services: Arc<GatewayServices>,
    stop: CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (read_half, write_half) = tokio::io::split(stream);
    let close = Arc::new(ConnectionClose::new(transport, Arc::clone(&services.hooks)));
    let mut writing = tokio::spawn(write_pieces(
        Arc::clone(&outbox),
        FramedWrite::new(write_half, FrameCodec),
        Arc::clone(&close),
    ));
    let calls = CancellationToken::new();
    let reader = ConnectionReader {
        transport,
        caller_process,
        services: Arc::clone(&services),
        outbox: Arc::clone(&outbox),
        close: Arc::clone(&close),
        calls: calls.clone(),
        call_slots: Arc::new(Semaphore::new(MAX_CALLS_IN_FLIGHT)),
        slotless_replies: Arc::new(Semaphore::new(SLOTLESS_REPLIES_MAX)),
        slotless_running: Arc::new(Semaphore::new(MAX_CALLS_IN_FLIGHT)),
        cancel_table: Arc::new(CancelTable::default()),
        incoming: IncomingLanes::default(),
        next_call: 0,
    };
    reader
        .read(FramedRead::new(read_half, FrameCodec), &stop)
        .await;

    calls.cancel();
    services.subscriptions.cleanup_transport(transport);
    services.negotiator.cleanup_transport(transport);
    outbox.close();
    match tokio::time::timeout(CONNECTION_CLOSE_WAIT, &mut writing).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::error!(
            error = &error as &(dyn Error + 'static),
            "A connection's writer ended without finishing"
        ),
        Err(_elapsed) => writing.abort(),
    }
    close.disconnect();
}

/// How a connection's close stands: open, closing for its first reason, or reported.
#[derive(Clone, Copy)]
enum CloseState {
    Open,
    Closing(SupervisionDisconnectReason),
    Disconnected,
}

/// A connection's close: the first reason wins, every error before the disconnect is reported,
/// and the disconnect is reported once.
pub(crate) struct ConnectionClose {
    transport: TransportId,
    hooks: Arc<dyn SupervisionHooks>,
    state: Mutex<CloseState>,
    /// Canceled once a close is asked for, which stops the reader.
    requested: CancellationToken,
}

impl ConnectionClose {
    fn new(transport: TransportId, hooks: Arc<dyn SupervisionHooks>) -> Self {
        Self {
            transport,
            hooks,
            state: Mutex::new(CloseState::Open),
            requested: CancellationToken::new(),
        }
    }

    /// Asks the connection to close for `reason`, unless a close was asked for already.
    pub(crate) fn end(&self, reason: SupervisionDisconnectReason) {
        let mut state = self.lock();
        if matches!(*state, CloseState::Open) {
            *state = CloseState::Closing(reason);
            self.requested.cancel();
        }
    }

    /// Reports `error` and asks the connection to close for `reason`; nothing once the disconnect
    /// was reported, so no error follows it.
    pub(crate) fn fail(&self, reason: SupervisionDisconnectReason, error: &(dyn Error + 'static)) {
        let mut state = self.lock();
        match *state {
            CloseState::Disconnected => return,
            CloseState::Open => {
                *state = CloseState::Closing(reason);
                self.requested.cancel();
            }
            CloseState::Closing(_) => {}
        }
        tracing::warn!(
            transport = self.transport.0,
            error,
            "A connection of the local socket failed"
        );
        self.hooks.on_error(self.transport, error);
    }

    /// Reports the connection's disconnect, once, with the reason its close was first asked for.
    fn disconnect(&self) {
        let mut state = self.lock();
        let reason = match *state {
            CloseState::Disconnected => return,
            CloseState::Closing(reason) => reason,
            CloseState::Open => SupervisionDisconnectReason::ServerClose,
        };
        *state = CloseState::Disconnected;
        self.hooks.on_disconnect(self.transport, reason);
    }

    fn lock(&self) -> MutexGuard<'_, CloseState> {
        lock(&self.state)
    }
}

/// Every call in flight on one connection by its request id, so `$/cancelRequest` reaches each
/// call under that id; each call leaves as it answers.
#[derive(Default)]
struct CancelTable {
    calls: Mutex<HashMap<JsonRpcId, Vec<(u64, CancellationToken)>>>,
}

impl CancelTable {
    fn insert(&self, id: JsonRpcId, call: u64, cancellation: CancellationToken) {
        self.lock()
            .entry(id)
            .or_default()
            .push((call, cancellation));
    }

    fn remove(&self, id: &JsonRpcId, call: u64) {
        let mut calls = self.lock();
        if let Some(entries) = calls.get_mut(id) {
            entries.retain(|(number, _token)| *number != call);
            if entries.is_empty() {
                calls.remove(id);
            }
        }
    }

    /// Cancels every call in flight under `id`; an unknown or answered id is ignored.
    fn cancel(&self, id: &JsonRpcId) {
        if let Some(entries) = self.lock().get(id) {
            for (_call, cancellation) in entries {
                cancellation.cancel();
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<JsonRpcId, Vec<(u64, CancellationToken)>>> {
        lock(&self.calls)
    }
}

/// The reading side of one connection and what its calls share.
struct ConnectionReader {
    transport: TransportId,
    caller_process: Option<PinnedProcess>,
    services: Arc<GatewayServices>,
    outbox: Arc<Outbox>,
    close: Arc<ConnectionClose>,
    /// Every call's cancellation is a child of this one, canceled as the connection closes.
    calls: CancellationToken,
    /// The connection's call slots, one per call in flight.
    call_slots: Arc<Semaphore>,
    /// The places of replies to messages that took no slot, held until each reply is cut.
    slotless_replies: Arc<Semaphore>,
    /// One count per counted slotless call still running, held until its reply takes its place.
    slotless_running: Arc<Semaphore>,
    cancel_table: Arc<CancelTable>,
    incoming: IncomingLanes,
    next_call: u64,
}

/// What the reader holds before it takes a message: a reply place for a refusal it answers
/// itself, and a running count for the counted request at the head of the queue.
#[derive(Default)]
struct Reserve {
    place: Option<OwnedSemaphorePermit>,
    running: Option<OwnedSemaphorePermit>,
}

/// A subscription cancel or a stop past its envelope gates, waiting for a running count with its
/// credit unreturned.
struct CountedRequest {
    lane: LaneId,
    credit_due: u32,
    id: JsonRpcId,
    request: Request,
}

impl ConnectionReader {
    /// Reads frames until the client closes, a fault, a close asked for elsewhere, or the stop.
    async fn read<S>(
        mut self,
        mut frames: FramedRead<ReadHalf<S>, FrameCodec>,
        stop: &CancellationToken,
    ) where
        S: AsyncRead + Send,
    {
        // A reply place taken before each message is taken, for a refusal the reader answers
        // itself; a message waits here, untaken, while lane 0 holds as many slotless replies as
        // it may.
        let mut reserve = Reserve::default();
        // Whole messages not yet taken. Their credit stays unreturned, so the client's credit
        // bounds them; frames, CREDIT and ABORT included, are still read meanwhile.
        let mut waiting: VecDeque<IncomingMessage> = VecDeque::new();
        // Counted requests read and waiting, in arrival order, for a running count.
        let mut counted: VecDeque<CountedRequest> = VecDeque::new();
        loop {
            loop {
                if reserve.place.is_none() {
                    match Arc::clone(&self.slotless_replies).try_acquire_owned() {
                        Ok(place) => reserve.place = Some(place),
                        Err(_no_place) => break,
                    }
                }
                if let Some(held) = counted.pop_front() {
                    let count = reserve
                        .running
                        .take()
                        .or_else(|| Arc::clone(&self.slotless_running).try_acquire_owned().ok());
                    match count {
                        Some(count) => {
                            self.take_counted(held, count, &mut reserve);
                            continue;
                        }
                        None => counted.push_front(held),
                    }
                }
                if let Some(message) = waiting.pop_front() {
                    self.take(message, &mut reserve, &mut counted);
                } else {
                    break;
                }
            }
            if waiting.is_empty() {
                for credit in self.incoming.release_owed() {
                    self.outbox.return_credit(credit.lane, credit.granted);
                }
            }
            let next = tokio::select! {
                biased;
                () = self.close.requested.cancelled() => return,
                () = stop.cancelled() => {
                    self.close.end(SupervisionDisconnectReason::ServerClose);
                    return;
                }
                acquired = Arc::clone(&self.slotless_replies).acquire_owned(),
                    if reserve.place.is_none() && !(waiting.is_empty() && counted.is_empty()) =>
                {
                    reserve.place =
                        Some(acquired.expect("the slotless replies' semaphore is never closed"));
                    continue;
                }
                acquired = Arc::clone(&self.slotless_running).acquire_owned(),
                    if reserve.running.is_none() && !counted.is_empty() =>
                {
                    reserve.running =
                        Some(acquired.expect("the slotless calls' semaphore is never closed"));
                    continue;
                }
                next = frames.next() => next,
            };
            let received = match next {
                None => {
                    self.close.end(SupervisionDisconnectReason::ClientClose);
                    return;
                }
                Some(frame) => frame.and_then(|frame| self.receive(frame, &mut waiting)),
            };
            if let Err(error) = received {
                self.fail_framing(&error);
                return;
            }
        }
    }

    /// Applies one frame; a message it completes waits to be taken.
    fn receive(
        &mut self,
        frame: Frame,
        waiting: &mut VecDeque<IncomingMessage>,
    ) -> Result<(), FramingError> {
        if let Frame::Credit { lane, granted } = frame {
            self.outbox.grant(lane, granted);
            return Ok(());
        }
        if let Some(message) = self.incoming.receive(frame)? {
            waiting.push_back(message);
        }
        Ok(())
    }

    /// A message too large is answered `connection.message.tooLarge`; every fault closes.
    fn fail_framing(&self, error: &FramingError) {
        let reason = match error {
            FramingError::MessageTooLarge {
                limit, observed, ..
            } => {
                self.reply(
                    CallFailure::MessageTooLarge {
                        limit: *limit,
                        observed: *observed,
                    },
                    JsonRpcId::Null,
                    None,
                );
                SupervisionDisconnectReason::OversizedBody
            }
            FramingError::Io(_) => SupervisionDisconnectReason::TransportError,
            FramingError::UnknownKind { .. }
            | FramingError::ReservedFlags { .. }
            | FramingError::ChunkTooLong { .. }
            | FramingError::AbortWithLength { .. }
            | FramingError::DataBeyondCredit { .. }
            | FramingError::LaneNotAdmitted { .. }
            | FramingError::TooManyLanes { .. }
            | FramingError::ControlLaneClosed
            | FramingError::LengthPastEnd => SupervisionDisconnectReason::MalformedFrame,
        };
        self.close.fail(reason, error);
    }

    /// Takes one whole message and reads it: a counted request that passes its envelope gates waits
    /// for a running count with its credit unreturned; any other message's credit goes back at
    /// once, a refused one's too, and it is answered or dispatched.
    fn take(
        &mut self,
        message: IncomingMessage,
        reserve: &mut Reserve,
        counted: &mut VecDeque<CountedRequest>,
    ) {
        let IncomingMessage {
            lane,
            body,
            credit_due,
        } = message;
        let MessageBody { json, attachments } = body;
        let parsed = match JsonRpcMessage::from_slice(&json) {
            Ok(JsonRpcMessage::Request {
                id,
                method,
                params,
                protocol_version,
            }) if is_counted(&method) => {
                match envelope_refusal(&id, &method, protocol_version.as_ref()) {
                    Some((failure, reply_id)) => {
                        self.return_credit(lane, credit_due);
                        self.reply(failure, reply_id, reserve.place.take());
                    }
                    None => counted.push_back(CountedRequest {
                        lane,
                        credit_due,
                        id,
                        request: Request {
                            method,
                            params,
                            attachments,
                        },
                    }),
                }
                return;
            }
            parsed => parsed,
        };
        self.return_credit(lane, credit_due);
        match parsed {
            Err(error) => self.reply(
                CallFailure::Message(error),
                JsonRpcId::Null,
                reserve.place.take(),
            ),
            Ok(JsonRpcMessage::Request {
                id,
                method,
                params,
                protocol_version,
            }) => self.admit(
                id,
                Request {
                    method,
                    params,
                    attachments,
                },
                protocol_version.as_ref(),
                reserve,
            ),
            Ok(JsonRpcMessage::Notification { method, params }) => {
                self.notice(&method, params.as_deref(), attachments);
            }
            // A client sends no response: refused under its id when that id may be echoed.
            Ok(JsonRpcMessage::Response { id, .. } | JsonRpcMessage::ErrorResponse { id, .. }) => {
                let id = if is_within_bound(&id) {
                    id
                } else {
                    JsonRpcId::Null
                };
                self.reply(
                    CallFailure::Message(MessageError::NotAMessage),
                    id,
                    reserve.place.take(),
                );
            }
        }
    }

    /// Dispatches a counted request with the running count it waited for; its credit goes back now.
    fn take_counted(
        &mut self,
        held: CountedRequest,
        count: OwnedSemaphorePermit,
        reserve: &mut Reserve,
    ) {
        let CountedRequest {
            lane,
            credit_due,
            id,
            request,
        } = held;
        self.return_credit(lane, credit_due);
        self.dispatch_call(id, request, reserve, Some(count));
    }

    /// Returns a taken message's credit to the client.
    fn return_credit(&mut self, lane: LaneId, credit_due: u32) {
        if let Some(credit) = self.incoming.take(lane, credit_due) {
            self.outbox.return_credit(credit.lane, credit.granted);
        }
    }

    /// Holds a request to its envelope gates, then dispatches it.
    fn admit(
        &mut self,
        id: JsonRpcId,
        request: Request,
        protocol_version: Option<&Value>,
        reserve: &mut Reserve,
    ) {
        if let Some((failure, reply_id)) = envelope_refusal(&id, &request.method, protocol_version)
        {
            self.reply(failure, reply_id, reserve.place.take());
            return;
        }
        self.dispatch_call(id, request, reserve, None);
    }

    /// Holds a request past its envelope gates to its call slot and the subscription limit, then
    /// dispatches it before the next message is taken, so an order-bound method's admit step runs
    /// in arrival order; its answer runs on its own task.
    fn dispatch_call(
        &mut self,
        id: JsonRpcId,
        request: Request,
        reserve: &mut Reserve,
        running: Option<OwnedSemaphorePermit>,
    ) {
        // A slotless method's reply takes its place once it is ready, so a call still running
        // holds at most its running count.
        let permit = if is_slotless(&request.method) {
            None
        } else if let Ok(slot) = Arc::clone(&self.call_slots).try_acquire_owned() {
            Some(slot)
        } else {
            let refusal = DomainError::new(
                "The connection holds as many calls in flight as it may",
                RefusalCode::ConnectionCallLimitReached,
            )
            .with_detail(json!({ "limit": MAX_CALLS_IN_FLIGHT }));
            self.reply(refused(refusal), id, reserve.place.take());
            return;
        };
        let is_subscribe = self
            .services
            .registry
            .descriptor(&request.method)
            .is_some_and(|descriptor| descriptor.procedure_type == ProcedureType::Subscription);
        if is_subscribe && !self.services.subscriptions.has_room(self.transport) {
            self.reply(refused(subscription_limit_reached()), id, permit);
            return;
        }

        let cancellation = self.calls.child_token();
        let call = self.next_call;
        self.next_call += 1;
        self.cancel_table
            .insert(id.clone(), call, cancellation.clone());
        let after_reply = AfterReply::default();
        let context = HandlerContext {
            transport_id: self.transport,
            device_id: self.services.device_id.clone(),
            caller_process: self.caller_process.clone(),
            cancellation,
            recorded_call: None,
            after_reply: after_reply.clone(),
        };
        let answer = self.services.dispatch.dispatch(request, context);
        let pending = PendingCall {
            id,
            call,
            permit,
            running,
            transport: self.transport,
            services: Arc::clone(&self.services),
            outbox: Arc::clone(&self.outbox),
            close: Arc::clone(&self.close),
            connection_calls: self.calls.clone(),
            cancel_table: Arc::clone(&self.cancel_table),
            slotless_replies: Arc::clone(&self.slotless_replies),
            after_reply,
        };
        tokio::spawn(pending.answer(answer));
    }

    /// A notification gets no answer: `$/cancelRequest` cancels the calls under its id, and any
    /// other is dropped.
    fn notice(&self, method: &str, params: Option<&RawValue>, attachments: Vec<Bytes>) {
        if method != CANCEL_REQUEST_METHOD {
            tracing::debug!(
                transport = self.transport.0,
                "A notification the daemon serves none of was dropped"
            );
            return;
        }
        let json = params.map_or("null", RawValue::get);
        match parse_received::<CancelRequestParams>(json.as_bytes(), attachments) {
            Ok(cancel) => self.cancel_table.cancel(&cancel.id),
            // Never logged with its error, whose sources can quote the received value.
            Err(_refusal) => tracing::debug!(
                transport = self.transport.0,
                "A $/cancelRequest whose params break their contract was dropped"
            ),
        }
    }

    /// Answers on lane 0 with the error `failure` maps to, holding `permit` until it is cut.
    fn reply(&self, failure: CallFailure, id: JsonRpcId, permit: Option<OwnedSemaphorePermit>) {
        push_error_reply(&self.outbox, &self.close, failure, id, permit);
    }
}

/// One dispatched call waiting for its answer.
struct PendingCall {
    id: JsonRpcId,
    call: u64,
    /// The call's slot; `None` for a slotless method, whose reply takes a place once it is ready.
    permit: Option<OwnedSemaphorePermit>,
    /// A counted slotless call's running count, given up once its reply holds its place.
    running: Option<OwnedSemaphorePermit>,
    transport: TransportId,
    services: Arc<GatewayServices>,
    outbox: Arc<Outbox>,
    close: Arc<ConnectionClose>,
    connection_calls: CancellationToken,
    cancel_table: Arc<CancelTable>,
    slotless_replies: Arc<Semaphore>,
    /// What the handler left to run once its result is queued.
    after_reply: AfterReply,
}

impl PendingCall {
    /// Awaits the dispatch, leaves the cancel table, and queues the answer: a result, an error, or
    /// a subscription's acknowledgment followed by its stream.
    async fn answer(mut self, answer: BoxFuture<'static, Result<Reply, DispatchError>>) {
        let outcome = answer.await;
        self.cancel_table.remove(&self.id, self.call);
        if self.permit.is_none() {
            let place = match Arc::clone(&self.slotless_replies).try_acquire_owned() {
                Ok(place) => place,
                // Once the connection closes no place frees for certain, and no reply would be
                // sent.
                Err(_no_place) => tokio::select! {
                    biased;
                    () = self.connection_calls.cancelled() => return,
                    place = Arc::clone(&self.slotless_replies).acquire_owned() => {
                        place.expect("the slotless replies' semaphore is never closed")
                    }
                },
            };
            self.permit = Some(place);
            self.running = None;
        }
        match outcome {
            Ok(Reply::Result(value)) => match encode_response(self.id, value) {
                Ok(message) => {
                    self.outbox.push_reply(message, self.permit);
                    // Queued now, the reply is written before any close this action starts.
                    self.after_reply.run();
                }
                Err(error) => self
                    .close
                    .fail(SupervisionDisconnectReason::ServerClose, &error),
            },
            Ok(Reply::Subscription {
                acknowledgment,
                method,
                subscription_id,
                feed,
            }) => {
                let opened =
                    self.services
                        .subscriptions
                        .open(self.transport, method, subscription_id, feed);
                let subscription = match opened {
                    Ok(subscription) => subscription,
                    Err(refusal) => {
                        push_error_reply(
                            &self.outbox,
                            &self.close,
                            refused(refusal),
                            self.id,
                            self.permit,
                        );
                        return;
                    }
                };
                // Opened after the connection's cleanup ran: no lane will carry it.
                if self.connection_calls.is_cancelled() {
                    return;
                }
                let message = match encode_response(self.id, acknowledgment) {
                    Ok(message) => message,
                    Err(error) => {
                        self.close
                            .fail(SupervisionDisconnectReason::ServerClose, &error);
                        return;
                    }
                };
                if let Some((key, acknowledged)) =
                    self.outbox.push_acknowledgment(message, self.permit)
                {
                    drive_subscription(self.outbox, self.close, key, subscription, acknowledged)
                        .await;
                }
            }
            Err(error) => push_error_reply(
                &self.outbox,
                &self.close,
                CallFailure::Dispatch(error),
                self.id,
                self.permit,
            ),
        }
    }
}

/// Queues the error response `failure` maps to under `id`; a response past its cap closes the
/// connection.
fn push_error_reply(
    outbox: &Outbox,
    close: &ConnectionClose,
    failure: CallFailure,
    id: JsonRpcId,
    permit: Option<OwnedSemaphorePermit>,
) {
    match encode_message(&map_json_rpc_error(failure, id), Vec::new()) {
        Ok(message) => outbox.push_reply(message, permit),
        Err(error) => close.fail(SupervisionDisconnectReason::ServerClose, &error),
    }
}

fn refused(refusal: DomainError) -> CallFailure {
    CallFailure::Dispatch(DispatchError::Refused(refusal))
}

/// The refusal a request's envelope earns and the id to answer it under, or `None` when it passes:
/// an id past the bound, which is never echoed, then the envelope's `protocolVersion`.
fn envelope_refusal(
    id: &JsonRpcId,
    method: &str,
    protocol_version: Option<&Value>,
) -> Option<(CallFailure, JsonRpcId)> {
    if !is_within_bound(id) {
        return Some((
            CallFailure::Message(MessageError::NotAMessage),
            JsonRpcId::Null,
        ));
    }
    let details = protocol_version_fault(method, protocol_version)?;
    let refusal = DomainError::new(
        "The request's protocolVersion is missing, no string, or no YYYY-MM-DD date",
        RefusalCode::RequestProtocolVersionInvalid,
    )
    .with_detail(details);
    Some((refused(refusal), id.clone()))
}

/// Whether `id` may be echoed; an id that cannot be written is not.
fn is_within_bound(id: &JsonRpcId) -> bool {
    id.is_within_bound().is_ok_and(|is_within| is_within)
}

/// Why a request's envelope `protocolVersion` is refused, or `None` when it is a `YYYY-MM-DD`
/// string or the method is exempt.
fn protocol_version_fault(
    method: &str,
    protocol_version: Option<&Value>,
) -> Option<ProtocolVersionInvalidDetails> {
    if ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS.contains(&method) {
        return None;
    }
    let (reason, observed_type) = match protocol_version {
        None => (ProtocolVersionInvalidReason::Missing, None),
        Some(Value::String(text)) => {
            if ProtocolVersion::new(text.clone()).is_some() {
                return None;
            }
            (ProtocolVersionInvalidReason::InvalidFormat, None)
        }
        Some(other) => (
            ProtocolVersionInvalidReason::WrongType,
            Some(ObservedType::of(other)),
        ),
    };
    Some(ProtocolVersionInvalidDetails {
        reason,
        observed_type,
    })
}

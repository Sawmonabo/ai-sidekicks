//! One connection to the daemon under a client: its lanes' credit in both directions, the lane-0
//! messages waiting to be cut, the subscriptions its lanes carry, and the reader and writer tasks.
//! The writer sends owed CREDIT frames before any piece of a message, so a request stalled on the
//! daemon's credit never holds back the credit the daemon's own replies wait for.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use futures::{SinkExt as _, StreamExt as _};
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::incoming::{IncomingLanes, IncomingMessage, LaneCredit};
use sidekicks_contracts::jsonrpc::framing::outgoing::OutgoingLanes;
use sidekicks_contracts::jsonrpc::framing::{FramingError, MAX_CHUNK_BYTES};
use sidekicks_contracts::jsonrpc::message::JsonRpcMessage;
use sidekicks_contracts::jsonrpc::streaming::{
    SUBSCRIPTION_END_METHOD, SUBSCRIPTION_NOTIFY_METHOD, SubscriptionId,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::codec::{FramedRead, FramedWrite};
use tokio_util::sync::CancellationToken;

use super::json_rpc::RawReply;
use super::json_rpc::calls::ClientShared;
use super::subscription::{QueuedValue, SubscriptionShared, probe_subscription_id, read_end};
use crate::error::{ClientError, LinkFault, RemoteError};

/// One open connection under a client, as the link watch holds it.
pub struct Link {
    link: Arc<LinkShared>,
    /// Keeps the client, and so the socket, open while the watch holds the link.
    client: Arc<ClientShared>,
}

impl Link {
    /// The handle over `link`, keeping `client` alive.
    pub(crate) fn new(link: Arc<LinkShared>, client: Arc<ClientShared>) -> Self {
        Self { link, client }
    }

    /// The connection this handle holds.
    pub(crate) fn shared(&self) -> &Arc<LinkShared> {
        &self.link
    }

    /// When the last frame of any kind arrived from the daemon.
    pub fn last_frame_at(&self) -> Instant {
        self.link.lock().last_frame_at
    }

    /// Resolves once the link has ended, with why.
    pub async fn ended(&self) -> LinkFault {
        self.link.ended.cancelled().await;
        self.link
            .fault()
            .expect("a link's fault is set before it is marked ended")
    }

    /// Ends the link for `fault`; its calls settle or wait for a resend as any drop does.
    pub fn close(&self, fault: LinkFault) {
        self.client.end_link(&self.link, fault);
    }
}

/// What one connection's tasks, its client and its subscriptions share.
pub(crate) struct LinkShared {
    /// The link's number in its client, so a call knows which link it went out on.
    generation: u64,
    state: Mutex<LinkState>,
    /// Wakes the writer: a message, a grant or owed credit.
    writer_wake: Notify,
    /// Canceled once the link ended, after its fault is set.
    ended: CancellationToken,
    /// Canceled once both tasks have dropped their half of the socket.
    socket_closed: CancellationToken,
}

/// The link's state, under one lock.
struct LinkState {
    incoming: IncomingLanes,
    outgoing: OutgoingLanes,
    /// The credit owed to the daemon, merged per lane until its CREDIT frame is cut.
    owed: HashMap<LaneId, u32>,
    /// Lane 0's messages, in the order they were queued, the front one partly cut.
    control_lane: VecDeque<Bytes>,
    /// The subscriptions the client holds on this link.
    subscriptions: HashMap<SubscriptionId, Arc<SubscriptionShared>>,
    /// Each lane the daemon opened, bound by its first message to its subscription.
    lanes: HashMap<LaneId, SubscriptionId>,
    /// The subscriptions released before any lane bound to them, until their cancel is answered;
    /// a message the daemon queued before the cancel can still come after, and then cancels its
    /// subscription once more, answered `canceled: false`.
    released: HashSet<SubscriptionId>,
    last_frame_at: Instant,
    fault: Option<LinkFault>,
}

impl LinkState {
    /// Owes `credit` to the daemon.
    fn owe(&mut self, credit: LaneCredit) {
        let owed = self.owed.entry(credit.lane).or_default();
        *owed = owed.saturating_add(credit.granted);
    }

    /// Returns a taken message's credit; nothing once its lane has closed.
    fn give_back(&mut self, lane: LaneId, credit_due: u32) {
        if let Some(credit) = self.incoming.take(lane, credit_due) {
            self.owe(credit);
        }
    }

    /// Unbinds a closed lane and releases the subscription it carried, if the client still holds
    /// it.
    fn unbind(&mut self, lane: LaneId) -> Option<Arc<SubscriptionShared>> {
        let subscription_id = self.lanes.remove(&lane)?;
        self.subscriptions.remove(&subscription_id)
    }

    /// The next frame to write: owed credit first, then a piece of lane 0's front message within
    /// the daemon's credit; `None` while there is neither.
    fn next_frame(&mut self) -> Option<Frame> {
        if let Some(lane) = self.owed.keys().next().copied()
            && let Some(granted) = self.owed.remove(&lane)
        {
            return Some(Frame::Credit { lane, granted });
        }
        let available = self
            .outgoing
            .available(LaneId::CONTROL)
            .min(MAX_CHUNK_BYTES);
        if available == 0 {
            return None;
        }
        let message = self.control_lane.front_mut()?;
        let limit = usize::try_from(available).expect("a chunk's size fits a usize");
        let body = message.split_to(limit.min(message.len()));
        let is_end = message.is_empty();
        if is_end {
            self.control_lane.pop_front();
        }
        let is_spent = self.outgoing.spend(
            LaneId::CONTROL,
            u32::try_from(body.len()).expect("a chunk's size fits a u32"),
        );
        debug_assert!(is_spent, "a piece is cut within lane 0's credit");
        Some(Frame::Data {
            lane: LaneId::CONTROL,
            is_end,
            closes_lane: false,
            body,
        })
    }
}

impl LinkShared {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            state: Mutex::new(LinkState {
                incoming: IncomingLanes::default(),
                outgoing: OutgoingLanes::default(),
                owed: HashMap::new(),
                control_lane: VecDeque::new(),
                subscriptions: HashMap::new(),
                lanes: HashMap::new(),
                released: HashSet::new(),
                last_frame_at: Instant::now(),
                fault: None,
            }),
            writer_wake: Notify::new(),
            ended: CancellationToken::new(),
            socket_closed: CancellationToken::new(),
        }
    }

    /// The link's number in its client.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Why the link ended, or `None` while it is open.
    pub(crate) fn fault(&self) -> Option<LinkFault> {
        self.lock().fault.clone()
    }

    /// Resolves once both tasks have dropped their half of the socket.
    pub(crate) async fn socket_closed(&self) {
        self.socket_closed.cancelled().await;
    }

    /// Queues one encoded message on lane 0; dropped once the link has ended.
    pub(crate) fn push_message(&self, message: Bytes) {
        let mut state = self.lock();
        if state.fault.is_some() {
            return;
        }
        state.control_lane.push_back(message);
        drop(state);
        self.writer_wake.notify_one();
    }

    /// Returns a subscription message's credit once its consumer took it.
    pub(crate) fn return_credit(&self, lane: LaneId, credit_due: u32) {
        self.lock().give_back(lane, credit_due);
        self.writer_wake.notify_one();
    }

    /// Admits the lane a successful subscribe answer opens, before the reader reads its next frame.
    pub(crate) fn admit_lane(&self) {
        self.lock().incoming.admit_lane();
    }

    /// Holds `subscription` under `subscription_id` until a lane binds to it; on a link that has
    /// ended it ends at once with the link's fault.
    pub(crate) fn register_subscription(
        &self,
        subscription_id: SubscriptionId,
        subscription: Arc<SubscriptionShared>,
    ) {
        let mut state = self.lock();
        if let Some(fault) = state.fault.clone() {
            drop(state);
            subscription.finish(Some(ClientError::link_down(fault)));
            return;
        }
        state.subscriptions.insert(subscription_id, subscription);
    }

    /// Stops routing `subscription_id`'s messages, returning the credit of `unread` values; later
    /// messages on its lane are dropped with their credit returned.
    pub(crate) fn release_subscription(
        &self,
        subscription_id: SubscriptionId,
        unread: VecDeque<QueuedValue>,
    ) {
        let mut state = self.lock();
        let was_held = state.subscriptions.remove(&subscription_id).is_some();
        if was_held && !state.lanes.values().any(|bound| *bound == subscription_id) {
            state.released.insert(subscription_id);
        }
        for value in unread {
            state.give_back(value.lane, value.credit_due);
        }
        drop(state);
        self.writer_wake.notify_one();
    }

    /// Forgets a released subscription once its cancel is answered.
    pub(crate) fn forget_released(&self, subscription_id: SubscriptionId) {
        self.lock().released.remove(&subscription_id);
    }

    /// Ends the link for `fault`, ending every subscription it carries with it; answers the fault
    /// when this call ended it, `None` when it had ended already.
    pub(crate) fn end(&self, fault: LinkFault) -> Option<LinkFault> {
        let (fault, subscriptions) = {
            let mut state = self.lock();
            if state.fault.is_some() {
                return None;
            }
            let fault = state.fault.insert(fault).clone();
            state.control_lane.clear();
            state.owed.clear();
            state.lanes.clear();
            state.released.clear();
            (fault, std::mem::take(&mut state.subscriptions))
        };
        self.ended.cancel();
        for subscription in subscriptions.into_values() {
            subscription.finish(Some(ClientError::link_down(fault.clone())));
        }
        Some(fault)
    }

    fn lock(&self) -> MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Fires the link's socket-closed signal once both tasks have dropped their half.
struct SocketHalves(CancellationToken);

impl Drop for SocketHalves {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Starts a link over `stream` for `client`: its reader and writer run on their own tasks, which
/// hold the client weakly, so dropping the client's last handle ends the link and closes the
/// socket.
pub(crate) fn start<S>(client: Weak<ClientShared>, generation: u64, stream: S) -> Arc<LinkShared>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let link = Arc::new(LinkShared::new(generation));
    let (read_half, write_half) = tokio::io::split(stream);
    let halves = Arc::new(SocketHalves(link.socket_closed.clone()));
    tokio::spawn(read_frames(
        Weak::clone(&client),
        Arc::clone(&link),
        FramedRead::new(read_half, FrameCodec),
        Arc::clone(&halves),
    ));
    tokio::spawn(write_frames(
        client,
        Arc::clone(&link),
        FramedWrite::new(write_half, FrameCodec),
        halves,
    ));
    link
}

/// Ends `link` for `fault` through its client, which settles the calls on it; through the link
/// alone once the client is gone.
fn end_link(client: &Weak<ClientShared>, link: &Arc<LinkShared>, fault: LinkFault) {
    match client.upgrade() {
        Some(client) => client.end_link(link, fault),
        None => {
            link.end(fault);
        }
    }
}

/// The fault a frame codec error is.
fn link_fault(error: FramingError) -> LinkFault {
    match error {
        FramingError::Io(error) => LinkFault::Io(Arc::new(error)),
        error @ (FramingError::UnknownKind { .. }
        | FramingError::ReservedFlags { .. }
        | FramingError::ChunkTooLong { .. }
        | FramingError::AbortWithLength { .. }
        | FramingError::DataBeyondCredit { .. }
        | FramingError::LaneNotAdmitted { .. }
        | FramingError::TooManyLanes { .. }
        | FramingError::ControlLaneClosed
        | FramingError::LengthPastEnd
        | FramingError::MessageTooLarge { .. }) => LinkFault::Framing(Arc::new(error)),
    }
}

/// Reads frames until the link ends: the daemon closing it, a fault, or an end asked for
/// elsewhere.
async fn read_frames<R>(
    client: Weak<ClientShared>,
    link: Arc<LinkShared>,
    mut frames: FramedRead<R, FrameCodec>,
    halves: Arc<SocketHalves>,
) where
    R: AsyncRead + Unpin,
{
    let fault = loop {
        let next = tokio::select! {
            biased;
            () = link.ended.cancelled() => break None,
            next = frames.next() => next,
        };
        let frame = match next {
            None => break Some(LinkFault::PeerClosed),
            Some(Err(error)) => break Some(link_fault(error)),
            Some(Ok(frame)) => frame,
        };
        if let Err(fault) = receive_frame(&client, &link, frame) {
            break Some(fault);
        }
    };
    if let Some(fault) = fault {
        end_link(&client, &link, fault);
    }
    drop(frames);
    drop(halves);
}

/// Writes owed credit and lane 0's messages until the link ends; a failed write ends it.
async fn write_frames<W>(
    client: Weak<ClientShared>,
    link: Arc<LinkShared>,
    mut frames: FramedWrite<W, FrameCodec>,
    halves: Arc<SocketHalves>,
) where
    W: AsyncWrite + Unpin,
{
    let fault = loop {
        let next = link.lock().next_frame();
        let Some(frame) = next else {
            tokio::select! {
                biased;
                () = link.ended.cancelled() => break None,
                () = link.writer_wake.notified() => {}
            }
            continue;
        };
        let sent = tokio::select! {
            biased;
            () = link.ended.cancelled() => break None,
            sent = frames.send(frame) => sent,
        };
        if let Err(error) = sent {
            break Some(link_fault(error));
        }
    };
    if let Some(fault) = fault {
        end_link(&client, &link, fault);
    }
    drop(frames);
    drop(halves);
}

/// Applies one frame from the daemon: credit, lane bookkeeping, and the message it completes.
fn receive_frame(
    client: &Weak<ClientShared>,
    link: &Arc<LinkShared>,
    frame: Frame,
) -> Result<(), LinkFault> {
    let closed_lane = match &frame {
        Frame::Data {
            lane,
            is_end: true,
            closes_lane: true,
            ..
        }
        | Frame::Abort {
            lane,
            closes_lane: true,
        } => Some(*lane),
        Frame::Data { .. } | Frame::Abort { .. } | Frame::Credit { .. } => None,
    };
    let is_abort = matches!(frame, Frame::Abort { .. });
    let (completed, aborted) = {
        let mut state = link.lock();
        state.last_frame_at = Instant::now();
        let completed = if let Frame::Credit { lane, granted } = frame {
            state.outgoing.grant(lane, granted);
            None
        } else {
            state
                .incoming
                .receive(frame)
                .map_err(|error| LinkFault::Framing(Arc::new(error)))?
        };
        // The client takes lane 0's messages itself, at once.
        if let Some(message) = &completed
            && message.lane.is_control()
        {
            state.give_back(message.lane, message.credit_due);
        }
        for credit in state.incoming.release_owed() {
            state.owe(credit);
        }
        let aborted = closed_lane
            .filter(|_| is_abort)
            .and_then(|lane| state.unbind(lane));
        (completed, aborted)
    };
    link.writer_wake.notify_one();
    // An ABORT that closes a lane, after a cancel the daemon took, ends its stream.
    if let Some(subscription) = aborted {
        subscription.finish(None);
    }
    let Some(IncomingMessage {
        lane,
        body,
        credit_due,
    }) = completed
    else {
        return Ok(());
    };
    let message = JsonRpcMessage::from_slice(&body.json)
        .map_err(|error| LinkFault::Message(Arc::new(error)))?;
    if lane.is_control() {
        route_control(client, link, message, body.attachments);
    } else {
        route_lane(
            client,
            link,
            QueuedValue {
                lane,
                credit_due,
                params: None,
                attachments: body.attachments,
            },
            closed_lane.is_some(),
            message,
        );
    }
    Ok(())
}

/// Routes a lane-0 message: an answer to its call by id; a notification there is dropped.
fn route_control(
    client: &Weak<ClientShared>,
    link: &Arc<LinkShared>,
    message: JsonRpcMessage,
    attachments: Vec<Bytes>,
) {
    let (id, outcome) = match message {
        JsonRpcMessage::Response { id, result } => (
            id,
            Ok(RawReply {
                json: result,
                attachments,
            }),
        ),
        JsonRpcMessage::ErrorResponse { id, error } => (id, Err(RemoteError::from(error))),
        JsonRpcMessage::Notification { method, .. } | JsonRpcMessage::Request { method, .. } => {
            tracing::debug!(
                method = method.as_str(),
                "A daemon message on lane 0 that is no answer was dropped"
            );
            return;
        }
    };
    if let Some(client) = client.upgrade() {
        client.receive_answer(link, &id, outcome);
    }
}

/// Routes a message on a subscription lane, binding the lane by its first message's
/// `subscriptionId`. A message for a subscription the client no longer holds has its credit
/// returned at once and is dropped; a lane whose first message names a subscription the client
/// never held, or one whose acknowledgment did not read, has its subscription canceled.
fn route_lane(
    client: &Weak<ClientShared>,
    link: &Arc<LinkShared>,
    mut value: QueuedValue,
    closes_lane: bool,
    message: JsonRpcMessage,
) {
    let lane = value.lane;
    let (method, params) = match message {
        JsonRpcMessage::Notification { method, params } => (method, params),
        JsonRpcMessage::Request { method, .. } => (method, None),
        JsonRpcMessage::Response { .. } | JsonRpcMessage::ErrorResponse { .. } => {
            (String::new(), None)
        }
    };
    let is_notify = method == SUBSCRIPTION_NOTIFY_METHOD;
    let is_end = method == SUBSCRIPTION_END_METHOD;
    let mut state = link.lock();
    let mut orphan = None;
    let subscription_id = if let Some(subscription_id) = state.lanes.get(&lane) {
        Some(*subscription_id)
    } else {
        let probed = params
            .as_deref()
            .filter(|_| is_notify || is_end)
            .and_then(|params| probe_subscription_id(params).ok());
        if let Some(subscription_id) = probed {
            state.lanes.insert(lane, subscription_id);
            let is_held = state.subscriptions.contains_key(&subscription_id);
            if !is_held && !state.released.remove(&subscription_id) && is_notify {
                orphan = Some(subscription_id);
            }
        }
        probed
    };
    let subscription = subscription_id.and_then(|subscription_id| {
        if is_end {
            state.subscriptions.remove(&subscription_id)
        } else {
            state.subscriptions.get(&subscription_id).cloned()
        }
    });
    if closes_lane {
        state.lanes.remove(&lane);
    }
    let ended = match subscription {
        Some(subscription) if is_notify => {
            value.params = params;
            if let Err(refused) = subscription.push(value) {
                state.give_back(refused.lane, refused.credit_due);
            }
            None
        }
        Some(subscription) if is_end => {
            state.give_back(lane, value.credit_due);
            Some((subscription, params))
        }
        Some(_) | None => {
            if !is_notify && !is_end {
                tracing::debug!(
                    lane = lane.number(),
                    method = method.as_str(),
                    "A subscription lane message that is no notify or end was dropped"
                );
            }
            state.give_back(lane, value.credit_due);
            None
        }
    };
    drop(state);
    link.writer_wake.notify_one();
    if let Some(subscription_id) = orphan
        && let Some(client) = client.upgrade()
    {
        client.cancel_subscription_detached(link, subscription_id);
    }
    if let Some((subscription, params)) = ended {
        let ending = read_end(
            &subscription,
            params.as_deref().map_or("null", RawValue::get),
        );
        subscription.finish(ending);
    }
}

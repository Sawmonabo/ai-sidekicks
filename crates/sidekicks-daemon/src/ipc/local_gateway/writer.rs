//! A connection's writer: lane 0's messages, one lane per subscription, the credit the client
//! grants on each, and the one task that cuts their messages into frames. CREDIT and ABORT frames
//! go first; then each round lane 0 sends one piece of its messages, in the order they arrived,
//! and each waiting subscription lane one piece.
//! The writer holds one cut piece and writes it before it cuts the next, so the socket's buffer
//! holds the rest; each subscription lane holds at most the one message it is sending, because a
//! feed's gate opens only once its lane is empty, has credit and the writer has room.
//! A reply or notification holds at most three copies of its JSON at once while it is encoded:
//! the handler's, the message's, and the frame body's.

use std::collections::{HashMap, VecDeque};
use std::string::FromUtf8Error;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use futures::SinkExt;
use futures::future::BoxFuture;
use serde_json::value::{RawValue, to_raw_value};
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::outgoing::{LanesExhausted, OutgoingLanes};
use sidekicks_contracts::jsonrpc::framing::{
    FramingError, INITIAL_LANE_CREDIT, MAX_CHUNK_BYTES, MessageBody,
};
use sidekicks_contracts::jsonrpc::message::{JsonRpcId, JsonRpcMessage};
use sidekicks_contracts::jsonrpc::streaming::{
    SUBSCRIPTION_END_METHOD, SUBSCRIPTION_NOTIFY_METHOD, SubscriptionEndParams, SubscriptionId,
    SubscriptionNotifyParams,
};
use tokio::io::AsyncWrite;
use tokio::sync::{Notify, OwnedSemaphorePermit, oneshot};
use tokio_util::codec::FramedWrite;

use super::SupervisionDisconnectReason;
use super::connection::ConnectionClose;
use crate::ipc::registry::EncodedValue;
use crate::ipc::stream::feed::{SendGate, SubscriptionClosed};
use crate::ipc::stream::subscriptions::{Subscription, SubscriptionFrame};
use crate::mutex_lock::lock;

/// The bytes of each piece while more than one lane waits, so a lane waits behind at most one
/// piece of each busy lane.
const CONTENDED_PIECE_BYTES: u32 = 16_384;

/// A subscription lane's key in its connection, given before the lane has a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LaneKey(u64);

/// Why a message could not be written for the wire; its connection closes.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MessageEncodeError {
    /// The message's JSON could not be written.
    #[error("the message could not be written as JSON")]
    Json(#[from] serde_json::Error),
    /// A handler's JSON was not UTF-8.
    #[error("a handler's JSON was not UTF-8")]
    Utf8(#[from] FromUtf8Error),
    /// The message passed its JSON or attachment cap.
    #[error(transparent)]
    Framing(#[from] FramingError),
}

/// `message` and its attachments as one frame-codec message; fails past a cap.
pub(crate) fn encode_message(
    message: &JsonRpcMessage,
    attachments: Vec<Bytes>,
) -> Result<Bytes, MessageEncodeError> {
    let json = Bytes::from(message.to_vec()?);
    Ok(MessageBody { json, attachments }.encode()?)
}

/// The response carrying `value` under `id`; fails past a cap.
pub(crate) fn encode_response(
    id: JsonRpcId,
    value: EncodedValue,
) -> Result<Bytes, MessageEncodeError> {
    let result = RawValue::from_string(String::from_utf8(value.json)?)?;
    encode_message(&JsonRpcMessage::Response { id, result }, value.attachments)
}

/// One `$/subscription/notify` carrying `value` under `subscription_id`; its attachments follow
/// unchanged, since the wrapper adds no placeholder.
fn encode_notify(
    subscription_id: SubscriptionId,
    value: EncodedValue,
) -> Result<Bytes, MessageEncodeError> {
    let value_json = RawValue::from_string(String::from_utf8(value.json)?)?;
    let params = to_raw_value(&SubscriptionNotifyParams {
        subscription_id,
        value: &*value_json,
    })?;
    // The handler's copy goes before the message's is written.
    drop(value_json);
    let notify = JsonRpcMessage::Notification {
        method: SUBSCRIPTION_NOTIFY_METHOD.to_owned(),
        params: Some(params),
    };
    encode_message(&notify, value.attachments)
}

/// The `$/subscription/end` that closes a subscription's lane.
fn encode_end(end: &SubscriptionEndParams) -> Result<Bytes, MessageEncodeError> {
    let notification = JsonRpcMessage::Notification {
        method: SUBSCRIPTION_END_METHOD.to_owned(),
        params: Some(to_raw_value(end)?),
    };
    encode_message(&notification, Vec::new())
}

/// What happens once a message's last piece is written.
enum AfterWritten {
    /// Nothing.
    Nothing,
    /// A subscribe call's acknowledgment is on the wire: its subscription may send.
    Acknowledged(oneshot::Sender<()>),
    /// The subscription's lane closed: dropping it answers a cancel waiting on the close.
    LaneClosed(Subscription),
}

impl AfterWritten {
    fn release(self) {
        match self {
            Self::Nothing => {}
            Self::Acknowledged(sender) => {
                if sender.send(()).is_err() {
                    tracing::debug!("A subscription closed before its acknowledgment was written");
                }
            }
            Self::LaneClosed(subscription) => drop(subscription),
        }
    }
}

/// One message waiting on its lane, cut into pieces from its front.
struct OutgoingMessage {
    /// The bytes not yet cut.
    remaining: Bytes,
    /// Whether the lane closes with this message.
    closes_lane: bool,
    /// The call slot or the reply place this message holds until its last piece is cut.
    permit: Option<OwnedSemaphorePermit>,
    after_written: AfterWritten,
}

/// A subscription's lane: its number once its first frame is cut, the messages waiting on it, and
/// the wake its gate waits on.
struct SubscriptionLane {
    number: Option<LaneId>,
    messages: VecDeque<OutgoingMessage>,
    wake: Arc<Notify>,
    /// Whether the lane's key is in the turn order.
    is_queued: bool,
}

/// One piece to write, and what it releases once cut and once written.
struct Piece {
    frame: Frame,
    permit: Option<OwnedSemaphorePermit>,
    after_written: AfterWritten,
}

/// What the writer does next.
enum NextPiece {
    /// Writes this piece.
    Piece(Piece),
    /// Waits for a message, a grant or the close.
    Idle,
    /// Ends: the connection closed and lane 0 is written.
    Done,
}

/// Whether a subscription's gate may open.
enum Readiness {
    /// The connection closed or the lane is gone.
    Closed,
    /// The lane has credit, holds nothing and the writer has room.
    Ready,
    /// The lane has no credit or still holds a message.
    AwaitLane,
    /// Only the piece being written stands in the way; it is the one after this many written.
    AwaitPiece(u64),
}

/// What the writer holds, under one lock.
#[derive(Default)]
struct OutboxState {
    /// Each lane's credit the client granted, and the numbers of this side's lanes.
    lanes: OutgoingLanes,
    /// The credit owed to the client for its lanes, merged per lane until written.
    credits: HashMap<LaneId, u32>,
    /// The ABORT frames to write, each with the subscription it releases once written.
    aborts: VecDeque<(LaneId, Subscription)>,
    /// Lane 0's messages, in arrival order.
    control_lane: VecDeque<OutgoingMessage>,
    subscription_lanes: HashMap<LaneKey, SubscriptionLane>,
    /// The key of each numbered subscription lane.
    numbered: HashMap<LaneId, LaneKey>,
    /// The subscription lanes holding a message and credit, in turn order.
    sendable: VecDeque<LaneKey>,
    /// The subscription pieces left in this round before lane 0's next turn.
    round_left: usize,
    next_lane_key: u64,
    is_writing: bool,
    pieces_cut: u64,
    pieces_written: u64,
    is_closed: bool,
}

impl OutboxState {
    /// The credit `lane` may still spend; a lane not yet numbered has its first credit.
    fn credit_of(&self, lane: &SubscriptionLane) -> u32 {
        lane.number
            .map_or(INITIAL_LANE_CREDIT, |number| self.lanes.available(number))
    }

    /// Puts `key` in the turn order when its lane holds a message and has credit.
    fn queue_if_sendable(&mut self, key: LaneKey) {
        let Some(lane) = self.subscription_lanes.get(&key) else {
            return;
        };
        let is_sendable = !lane.is_queued && !lane.messages.is_empty() && self.credit_of(lane) > 0;
        if is_sendable {
            if let Some(lane) = self.subscription_lanes.get_mut(&key) {
                lane.is_queued = true;
            }
            self.sendable.push_back(key);
        }
    }

    fn next_piece(&mut self) -> Result<NextPiece, LanesExhausted> {
        let piece = if let Some(piece) = self.next_control_frame() {
            Some(piece)
        } else {
            let is_control_lane_ready =
                !self.control_lane.is_empty() && self.lanes.available(LaneId::CONTROL) > 0;
            let waiting = usize::from(is_control_lane_ready) + self.sendable.len();
            let piece_limit = if waiting > 1 {
                CONTENDED_PIECE_BYTES
            } else {
                MAX_CHUNK_BYTES
            };
            // Lane 0 takes the first piece of each round, then each waiting lane one piece.
            if is_control_lane_ready && self.round_left == 0 {
                self.round_left = self.sendable.len();
                Some(self.cut_control_lane(piece_limit))
            } else if let Some(key) = self.sendable.pop_front() {
                self.round_left = self.round_left.saturating_sub(1);
                Some(self.cut_subscription_lane(key, piece_limit)?)
            } else if is_control_lane_ready {
                Some(self.cut_control_lane(piece_limit))
            } else {
                None
            }
        };
        Ok(match piece {
            Some(piece) => {
                self.is_writing = true;
                self.pieces_cut += 1;
                NextPiece::Piece(piece)
            }
            None if self.is_closed && self.control_lane.is_empty() => NextPiece::Done,
            None => NextPiece::Idle,
        })
    }

    /// A CREDIT frame owed to the client, else an ABORT.
    fn next_control_frame(&mut self) -> Option<Piece> {
        if let Some((&lane, &granted)) = self.credits.iter().next() {
            self.credits.remove(&lane);
            return Some(Piece {
                frame: Frame::Credit { lane, granted },
                permit: None,
                after_written: AfterWritten::Nothing,
            });
        }
        self.aborts.pop_front().map(|(lane, subscription)| Piece {
            frame: Frame::Abort {
                lane,
                closes_lane: true,
            },
            permit: None,
            after_written: AfterWritten::LaneClosed(subscription),
        })
    }

    fn cut_control_lane(&mut self, piece_limit: u32) -> Piece {
        let message = self
            .control_lane
            .front_mut()
            .expect("lane 0 holds a message when it is ready");
        let frame = cut_piece(message, LaneId::CONTROL, piece_limit, &mut self.lanes);
        if !is_last_piece(&frame) {
            return Piece {
                frame,
                permit: None,
                after_written: AfterWritten::Nothing,
            };
        }
        let message = self
            .control_lane
            .pop_front()
            .expect("lane 0 holds the message just cut");
        Piece {
            frame,
            permit: message.permit,
            after_written: message.after_written,
        }
    }

    fn cut_subscription_lane(
        &mut self,
        key: LaneKey,
        piece_limit: u32,
    ) -> Result<Piece, LanesExhausted> {
        let lane = self
            .subscription_lanes
            .get_mut(&key)
            .expect("a lane in the turn order is open");
        lane.is_queued = false;
        // A lane takes its number as its first frame is cut, so first frames leave in number order.
        let number = if let Some(number) = lane.number {
            number
        } else {
            let number = self.lanes.open()?;
            self.numbered.insert(number, key);
            lane.number = Some(number);
            number
        };
        let message = lane
            .messages
            .front_mut()
            .expect("a lane in the turn order holds a message");
        let frame = cut_piece(message, number, piece_limit, &mut self.lanes);
        let piece = if is_last_piece(&frame) {
            let message = lane
                .messages
                .pop_front()
                .expect("the lane holds the message just cut");
            if lane.messages.is_empty() {
                lane.wake.notify_waiters();
            }
            if message.closes_lane {
                self.subscription_lanes.remove(&key);
                self.numbered.remove(&number);
                self.lanes.close(number);
            }
            Piece {
                frame,
                permit: message.permit,
                after_written: message.after_written,
            }
        } else {
            Piece {
                frame,
                permit: None,
                after_written: AfterWritten::Nothing,
            }
        };
        self.queue_if_sendable(key);
        Ok(piece)
    }

    fn readiness(&self, key: LaneKey, written_before: Option<u64>) -> Readiness {
        if self.is_closed {
            return Readiness::Closed;
        }
        let Some(lane) = self.subscription_lanes.get(&key) else {
            return Readiness::Closed;
        };
        if self.credit_of(lane) == 0 || !lane.messages.is_empty() {
            return Readiness::AwaitLane;
        }
        let has_room =
            !self.is_writing || written_before.is_some_and(|written| self.pieces_written > written);
        if has_room {
            Readiness::Ready
        } else {
            Readiness::AwaitPiece(self.pieces_written)
        }
    }
}

/// Cuts the next piece of `message` on `lane`: at most `piece_limit` bytes and the lane's credit,
/// which it spends.
fn cut_piece(
    message: &mut OutgoingMessage,
    lane: LaneId,
    piece_limit: u32,
    lanes: &mut OutgoingLanes,
) -> Frame {
    let limit = usize::try_from(piece_limit.min(lanes.available(lane)))
        .expect("a piece's size fits a usize");
    let body = message
        .remaining
        .split_to(limit.min(message.remaining.len()));
    let is_spent = lanes.spend(
        lane,
        u32::try_from(body.len()).expect("a piece's size fits a u32"),
    );
    debug_assert!(is_spent, "a piece is cut within its lane's credit");
    let is_end = message.remaining.is_empty();
    Frame::Data {
        lane,
        is_end,
        closes_lane: is_end && message.closes_lane,
        body,
    }
}

fn is_last_piece(frame: &Frame) -> bool {
    matches!(frame, Frame::Data { is_end: true, .. })
}

/// A connection's outgoing side, shared by its reader, its calls, its subscriptions and the writer
/// task.
pub(crate) struct Outbox {
    state: Mutex<OutboxState>,
    /// Wakes the writer task: a message, a grant, owed credit or the close.
    writer_wake: Notify,
    /// Wakes the gates waiting for the piece being written.
    piece_written: Notify,
}

impl Outbox {
    /// An empty outbox, each lane at its first credit.
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(OutboxState::default()),
            writer_wake: Notify::new(),
            piece_written: Notify::new(),
        })
    }

    /// Queues a response or a notification on lane 0, holding `permit` until its last piece is
    /// cut; dropped at once once the connection closed.
    pub(crate) fn push_reply(&self, message: Bytes, permit: Option<OwnedSemaphorePermit>) {
        self.push_control_lane(OutgoingMessage {
            remaining: message,
            closes_lane: false,
            permit,
            after_written: AfterWritten::Nothing,
        });
    }

    /// Queues a subscribe call's acknowledgment on lane 0 and opens its subscription's lane, not
    /// yet numbered. Answers the lane's key and the signal that the acknowledgment was written, or
    /// `None` once the connection closed.
    pub(crate) fn push_acknowledgment(
        &self,
        message: Bytes,
        permit: Option<OwnedSemaphorePermit>,
    ) -> Option<(LaneKey, oneshot::Receiver<()>)> {
        let (sender, acknowledged) = oneshot::channel();
        let mut state = self.lock();
        if state.is_closed {
            return None;
        }
        let key = LaneKey(state.next_lane_key);
        state.next_lane_key += 1;
        state.subscription_lanes.insert(
            key,
            SubscriptionLane {
                number: None,
                messages: VecDeque::new(),
                wake: Arc::new(Notify::new()),
                is_queued: false,
            },
        );
        state.control_lane.push_back(OutgoingMessage {
            remaining: message,
            closes_lane: false,
            permit,
            after_written: AfterWritten::Acknowledged(sender),
        });
        drop(state);
        self.writer_wake.notify_one();
        Some((key, acknowledged))
    }

    /// Adds the client's grant to this side's `lane`; a grant for a lane not open is ignored.
    pub(crate) fn grant(&self, lane: LaneId, granted: u32) {
        let mut state = self.lock();
        state.lanes.grant(lane, granted);
        if let Some(&key) = state.numbered.get(&lane) {
            state.queue_if_sendable(key);
            if let Some(subscription_lane) = state.subscription_lanes.get(&key) {
                subscription_lane.wake.notify_waiters();
            }
        }
        drop(state);
        self.writer_wake.notify_one();
    }

    /// Owes the client `granted` more bytes on its `lane`, merged with what is owed there already.
    pub(crate) fn return_credit(&self, lane: LaneId, granted: u32) {
        if granted == 0 {
            return;
        }
        let mut state = self.lock();
        if state.is_closed {
            return;
        }
        let owed = state.credits.entry(lane).or_default();
        *owed = owed.saturating_add(granted);
        drop(state);
        self.writer_wake.notify_one();
    }

    /// The gate a subscription's feed waits on before each frame of its lane.
    pub(crate) fn gate(self: &Arc<Self>, key: LaneKey) -> Option<LaneGate> {
        let wake = Arc::clone(&self.lock().subscription_lanes.get(&key)?.wake);
        Some(LaneGate {
            outbox: Arc::clone(self),
            key,
            wake,
        })
    }

    /// Closes the outbox: every gate fails, every subscription lane and owed frame is dropped, and
    /// the writer ends once lane 0's messages are written.
    pub(crate) fn close(&self) {
        let (lanes, aborts) = {
            let mut state = self.lock();
            state.is_closed = true;
            state.credits.clear();
            state.sendable.clear();
            state.numbered.clear();
            (
                std::mem::take(&mut state.subscription_lanes),
                std::mem::take(&mut state.aborts),
            )
        };
        for lane in lanes.values() {
            lane.wake.notify_waiters();
        }
        self.piece_written.notify_waiters();
        self.writer_wake.notify_one();
        drop(lanes);
        drop(aborts);
    }

    fn push_control_lane(&self, message: OutgoingMessage) {
        let mut state = self.lock();
        if state.is_closed {
            drop(state);
            drop(message);
            return;
        }
        state.control_lane.push_back(message);
        drop(state);
        self.writer_wake.notify_one();
    }

    /// Queues `message` on the subscription lane `key`; dropped once the lane or the connection
    /// closed.
    fn push_subscription_lane(&self, key: LaneKey, message: OutgoingMessage) {
        let mut state = self.lock();
        let Some(lane) = state.subscription_lanes.get_mut(&key) else {
            drop(state);
            drop(message);
            return;
        };
        lane.messages.push_back(message);
        state.queue_if_sendable(key);
        drop(state);
        self.writer_wake.notify_one();
    }

    /// Closes the canceled subscription's lane: its unsent messages are dropped, then an ABORT
    /// with CLOSE is written, and only then is `subscription` dropped. A lane not yet numbered
    /// takes its number for that ABORT, which spends the lane the client admitted for it.
    fn abort_lane(&self, key: LaneKey, subscription: Subscription) {
        let (messages, released) = {
            let mut state = self.lock();
            match state.subscription_lanes.remove(&key) {
                None => (VecDeque::new(), Some(subscription)),
                Some(lane) => {
                    if lane.is_queued {
                        state.sendable.retain(|queued| *queued != key);
                    }
                    let number = match lane.number {
                        Some(number) => {
                            state.numbered.remove(&number);
                            Ok(number)
                        }
                        None => state.lanes.open(),
                    };
                    match number {
                        Ok(number) => {
                            state.lanes.close(number);
                            state.aborts.push_back((number, subscription));
                            (lane.messages, None)
                        }
                        // Every lane number is spent, so no lane could open for it either.
                        Err(LanesExhausted) => (lane.messages, Some(subscription)),
                    }
                }
            }
        };
        self.writer_wake.notify_one();
        drop(messages);
        drop(released);
    }

    /// Marks the piece being written as written and wakes the gates waiting for it.
    fn finish_piece(&self) {
        {
            let mut state = self.lock();
            state.is_writing = false;
            state.pieces_written += 1;
        }
        self.piece_written.notify_waiters();
    }

    fn next_piece(&self) -> Result<NextPiece, LanesExhausted> {
        self.lock().next_piece()
    }

    fn lock(&self) -> MutexGuard<'_, OutboxState> {
        lock(&self.state)
    }

    /// What the outbox holds now, for the tests' bounds.
    #[cfg(test)]
    pub(crate) fn held(&self) -> HeldMessages {
        let state = self.lock();
        HeldMessages {
            pieces_in_hand: state.pieces_cut - state.pieces_written,
            control_lane: state.control_lane.len(),
            largest_subscription_lane: state
                .subscription_lanes
                .values()
                .map(|lane| lane.messages.len())
                .max()
                .unwrap_or(0),
        }
    }
}

/// What an outbox holds at one moment.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct HeldMessages {
    /// Pieces cut and not yet written.
    pub(crate) pieces_in_hand: u64,
    /// Lane 0's messages not yet wholly cut.
    pub(crate) control_lane: usize,
    /// The most messages one subscription lane holds.
    pub(crate) largest_subscription_lane: usize,
}

/// One subscription's send gate: open while its lane has credit, holds no message and the writer
/// has room; it fails once the connection closed.
pub(crate) struct LaneGate {
    outbox: Arc<Outbox>,
    key: LaneKey,
    wake: Arc<Notify>,
}

impl LaneGate {
    async fn wait_ready(&self) -> Result<(), SubscriptionClosed> {
        // The pieces written when the lane was last seen ready with a piece being written: a later
        // count means that piece was written, so the writer has had room.
        let mut written_before = None;
        loop {
            let lane_changed = self.wake.notified();
            let piece_written = self.outbox.piece_written.notified();
            tokio::pin!(lane_changed, piece_written);
            lane_changed.as_mut().enable();
            piece_written.as_mut().enable();
            let readiness = self.outbox.lock().readiness(self.key, written_before);
            match readiness {
                Readiness::Closed => return Err(SubscriptionClosed),
                Readiness::Ready => return Ok(()),
                Readiness::AwaitLane => {
                    written_before = None;
                    lane_changed.await;
                }
                Readiness::AwaitPiece(pieces_written) => {
                    written_before.get_or_insert(pieces_written);
                    tokio::select! {
                        () = lane_changed => {}
                        () = piece_written => {}
                    }
                }
            }
        }
    }
}

impl SendGate for LaneGate {
    fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>> {
        Box::pin(self.wait_ready())
    }
}

/// Drives one subscription once its acknowledgment is written: each frame its gate lets through
/// goes onto its lane, the end with CLOSE; a canceled subscription's lane is aborted. A message
/// past its cap closes the connection.
pub(crate) async fn drive_subscription(
    outbox: Arc<Outbox>,
    close: Arc<ConnectionClose>,
    key: LaneKey,
    mut subscription: Subscription,
    acknowledged: oneshot::Receiver<()>,
) {
    if acknowledged.await.is_err() {
        return;
    }
    let Some(gate) = outbox.gate(key) else {
        return;
    };
    loop {
        match subscription.next_frame(&gate).await {
            Some(SubscriptionFrame::Notify(value)) => {
                match encode_notify(*subscription.subscription_id(), value) {
                    Ok(message) => outbox.push_subscription_lane(
                        key,
                        OutgoingMessage {
                            remaining: message,
                            closes_lane: false,
                            permit: None,
                            after_written: AfterWritten::Nothing,
                        },
                    ),
                    Err(error) => {
                        close.fail(SupervisionDisconnectReason::ServerClose, &error);
                        return;
                    }
                }
            }
            Some(SubscriptionFrame::End(end)) => {
                match encode_end(&end) {
                    Ok(message) => outbox.push_subscription_lane(
                        key,
                        OutgoingMessage {
                            remaining: message,
                            closes_lane: true,
                            permit: None,
                            after_written: AfterWritten::LaneClosed(subscription),
                        },
                    ),
                    Err(error) => close.fail(SupervisionDisconnectReason::ServerClose, &error),
                }
                return;
            }
            None => {
                outbox.abort_lane(key, subscription);
                return;
            }
        }
    }
}

/// Writes the outbox's pieces until it closes and lane 0 is written, then shuts the stream's write
/// side. A failed write closes the connection as a transport error.
pub(crate) async fn write_pieces<W>(
    outbox: Arc<Outbox>,
    mut frames: FramedWrite<W, FrameCodec>,
    close: Arc<ConnectionClose>,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        let wake = outbox.writer_wake.notified();
        match outbox.next_piece() {
            Ok(NextPiece::Piece(piece)) => {
                let Piece {
                    frame,
                    permit,
                    after_written,
                } = piece;
                // The slot frees as the reply's last piece is cut.
                drop(permit);
                if let Err(error) = frames.send(frame).await {
                    close.fail(SupervisionDisconnectReason::TransportError, &error);
                    return;
                }
                outbox.finish_piece();
                after_written.release();
            }
            Ok(NextPiece::Idle) => wake.await,
            Ok(NextPiece::Done) => {
                if let Err(error) = SinkExt::<Frame>::close(&mut frames).await {
                    close.fail(SupervisionDisconnectReason::TransportError, &error);
                }
                return;
            }
            Err(exhausted) => {
                close.fail(SupervisionDisconnectReason::ServerClose, &exhausted);
                return;
            }
        }
    }
}

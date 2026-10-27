//! One Claude Code session's ordered queue: every frame, request, turn end and exit its process's
//! reader hands over, and every delivery a caller off the session's task makes, in the order they
//! came. One task per live process drains it, awaiting each arrival whole before the next, so a
//! session's deliveries reach the run engine in order. The reader settles control answers and the
//! turn's hold itself and never waits on the task, so the queue is unbounded, as Codex's own
//! client keeps its event queue; its depth is logged once it passes a mark and at each doubling.

pub(crate) mod task;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::delivery::stream::daemon_ends::ClaudeDaemonEndSettlement;
use crate::driver::claude::delivery::stream::{ClaudeSessionStream, ClaudeSessionStreams};
use crate::driver::claude::event_normalizer::is_claude_result_frame_kind;
use crate::driver::claude::frame_routing::{ClaudeFrameRouting, ClaudeRoutedObservation};
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::process::{
    ClaudeProcessEnd, ClaudeProcessListener, ClaudeStreamFrame,
};
use crate::driver::claude::session::state::ClaudeSessionRoutingBand;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::{InboundDelivery, InboundOutcome};
use sidekicks_std::mutex_lock::lock;

/// The depth past which a session's queue is logged, then again at each doubling.
const CLAUDE_SESSION_ARRIVALS_DEPTH_MARK: usize = 1_024;

tokio::task_local! {
    // Where a delivery made by the code running now goes, which a session's dialogs read.
    static CLAUDE_DELIVERY_PLACE: ClaudeDeliveryPlace;
}

/// One thing a session's task handles, in the order it arrived.
pub(crate) enum ClaudeSessionArrival {
    /// A stream frame of the session's process, routed on the reader.
    Frame(Box<ClaudeRoutedFrame>),
    /// The lead's turn ended: its settlement follows the turn-ending `result`.
    Terminal,
    /// A request the process sent, or its withdrawal.
    Request(ClaudeInboundRequestEvent),
    /// The process ended; the last arrival.
    Exit(ClaudeProcessEnd),
    /// A delivery a caller off the task made, which keeps its place among the frames.
    Deliver(ClaudeOwnDelivery),
}

/// A stream frame as the reader routed it: the routing band's decision, the helper starts and ends
/// read off it, the output speed its handshake settled, whether a lead `result` ends the turn, and
/// the session's turn as the reader read it.
pub(crate) struct ClaudeRoutedFrame {
    /// The frame.
    pub(crate) frame: ClaudeStreamFrame,
    /// What the routing band read off it.
    pub(crate) routed: ClaudeRoutedObservation,
    /// Whether it is the lead's `result` that ends the turn; a `now` steer's abort ends none.
    pub(crate) is_turn_ending: bool,
    /// The session's turn as the reader read the frame, which the task reads it under: the reader
    /// releases a turn's hold as it reads the turn's end, ahead of the task.
    pub(crate) turn_at_read: ClaudeTurnAtRead,
}

/// The session's turn as the reader read a frame.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClaudeTurnAtRead {
    /// The run holding it, if a run did.
    pub(crate) lead: Option<ClaudeBoundRun>,
    /// Whether anything held it: a run or a command.
    pub(crate) is_held: bool,
}

/// A delivery a caller off a session's task hands the task.
pub(crate) enum ClaudeOwnDelivery {
    /// A delivery dispatched in its place; `outcome` takes what the dispatch answered.
    Dispatch {
        /// The delivery, boxed since it is far larger than the other arrivals.
        delivery: Box<InboundDelivery<'static>>,
        /// Where the dispatch's outcome goes; a caller that stopped waiting needs none.
        outcome: oneshot::Sender<Option<InboundOutcome>>,
    },
    /// The daemon's own end of a run settled, so the turn end held for it is dropped or delivered.
    DaemonEnd {
        /// The run.
        run_id: RunId,
        /// How the daemon's end settled.
        settlement: ClaudeDaemonEndSettlement,
    },
    /// A steer a run carried its turn over for was withdrawn or never written.
    CarriedRelease {
        /// The run.
        run_id: RunId,
    },
}

/// The session task the code running now is on, where a delivery for that session is dispatched
/// in place.
#[derive(Clone)]
pub(crate) struct ClaudeDeliveryPlace {
    /// The session whose task it is.
    session_id: SessionId,
    /// The account the session's process runs on; `None` on the machine's own home.
    provider_account_id: Option<ProviderAccountId>,
}

impl ClaudeDeliveryPlace {
    // Runs `work` on this session's task, so the deliveries it makes for the session go in place.
    async fn scope<Output>(self, work: impl Future<Output = Output>) -> Output {
        CLAUDE_DELIVERY_PLACE.scope(self, work).await
    }
}

/// Delivers `delivery` in `session_id`'s order among its process's frames: in place on the
/// session's own task, queued onto that task from anywhere else, and straight to `dispatch` only
/// when the session has no stream left to order it. The delivery is handed over before the
/// returned future is first polled, which answers its outcome.
pub(crate) fn deliver_in_session_order<'dispatch>(
    dispatch: &'dispatch dyn InboundDispatch,
    streams: &ClaudeSessionStreams,
    session_id: SessionId,
    delivery: InboundDelivery<'static>,
) -> BoxFuture<'dispatch, Option<InboundOutcome>> {
    if let Ok(place) = CLAUDE_DELIVERY_PLACE.try_with(Clone::clone)
        && place.session_id == session_id
    {
        let origin = claude_delivery_origin(place.provider_account_id, None);
        return dispatch_delivery(dispatch, origin, delivery).boxed();
    }
    match streams.get(session_id) {
        Some(stream) => stream.arrivals().dispatch(delivery).boxed(),
        None => dispatch_delivery(dispatch, claude_delivery_origin(None, None), delivery).boxed(),
    }
}

/// The sending half of a session's queue, which its reader and every caller off its task hold.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeArrivalSender {
    session_id: SessionId,
    sender: mpsc::UnboundedSender<ClaudeSessionArrival>,
    depth: Arc<QueueDepth>,
}

/// The receiving half, which the session's task drains.
#[derive(Debug)]
pub(crate) struct ClaudeArrivalReceiver {
    session_id: SessionId,
    receiver: mpsc::UnboundedReceiver<ClaudeSessionArrival>,
    depth: Arc<QueueDepth>,
}

// How deep a queue is, and the depth at which it is next logged.
#[derive(Debug)]
struct QueueDepth {
    items: AtomicUsize,
    next_mark: AtomicUsize,
}

impl QueueDepth {
    // Counts one item taken; a drained queue logs its next burst from the first mark again.
    fn taken(&self) {
        if self.items.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.next_mark
                .store(CLAUDE_SESSION_ARRIVALS_DEPTH_MARK, Ordering::Relaxed);
        }
    }
}

/// A new queue for `session_id`'s process.
pub(crate) fn claude_session_arrivals(
    session_id: SessionId,
) -> (ClaudeArrivalSender, ClaudeArrivalReceiver) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let depth = Arc::new(QueueDepth {
        items: AtomicUsize::new(0),
        next_mark: AtomicUsize::new(CLAUDE_SESSION_ARRIVALS_DEPTH_MARK),
    });
    (
        ClaudeArrivalSender {
            session_id,
            sender,
            depth: Arc::clone(&depth),
        },
        ClaudeArrivalReceiver {
            session_id,
            receiver,
            depth,
        },
    )
}

impl ClaudeArrivalSender {
    /// The session the queue is for.
    pub(crate) fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// Queues `arrival`; `false` when the session's task has ended, so nothing reads it.
    pub(crate) fn push(&self, arrival: ClaudeSessionArrival) -> bool {
        // Counted before the send, so the task never takes an item the count does not hold yet.
        let depth = self.depth.items.fetch_add(1, Ordering::Relaxed) + 1;
        if self.sender.send(arrival).is_err() {
            self.depth.items.fetch_sub(1, Ordering::Relaxed);
            return false;
        }
        let mark = self.depth.next_mark.load(Ordering::Relaxed);
        if depth >= mark
            && self
                .depth
                .next_mark
                .compare_exchange(
                    mark,
                    mark.saturating_mul(2),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_ok()
        {
            tracing::debug!(
                session_id = %self.session_id,
                depth,
                "a Claude Code session's queue is deep; its task is behind its process"
            );
        }
        true
    }

    /// Queues `delivery` now, before the returned future is first polled, to be dispatched in its
    /// place on the session's task, and answers its outcome once the task reaches it; `None` when
    /// the task ended first.
    pub(crate) fn dispatch(
        &self,
        delivery: InboundDelivery<'static>,
    ) -> impl Future<Output = Option<InboundOutcome>> + Send + 'static {
        let (outcome, answered) = oneshot::channel();
        let is_queued = self.push(ClaudeSessionArrival::Deliver(ClaudeOwnDelivery::Dispatch {
            delivery: Box::new(delivery),
            outcome,
        }));
        async move {
            if !is_queued {
                return None;
            }
            answered.await.ok().flatten()
        }
    }
}

/// What a session's task does with each arrival, and the timed work the arrivals leave: streamed
/// text pieces and held tool results come due without a new frame.
pub(crate) trait ClaudeSessionArrivalHandler: Send {
    /// Handles one arrival whole.
    fn arrive(&mut self, arrival: ClaudeSessionArrival) -> BoxFuture<'_, ()>;

    /// When timed work next comes due, `None` when none waits.
    fn next_deadline(&self) -> Option<Instant>;

    /// Does the timed work due at `now`.
    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()>;
}

/// Drains `receiver` into `handler` until its `Exit` is handled or every sender is gone, each
/// arrival and each deadline awaited whole before the next, as the session's own place for a
/// process running on `provider_account_id`'s home.
pub(crate) async fn drain_claude_session_arrivals(
    mut receiver: ClaudeArrivalReceiver,
    handler: &mut impl ClaudeSessionArrivalHandler,
    provider_account_id: Option<ProviderAccountId>,
) {
    let place = ClaudeDeliveryPlace {
        session_id: receiver.session_id,
        provider_account_id,
    };
    loop {
        let deadline = handler.next_deadline();
        // The deadline first, so timed work comes due on time during a burst of arrivals.
        let arrival = tokio::select! {
            biased;
            () = sleep_until_due(deadline) => {
                place
                    .clone()
                    .scope(handler.deadline_reached(Instant::now()))
                    .await;
                continue;
            }
            arrival = receiver.receiver.recv() => arrival,
        };
        let Some(arrival) = arrival else {
            return;
        };
        receiver.depth.taken();
        let is_exit = matches!(arrival, ClaudeSessionArrival::Exit(_));
        place.clone().scope(handler.arrive(arrival)).await;
        if is_exit {
            return;
        }
    }
}

// Waits until `deadline`, or forever when there is none.
async fn sleep_until_due(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Where one process's reader hands what it reads: each frame routed through the session's band
/// under its lock, then queued with what routing read off it, and a turn-ending lead `result`
/// followed by the turn's settlement.
pub(crate) struct ClaudeSessionListener {
    session_id: SessionId,
    provider_session_id: String,
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    routing: Arc<ClaudeFrameRouting>,
    stream: Arc<ClaudeSessionStream>,
    arrivals: ClaudeArrivalSender,
    // The reader's verdict on the lead `result` it is reading, so the queued frame carries the
    // same verdict the turn's hold was released on.
    turn_ending: Mutex<Option<bool>>,
}

impl ClaudeSessionListener {
    /// A listener for the process running under `provider_session_id`, routing through `band`
    /// and queuing onto `arrivals`.
    pub(crate) fn new(
        provider_session_id: String,
        band: Arc<Mutex<ClaudeSessionRoutingBand>>,
        routing: Arc<ClaudeFrameRouting>,
        stream: Arc<ClaudeSessionStream>,
        arrivals: ClaudeArrivalSender,
    ) -> Self {
        Self {
            session_id: arrivals.session_id(),
            provider_session_id,
            band,
            routing,
            stream,
            arrivals,
            turn_ending: Mutex::new(None),
        }
    }
}

impl ClaudeProcessListener for ClaudeSessionListener {
    fn take_frame(&self, frame: ClaudeStreamFrame) {
        let routed = {
            let mut band = lock(&self.band);
            self.routing.route_frame(
                &mut band,
                self.session_id,
                &self.provider_session_id,
                &frame.observation,
            )
        };
        let is_lead_result = frame.observation.subagent_id.is_none()
            && is_claude_result_frame_kind(&frame.observation.frame_kind);
        let decided = lock(&self.turn_ending).take();
        let is_turn_ending =
            is_lead_result && decided.unwrap_or_else(|| self.stream.is_turn_ending(&frame.text));
        let turn_at_read = self.stream.turn_at_read();
        self.arrivals
            .push(ClaudeSessionArrival::Frame(Box::new(ClaudeRoutedFrame {
                frame,
                routed,
                is_turn_ending,
                turn_at_read,
            })));
        if is_turn_ending {
            self.arrivals.push(ClaudeSessionArrival::Terminal);
        }
    }

    fn take_request(&self, event: ClaudeInboundRequestEvent) {
        self.arrivals.push(ClaudeSessionArrival::Request(event));
    }

    fn take_exit(&self, end: ClaudeProcessEnd) {
        self.arrivals.push(ClaudeSessionArrival::Exit(end));
    }

    fn is_turn_ending(&self, frame: &ClaudeStreamFrame) -> bool {
        let is_turn_ending = self.stream.is_turn_ending(&frame.text);
        *lock(&self.turn_ending) = Some(is_turn_ending);
        is_turn_ending
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use tokio::time::Instant;

    use super::{
        ClaudeOwnDelivery, ClaudeRoutedFrame, ClaudeSessionArrival, ClaudeSessionArrivalHandler,
        ClaudeTurnAtRead, claude_session_arrivals, drain_claude_session_arrivals,
    };
    use crate::driver::claude::frame_routing::ClaudeRoutedObservation;
    use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
    use crate::driver::claude::session::process::ClaudeStreamFrame;
    use crate::driver::claude::session::scripted::binding_id;
    use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
    use crate::driver::test_registry::new_session_id;
    use crate::run::delivery::InboundDelivery;
    use crate::thread_frame_router::ThreadFrameRoute;

    // Names each arrival as it is handled; a frame takes a second, so an arrival dispatched beside
    // it rather than after it is handled first.
    #[derive(Default)]
    struct ArrivalLog {
        handled: Vec<String>,
    }

    impl ClaudeSessionArrivalHandler for ArrivalLog {
        fn arrive(&mut self, arrival: ClaudeSessionArrival) -> BoxFuture<'_, ()> {
            async move {
                let name = match arrival {
                    ClaudeSessionArrival::Frame(routed) => {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        routed.frame.text
                    }
                    ClaudeSessionArrival::Request(_) => "request".to_owned(),
                    ClaudeSessionArrival::Deliver(ClaudeOwnDelivery::Dispatch {
                        outcome, ..
                    }) => {
                        outcome.send(None).unwrap_or(());
                        "delivery".to_owned()
                    }
                    ClaudeSessionArrival::Deliver(_)
                    | ClaudeSessionArrival::Terminal
                    | ClaudeSessionArrival::Exit(_) => "other".to_owned(),
                };
                self.handled.push(name);
            }
            .boxed()
        }

        fn next_deadline(&self) -> Option<Instant> {
            None
        }

        fn deadline_reached(&mut self, _now: Instant) -> BoxFuture<'_, ()> {
            async {}.boxed()
        }
    }

    fn frame(text: &str) -> ClaudeSessionArrival {
        ClaudeSessionArrival::Frame(Box::new(ClaudeRoutedFrame {
            frame: ClaudeStreamFrame {
                text: text.to_owned(),
                observation: ClaudeStreamFrameRead::read(r#"{"type":"assistant"}"#)
                    .expect("a test frame reads")
                    .into_observation(),
            },
            routed: ClaudeRoutedObservation {
                route: ThreadFrameRoute::Project,
                helper_lifecycle: Vec::new(),
                settled_output_speed: None,
            },
            is_turn_ending: false,
            turn_at_read: ClaudeTurnAtRead::default(),
        }))
    }

    // Killed by handling arrivals on spawned tasks (the second frame would overtake the first) and
    // by a caller dispatching its delivery itself rather than in its place among the frames.
    #[tokio::test(start_paused = true)]
    async fn arrivals_are_handled_whole_in_the_order_they_came() {
        let (sender, receiver) = claude_session_arrivals(new_session_id());
        sender.push(frame("first frame"));
        sender.push(ClaudeSessionArrival::Request(
            ClaudeInboundRequestEvent::Cancel {
                request_id: "request".to_owned(),
            },
        ));
        sender.push(frame("second frame"));
        let dispatched = sender.dispatch(InboundDelivery::TurnBoundary {
            binding_id: binding_id("binding"),
        });
        sender.push(frame("third frame"));
        drop(sender);

        let mut log = ArrivalLog::default();
        drain_claude_session_arrivals(receiver, &mut log, None).await;

        assert_eq!(dispatched.await, None);
        assert_eq!(
            log.handled,
            [
                "first frame",
                "request",
                "second frame",
                "delivery",
                "third frame"
            ]
        );
    }
}

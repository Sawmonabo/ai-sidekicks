//! One Claude Code session's ordered queue: every frame, request, turn end and exit its process's
//! reader hands over, and every delivery a caller off the session's task makes, in the order they
//! came. One task per live process drains it, awaiting each arrival whole before the next, so a
//! session's deliveries reach the run engine in order. The reader settles control answers and the
//! turn's hold itself and never waits on the task, so the queue is unbounded, as Codex's own
//! client keeps its event queue; its depth is logged once it passes a mark and at each doubling.

pub(super) mod task;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeDaemonEndSettlement;
use crate::provider::driver::claude::frame_routing::{ClaudeFrameRouting, ClaudeRoutedObservation};
use crate::provider::driver::claude::run::routes::ClaudeBoundRun;
use crate::provider::driver::claude::session::process::{
    ClaudeProcessEnd, ClaudeProcessListener, ClaudeStreamFrame,
};
use crate::provider::driver::claude::session::state::ClaudeSessionRoutingBand;
use crate::provider::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::session::run::inbound::{InboundDelivery, InboundOutcome};

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

/// Where a delivery made by the code running now goes: dispatched at once on the session's own
/// task, or queued onto the session's task from anywhere else.
#[derive(Clone)]
pub(crate) enum ClaudeDeliveryPlace {
    /// The code runs on the session's task, so a delivery is dispatched in place.
    SessionTask {
        /// The account the session's process runs on; `None` on the machine's own home.
        provider_account_id: Option<ProviderAccountId>,
    },
    /// The code runs off the session's task, so a delivery is queued to it.
    Queue(ClaudeArrivalSender),
}

impl ClaudeDeliveryPlace {
    /// The place the code running now delivers to; `None` outside any session's place.
    pub(crate) fn current() -> Option<Self> {
        CLAUDE_DELIVERY_PLACE.try_with(Clone::clone).ok()
    }

    /// Runs `work` with this place, so the deliveries it makes go there.
    pub(crate) async fn scope<Output>(self, work: impl Future<Output = Output>) -> Output {
        CLAUDE_DELIVERY_PLACE.scope(self, work).await
    }
}

/// Delivers `delivery` where the code running now is: in place on a session's task, queued to it
/// from a scope off it, or straight to `engine` outside any session's place.
pub(crate) fn deliver_in_current_place<'engine>(
    engine: &'engine dyn ClaudeRunEngine,
    delivery: InboundDelivery<'static>,
) -> BoxFuture<'engine, Option<InboundOutcome>> {
    match ClaudeDeliveryPlace::current() {
        Some(ClaudeDeliveryPlace::Queue(arrivals)) => arrivals.dispatch(delivery).boxed(),
        Some(ClaudeDeliveryPlace::SessionTask {
            provider_account_id,
        }) => engine.deliver(provider_account_id, None, delivery),
        None => engine.deliver(None, None, delivery),
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
    receiver: mpsc::UnboundedReceiver<ClaudeSessionArrival>,
    depth: Arc<QueueDepth>,
}

// How deep a queue is, and the depth at which it is next logged.
#[derive(Debug)]
struct QueueDepth {
    items: AtomicUsize,
    next_mark: AtomicUsize,
}

/// A new queue for `session_id`'s process.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's session bring-up makes each process's queue"
    )
)]
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
        ClaudeArrivalReceiver { receiver, depth },
    )
}

impl ClaudeArrivalSender {
    /// The session the queue is for.
    pub(crate) fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// Queues `arrival`; `false` when the session's task has ended, so nothing reads it.
    pub(crate) fn push(&self, arrival: ClaudeSessionArrival) -> bool {
        if self.sender.send(arrival).is_err() {
            return false;
        }
        let depth = self.depth.items.fetch_add(1, Ordering::Relaxed) + 1;
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's session bring-up spawns each process's task over it"
    )
)]
pub(crate) async fn drain_claude_session_arrivals(
    mut receiver: ClaudeArrivalReceiver,
    handler: &mut impl ClaudeSessionArrivalHandler,
    provider_account_id: Option<ProviderAccountId>,
) {
    let place = ClaudeDeliveryPlace::SessionTask {
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
        receiver.depth.items.fetch_sub(1, Ordering::Relaxed);
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's session bring-up hands each process its listener"
        )
    )]
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
            let mut band = self.band.lock().unwrap_or_else(PoisonError::into_inner);
            self.routing.route_frame(
                &mut band,
                self.session_id,
                &self.provider_session_id,
                &frame.observation,
            )
        };
        let is_lead_result = frame.observation.subagent_id.is_none()
            && frame.observation.frame_kind.split('/').next() == Some("result");
        let decided = self
            .turn_ending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
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
        *self
            .turn_ending
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(is_turn_ending);
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
    use crate::provider::driver::claude::frame_routing::ClaudeRoutedObservation;
    use crate::provider::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
    use crate::provider::driver::claude::session::process::ClaudeStreamFrame;
    use crate::provider::driver::claude::session::scripted::{binding_id, mint_session_id};
    use crate::provider::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
    use crate::provider::thread_frame_router::ThreadFrameRoute;
    use crate::session::run::inbound::InboundDelivery;

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
        let (sender, receiver) = claude_session_arrivals(mint_session_id());
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

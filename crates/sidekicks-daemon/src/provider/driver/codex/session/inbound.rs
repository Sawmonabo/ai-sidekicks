//! One Codex session's inbound queue: the frames and asks a service's reader routed to the
//! session, in arrival order, handed off the reader so it never waits on a session. The reader
//! serves every session on the service and Codex drops a client that falls 32,768 messages behind,
//! so the queue is unbounded, as Codex's own client keeps its event queue, and its depth is logged
//! once it passes a mark and again at each doubling. One task per session drains it, awaiting each
//! item before the next, so the session's events keep their order.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::provider::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::provider::driver::codex::transport::connection::CodexForgottenRequest;
use crate::provider::driver::contract::DriverError;

/// The depth past which a session's queue is logged, then again at each doubling.
const CODEX_SESSION_INBOUND_DEPTH_MARK: usize = 512;

/// One item a service's reader routed to a session.
pub(crate) enum CodexSessionInbound {
    /// A notification, with its params as sent.
    Frame {
        /// The notification's method.
        method: String,
        /// Its params, `null` when it sent none.
        params: Box<RawValue>,
    },
    /// An ask, whose decision the connection waits for.
    Ask {
        /// The ask.
        request: CodexInboundServerRequest,
        /// Where the decision goes; a dropped sender refuses the ask.
        decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    },
    /// Asks a closed connection let go of, whose cards are withdrawn.
    AsksWithdrawn {
        /// Each ask let go of.
        dropped: Vec<CodexForgottenRequest>,
    },
    /// A conversation the session moved off is held for the commands it still runs, its frames
    /// admitted as the session's own, or let go of; queued so the frames around it keep their
    /// place.
    HeldThread {
        /// The conversation.
        thread_id: String,
        /// Whether it is held, rather than let go of.
        is_held: bool,
    },
    /// Answered once every item before it was handled, so a caller knows the frames a reply
    /// trailed have been drained.
    #[expect(
        dead_code,
        reason = "the Codex session's recovery waits for the frames a reply trailed"
    )]
    Barrier(oneshot::Sender<()>),
}

/// The sending half of one session's queue, which each service the session runs on holds.
#[derive(Clone, Debug)]
pub(crate) struct CodexSessionInboundSender {
    session_id: SessionId,
    sender: mpsc::UnboundedSender<CodexSessionInbound>,
    depth: Arc<QueueDepth>,
}

/// The receiving half, which the session's task drains.
#[derive(Debug)]
pub(crate) struct CodexSessionInboundReceiver {
    receiver: mpsc::UnboundedReceiver<CodexSessionInbound>,
    depth: Arc<QueueDepth>,
}

/// How deep a queue is, and the depth at which it is next logged.
#[derive(Debug)]
struct QueueDepth {
    items: AtomicUsize,
    next_mark: AtomicUsize,
}

/// A new queue for `session_id`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's start makes its queue, whose receiver its task drains"
    )
)]
pub(crate) fn codex_session_inbound(
    session_id: SessionId,
) -> (CodexSessionInboundSender, CodexSessionInboundReceiver) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let depth = Arc::new(QueueDepth {
        items: AtomicUsize::new(0),
        next_mark: AtomicUsize::new(CODEX_SESSION_INBOUND_DEPTH_MARK),
    });
    (
        CodexSessionInboundSender {
            session_id,
            sender,
            depth: Arc::clone(&depth),
        },
        CodexSessionInboundReceiver { receiver, depth },
    )
}

impl CodexSessionInboundSender {
    /// The session the queue is for.
    pub(crate) fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// Queues `item`; `false` when the session's task has ended, so nothing reads it.
    pub(crate) fn push(&self, item: CodexSessionInbound) -> bool {
        if self.sender.send(item).is_err() {
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
            tracing::warn!(
                session_id = %self.session_id,
                depth,
                "a Codex session's inbound queue is deep; its task is behind the service"
            );
        }
        true
    }
}

/// What a session's task does with each item of its queue, and the timed work the items leave:
/// streamed text pieces and frames the reorder buffer holds come due without a new frame.
pub(crate) trait CodexSessionInboundHandler: Send {
    /// Handles one notification.
    fn frame(&mut self, method: String, params: Box<RawValue>) -> BoxFuture<'_, ()>;

    /// Decides one ask, answering `decision`.
    fn ask(
        &mut self,
        request: CodexInboundServerRequest,
        decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    ) -> BoxFuture<'_, ()>;

    /// Withdraws the cards of asks a closed connection let go of.
    fn asks_withdrawn(&mut self, dropped: Vec<CodexForgottenRequest>) -> BoxFuture<'_, ()>;

    /// Admits a held conversation's frames as the session's own, or stops admitting them.
    fn held_thread(&mut self, thread_id: String, is_held: bool);

    /// When timed work next comes due, `None` when none waits.
    fn next_deadline(&self) -> Option<Instant>;

    /// Does the timed work due at `now`.
    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()>;
}

/// Drains `receiver` into `handler` until every sender is gone, each item and each deadline
/// awaited whole before the next.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's task drains its queue from the session's start"
    )
)]
pub(crate) async fn drain_codex_session_inbound(
    mut receiver: CodexSessionInboundReceiver,
    handler: &mut impl CodexSessionInboundHandler,
) {
    loop {
        let deadline = handler.next_deadline();
        let item = tokio::select! {
            biased;
            item = receiver.receiver.recv() => item,
            () = sleep_until_due(deadline) => {
                handler.deadline_reached(Instant::now()).await;
                continue;
            }
        };
        let Some(item) = item else {
            return;
        };
        receiver.depth.items.fetch_sub(1, Ordering::Relaxed);
        match item {
            CodexSessionInbound::Frame { method, params } => handler.frame(method, params).await,
            CodexSessionInbound::Ask { request, decision } => {
                handler.ask(request, decision).await;
            }
            CodexSessionInbound::AsksWithdrawn { dropped } => {
                handler.asks_withdrawn(dropped).await;
            }
            CodexSessionInbound::HeldThread { thread_id, is_held } => {
                handler.held_thread(thread_id, is_held);
            }
            CodexSessionInbound::Barrier(reached) => {
                // A caller that stopped waiting needs no answer.
                let _unheard = reached.send(());
            }
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

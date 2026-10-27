//! One Codex session's inbound queue: the frames and asks a service's reader routed to the
//! session, in arrival order, handed off the reader so it never waits on a session. The reader
//! serves every session on the service and Codex drops a client that falls 32,768 messages behind,
//! so the queue is unbounded, as Codex's own client keeps its event queue, and its depth is logged
//! once it passes a mark and again at each doubling. One task per session drains it, awaiting each
//! item before the next, so the session's events keep their order, and the driver's calls on the
//! session's record take their place among its frames.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::codex::output_speed::CodexSettledOutputSpeed;
use crate::codex::run::control::record::CodexRunControlCall;
use crate::codex::run::faster_model_retry::CodexRetryStopAnswer;
use crate::codex::run::start::record::{
    CodexAcceptedTurn, CodexTurnBegin, CodexTurnBeginAnswer, CodexTurnStartOutcome,
};
use crate::codex::run::steer::CodexSteerSend;
use crate::codex::run::turn_end_waiters::{CodexTurnWait, CodexTurnWaitAnswer};
use crate::codex::server_requests::{CodexInboundServerRequest, CodexServerRequestDecision};
use crate::codex::session::calls::CodexSessionReading;
use crate::codex::session::errors::CodexError;
use crate::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::codex::session::recovery::{CodexDroppedTurns, CodexInPlaceResumeCall};
use crate::codex::session::rewind::CodexMessageTurn;
use crate::codex::transport::connection::CodexForgottenRequest;
use crate::driver::contract::DriverError;
use crate::driver::session_control::{
    DriverResumeResult, MoveSessionToForkParams, MoveSessionToForkResult,
};

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
    /// A call the driver makes on the session's record, run on the session's task in its place
    /// among the frames.
    Call(CodexSessionCall),
    /// A call of the driver's own on the record: its close and let-go, a level or mode move, a
    /// side question, and the reads its compaction needs.
    Lifecycle(CodexLifecycleCall),
}

/// A call on a session's record, each answering on its own `reply`; a dropped `reply` means the
/// session's task let the record go first.
pub(crate) enum CodexSessionCall {
    /// Registers a steer on the run's live turn before it is written.
    RegisterSteer {
        /// The run the steer goes to.
        run_id: RunId,
        /// The turn the steer names to Codex, where the caller pins one.
        expected_turn_id: Option<String>,
        /// The steered message's id.
        message_id: QueueItemId,
        /// Where the registered steer, or its refusal, goes.
        reply: oneshot::Sender<Result<CodexSteerSend, DriverError>>,
    },
    /// Takes back a steer Codex did not take.
    WithdrawSteer {
        /// The turn it was registered on.
        turn_id: String,
        /// The steered message's id.
        message_id: QueueItemId,
    },
    /// Registers a wait on the session's turns.
    WaitForTurns {
        /// What the wait waits for.
        wait: CodexTurnWait,
        /// Where the wait's own answer channel goes.
        reply: oneshot::Sender<oneshot::Receiver<CodexTurnWaitAnswer>>,
    },
    /// Runs the fork onto a changed config the session owes, once the caller claimed its slot.
    ConfigFork {
        /// Where `true` goes once the session moved onto the fork, `false` when it owed none or a
        /// turn was in flight, or the fork's failure.
        reply: oneshot::Sender<Result<bool, CodexError>>,
    },
    /// Moves the session onto a fork after a recorded boundary, once the caller claimed its slot.
    MoveToFork {
        /// The boundary and the binding the fork moves.
        params: MoveSessionToForkParams,
        /// Where the move's result, or its failure, goes.
        reply: oneshot::Sender<Result<MoveSessionToForkResult, CodexError>>,
    },
    /// Takes a turn's start on the record, before its request goes.
    BeginTurnStart {
        /// The run, its turn and its binding.
        begin: Box<CodexTurnBegin>,
        /// Where the start goes, or what holds it back.
        reply: oneshot::Sender<CodexTurnBeginAnswer>,
    },
    /// Settles a turn's start with Codex's outcome.
    SettleTurnStart {
        /// The run.
        run_id: RunId,
        /// What the start's acceptance changes.
        accepted: Box<CodexAcceptedTurn>,
        /// How the start went at Codex.
        outcome: CodexTurnStartOutcome,
        /// Where the speed a turn that already ended settled at goes, or the start's failure.
        reply: oneshot::Sender<Result<Option<CodexSettledOutputSpeed>, CodexError>>,
    },
    /// Reads what a turn the daemon starts and `Allow once` act on.
    ReadSession {
        /// A conversation whose load the reading answers, the session's own when `None`.
        thread_id: Option<String>,
        /// Where the reading goes.
        reply: oneshot::Sender<CodexSessionReading>,
    },
    /// A call of run control: an interrupt, a pause or a continue.
    RunControl(CodexRunControlCall),
    /// Marks a held turn retried and takes its route, before its interrupt goes out.
    StopTurnForRetry {
        /// The run.
        run_id: RunId,
        /// The held turn.
        turn_id: String,
        /// Where what the retry sends again goes, or why it is refused.
        reply: oneshot::Sender<CodexRetryStopAnswer>,
    },
    /// Gives a retried turn Codex did not stop back to its run.
    RestoreRetriedTurn {
        /// The run.
        run_id: RunId,
        /// The held turn.
        turn_id: String,
        /// Where `true` goes when the turn runs on as the run's.
        reply: oneshot::Sender<bool>,
    },
    /// Drops every turn the session held on a service whose process ended, with what waits on
    /// them, and answers the runs they belonged to and the binding they ran under.
    DropTurns {
        /// Where the dropped runs and the binding go.
        reply: oneshot::Sender<CodexDroppedTurns>,
    },
    /// Ends the live safety holds a process exit left on the session's turns.
    EndSafetyHolds {
        /// Answered once they ended.
        reply: oneshot::Sender<()>,
    },
    /// Resumes the session's conversation in place on `service`, once the caller claimed the slot,
    /// and ends the turns the resume lists as ended that the session still owed an end.
    ResumeInPlace {
        /// The resume.
        resume: Box<CodexInPlaceResumeCall>,
        /// Where the resume's result goes.
        reply: oneshot::Sender<DriverResumeResult>,
    },
    /// Cuts the conversation back to before `turn_id` with `thread/revert`, once the caller
    /// claimed the slot.
    RevertBefore {
        /// The conversation the caller read the turn on.
        thread_id: String,
        /// The first turn the cut drops.
        turn_id: String,
        /// Where `false` goes when the session moved to another conversation meanwhile, or the
        /// cut's failure.
        reply: oneshot::Sender<Result<bool, CodexError>>,
    },
    /// Reads the turn one of the person's messages started, from what the session recorded.
    ReadMessageTurn {
        /// The message's id.
        message_id: String,
        /// Where the turn and the conversation it is on go; the turn `None` when the session
        /// recorded none for the message.
        reply: oneshot::Sender<CodexMessageTurn>,
    },
    /// Records the turns of the person's messages a conversation's history listed.
    RecordMessageTurns {
        /// The conversation the history was read on.
        thread_id: String,
        /// Each message's turn, by the message's id.
        turn_id_by_client_message_id: HashMap<String, String>,
    },
    /// Forks the conversation to just before a retried turn on the faster model, once the caller
    /// claimed the slot.
    ForkForRetry {
        /// The retried turn.
        turn_id: String,
        /// The faster model.
        model: String,
        /// The run's binding, pointed at the fork.
        binding_id: RuntimeBindingId,
        /// Where the fork's failure goes.
        reply: oneshot::Sender<Result<(), CodexError>>,
    },
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

    /// Runs one call on the session's record.
    fn call(&mut self, call: CodexSessionCall) -> BoxFuture<'_, ()>;

    /// Runs one of the driver's own calls on the session's record.
    fn lifecycle(&mut self, call: CodexLifecycleCall) -> BoxFuture<'_, ()>;

    /// When timed work next comes due, `None` when none waits.
    fn next_deadline(&self) -> Option<Instant>;

    /// Does the timed work due at `now`.
    fn deadline_reached(&mut self, now: Instant) -> BoxFuture<'_, ()>;
}

/// Drains `receiver` into `handler` until every sender is gone, each item and each deadline
/// awaited whole before the next.
pub(crate) async fn drain_codex_session_inbound(
    mut receiver: CodexSessionInboundReceiver,
    handler: &mut impl CodexSessionInboundHandler,
) {
    loop {
        let deadline = handler.next_deadline();
        // The deadline first, so timed work comes due on time during a burst of items.
        let item = tokio::select! {
            biased;
            () = sleep_until_due(deadline) => {
                handler.deadline_reached(Instant::now()).await;
                continue;
            }
            item = receiver.receiver.recv() => item,
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
            CodexSessionInbound::Call(call) => handler.call(call).await,
            CodexSessionInbound::Lifecycle(call) => handler.lifecycle(call).await,
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

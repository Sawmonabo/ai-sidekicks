//! One Codex session's inbound queue: the frames and asks a service's reader routed to the
//! session, and the completed responses the driver's export drain handed it, in arrival order,
//! handed off the reader so it never waits on a session. The reader
//! serves every session on the service and Codex drops a client that falls 32,768 messages behind,
//! so the queue is unbounded, as Codex's own client keeps its event queue, and its depth is logged
//! once it passes a mark and again at each doubling. One task per session drains it, awaiting each
//! item before the next, so the session's events keep their order, and the driver's calls on the
//! session's record take their place among its frames.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::driver::codex::output_speed::CodexSettledOutputSpeed;
use crate::driver::codex::run::control::record::CodexRunControlCall;
use crate::driver::codex::run::faster_model_retry::CodexRetryStopAnswer;
use crate::driver::codex::run::start::record::{
    CodexAcceptedTurn, CodexTurnBegin, CodexTurnBeginAnswer, CodexTurnStartOutcome,
};
use crate::driver::codex::run::steer::CodexSteerSend;
use crate::driver::codex::run::turn_end_waiters::{CodexTurnWait, CodexTurnWaitAnswer};
use crate::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::driver::codex::session::calls::CodexSessionReading;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexInPlaceOutcome;
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::session::recovery::CodexDroppedTurns;
use crate::driver::codex::session::recovery::in_place_resume::CodexInPlaceResumeCall;
use crate::driver::codex::session::rewind::CodexMessageTurn;
use crate::driver::codex::telemetry::held_responses::CodexExportedResponse;
use crate::driver::codex::transport::connection::CodexForgottenRequest;
use crate::driver::contract::account::FirstRequestAfterMove;
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::ReattachedHelper;
use crate::driver::session_control::{MoveSessionToForkParams, MoveSessionToForkResult};
use crate::usage_delta_accountant::UsageAxisCounts;

/// The depth past which a session's queue is logged, then again at each doubling.
const CODEX_SESSION_INBOUND_DEPTH_MARK: usize = 512;

/// One item routed to a session: by a service's reader, or by the driver's export drain.
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
    /// A side question's copy on the conversation was let go, so a turn of it that never
    /// completed ends.
    SideQuestionReleased {
        /// The copy's conversation.
        thread_id: String,
    },
    /// A call the driver makes on the session's record, run on the session's task in its place
    /// among the frames.
    Call(CodexSessionCall),
    /// A call of the driver's own on the record: its close and let-go, a level or mode move, a
    /// side question, and the reads its compaction needs.
    Lifecycle(CodexLifecycleCall),
    /// The session moved onto another account where the switching service acknowledged it among
    /// the frames, so the spend metered before it stays on the account it left.
    AccountMoved(CodexAccountMove),
    /// A completed response Codex's log export stated on one of the session's threads.
    ExportedResponse(CodexExportedResponse),
    /// The service began a new reading of its settings for the session, ahead of the config
    /// warnings that reading sends, so every earlier ignored-settings notice ends.
    SettingsReadingBegan,
}

/// A session's move onto another account, queued at the place among its frames where the service
/// acknowledged it.
pub(crate) struct CodexAccountMove {
    /// The account the session moved onto.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The binding its lead runs on, which moves with it, where a switch named the session; the
    /// session's own binding moves either way.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// Where the bindings' move, or its failure, goes once the spend before it is recorded, where
    /// a switch waits on it.
    pub(crate) moved: Option<oneshot::Sender<Result<(), DriverError>>>,
    /// The person whose switch moved the session without naming it; `None` where no switch did.
    pub(crate) actor: Option<DeviceId>,
    /// Where the first request of a session a switch moved without naming it settles, where the
    /// switch watches it; the move recorded for the session carries it.
    pub(crate) first_request: Option<oneshot::Receiver<Result<FirstRequestAfterMove, DriverError>>>,
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
    /// Takes the mark that the lead's held continuation ended before the steer of the person's
    /// answers was sent, so the answers are owed a turn of their own.
    TakeAnswerTurnOwed {
        /// The lead.
        run_id: RunId,
        /// Whether the mark was there.
        reply: oneshot::Sender<bool>,
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
    /// Restores a helper re-attached after a restart, its conversation reopened: bound to its
    /// child run and registered in the session's routing.
    RestoreHelper {
        /// The helper, as the session's tree holds it.
        helper: Box<ReattachedHelper>,
        /// What was already metered on its conversation, which its usage is based on.
        prior_emitted: UsageAxisCounts,
        /// The model its reopen named, else its node's, which its usage readings name.
        model: Option<String>,
        /// Answered once it is restored.
        reply: oneshot::Sender<()>,
    },
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
    /// them, ends the status sink's leg that ran there, and answers the runs they belonged to and
    /// the binding they ran under.
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
        /// Where the resume's result, and why it failed where it did, goes.
        reply: oneshot::Sender<CodexInPlaceOutcome>,
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

#[cfg(test)]
impl CodexSessionInboundReceiver {
    /// The next item already queued, `None` while none is.
    pub(crate) fn try_next(&mut self) -> Option<CodexSessionInbound> {
        self.receiver.try_recv().ok()
    }
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
        // Counted before the send, so the task's count of the item taken never comes first.
        let depth = self.depth.items.fetch_add(1, Ordering::Relaxed) + 1;
        if self.sender.send(item).is_err() {
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

    /// Ends the live turn of a side question's copy that was let go.
    fn side_question_released(&mut self, thread_id: String);

    /// Runs one call on the session's record.
    fn call(&mut self, call: CodexSessionCall) -> BoxFuture<'_, ()>;

    /// Runs one of the driver's own calls on the session's record.
    fn lifecycle(&mut self, call: CodexLifecycleCall) -> BoxFuture<'_, ()>;

    /// Moves the session onto another account at its place among the frames.
    fn account_moved(&mut self, account_move: CodexAccountMove) -> BoxFuture<'_, ()>;

    /// Ends the session's earlier ignored-settings notices, ahead of a new reading's warnings.
    fn settings_reading_began(&mut self) -> BoxFuture<'_, ()>;

    /// Takes a completed response the export stated: passed over where the stream stated it,
    /// else held until it can be told apart, then priced.
    fn exported_response(&mut self, response: CodexExportedResponse) -> BoxFuture<'_, ()>;

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
            CodexSessionInbound::SideQuestionReleased { thread_id } => {
                handler.side_question_released(thread_id);
            }
            CodexSessionInbound::Call(call) => handler.call(call).await,
            CodexSessionInbound::Lifecycle(call) => handler.lifecycle(call).await,
            CodexSessionInbound::AccountMoved(account_move) => {
                handler.account_moved(account_move).await;
            }
            CodexSessionInbound::ExportedResponse(response) => {
                handler.exported_response(response).await;
            }
            CodexSessionInbound::SettingsReadingBegan => handler.settings_reading_began().await,
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

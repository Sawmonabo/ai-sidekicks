//! Hands a live run the messages waiting for it, each under its own queue item id, as its driver
//! says its provider takes them: at once, the provider holding each to its own next step, or at
//! the turn's next tool boundary, the daemon holding them until then. A message sent while the run
//! waits on the person's input goes as the next turn instead, except while the provider holds a
//! credits choice, which the message settles.
//!
//! A handed message stays `queued` until the provider's record shows it took it, the run's end or
//! a withdraw settles it. Until then no edit, removal or reorder moves it, except by a withdraw,
//! which a change waits for only so long: one not given back in time reads not delivered, so a
//! stuck process never holds the session's writes, and is admitted after all if the provider then
//! shows it took it. A message the provider's process keeps past its run's end stays handed while
//! that process runs; once it is gone, the message waits for the person's next send. While an
//! interrupt of a run is under way nothing more is handed to it. Every hand, withdraw and settle
//! of a session's messages runs on one chain per session, so they reach the driver in the order
//! the queue decided them.

mod chain;
mod hands;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::bounded_wait::wait_within;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::WriteStatement;
use crate::events::session::appender::SessionEventDraft;
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::resolve_run_driver;
use crate::keyed_lock::{KeyHold, KeyedLock};
use crate::provider::driver::contract::{HandMoment, ProviderDriver};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, InterruptPendingChoice, RunToolBoundary, SteerPayload, WaitingMessage,
};
use crate::queue::delivery::chain::{ChainJob, SessionChain, WithdrawJob, lock_flag};
use crate::queue::delivery::hands::{DeliveryState, HandRoute, is_kept_by_process, reordered_of};
use crate::queue::recorder::{QueueRecordError, QueueRecorder, outcome_draft_of};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::{
    QueueItemBody, QueueItemOutcome, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
    placement_statements,
};
use crate::session::run::pause::{ContinuedMessages, ContinuedMessagesError};
use crate::session::run::read::{
    RunRead, RunStateReader, read_run_provider, read_run_through, safe_run_version,
};

/// How long a change waits for a provider to give its handed messages back.
pub(crate) const WITHDRAW_DEADLINE: Duration = Duration::from_secs(10);

/// The process id of each session's provider process.
pub(crate) trait ProviderProcessIds: Send + Sync {
    /// The id of `session_id`'s provider process, or `None` while none runs.
    fn process_id(&self, session_id: &SessionId) -> Option<u32>;
}

/// Which waiting messages open a run whose driver is being started.
pub(crate) trait OpeningMessages: Send + Sync {
    /// Whether the waiting message `item_id` opens a run whose driver is being started, which
    /// that start delivers.
    fn is_opening(&self, item_id: &QueueItemId) -> bool;
}

/// Continues an interrupted run with the messages waiting for it.
pub(crate) trait InterruptedRunContinuation: Send + Sync {
    /// Called off the session lock once the last message the provider kept for `run_id` was taken.
    fn continue_interrupted_run(&self, session_id: SessionId, run_id: RunId);
}

/// What the delivery reads, writes and calls.
#[cfg_attr(not(test), expect(dead_code, reason = "the run queue's start"))]
pub(crate) struct QueueDeliveryDeps {
    /// The read pool every queue and run read goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Records each message's outcome.
    pub(crate) recorder: Arc<QueueRecorder>,
    /// The drivers, found by the provider a run is bound to.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The queue's own per-session lock, never the session append lock: a withdraw waits under it.
    pub(crate) session_lock: Arc<KeyedLock<SessionId>>,
    /// The process id of each session's provider process.
    pub(crate) processes: Arc<dyn ProviderProcessIds>,
    /// Which waiting messages open a run being started.
    pub(crate) openings: Arc<dyn OpeningMessages>,
    /// Continues an interrupted run once the provider kept nothing more for it.
    pub(crate) continuation: Arc<dyn InterruptedRunContinuation>,
}

/// What a withdraw ahead of a change found: the message is the queue's to change, or it stays
/// with its provider for the reason given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueueWithdrawal {
    /// Given back and still waiting: the queue's to change.
    Returned,
    /// Not the queue's to change.
    Unreturned(UnreturnedReason),
}

/// The interrupt's end writes for the messages waiting for its run.
#[cfg_attr(not(test), expect(dead_code, reason = "the run queue's interrupt end"))]
pub(crate) struct InterruptEndWrites {
    /// The row moves, committed with the run's end.
    pub(crate) statements: Vec<WriteStatement>,
    /// The item events, committed before the run's end event.
    pub(crate) preceding_events: Vec<SessionEventDraft>,
    /// The items the writes change, which the caller forgets (a cancel) and raises once they
    /// commit.
    pub(crate) changed: Vec<QueueItemRecord>,
    /// Whether no item event records the change (a placement), as `raise_committed` takes it.
    pub(crate) moves_order: bool,
}

/// Why the delivery could not read, resolve a driver or record a message's outcome; every cause
/// is kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DeliveryError {
    /// SQLite refused a read, or a stored value does not read as its type.
    #[error("the run queue's read failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("the run queue's read did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The run's driver was refused: the run has no binding, or no driver answers its provider.
    #[error("the run's provider driver could not be found")]
    Driver(#[source] DomainError),
    /// A message's outcome was not recorded.
    #[error("a queued message's outcome was not recorded")]
    Record(#[from] QueueRecordError),
}

// The state every clone of one delivery shares.
struct DeliveryShared {
    deps: QueueDeliveryDeps,
    state: Mutex<DeliveryState>,
}

/// Hands live runs their waiting messages, and takes them back ahead of a change. A cheap handle;
/// clones share one state.
#[derive(Clone)]
pub(crate) struct QueueDelivery {
    shared: Arc<DeliveryShared>,
}

impl QueueDelivery {
    /// A delivery over `deps`, holding nothing.
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's start"))]
    pub(crate) fn new(deps: QueueDeliveryDeps) -> Self {
        Self {
            shared: Arc::new(DeliveryShared {
                deps,
                state: Mutex::new(DeliveryState::default()),
            }),
        }
    }

    /// Takes `item`, just sent, into the live run `run_id`: kept for the next turn while the run
    /// waits on input with no credits choice held, else handed as [`QueueDelivery::hand_waiting`]
    /// does. Called under `hold`; fails as that does.
    #[expect(dead_code, reason = "the run queue's send path")]
    pub(crate) async fn accept_send(
        &self,
        hold: &KeyHold<'_, SessionId>,
        item: &QueueItemRecord,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        if let Some(run) = self.read_run(run_id).await? {
            let mut state = self.lock_state();
            if run.state == RunState::WaitingForInput
                && !state.credits_choice_runs.contains(&run_id)
            {
                state.next_turn_runs.insert(item.id, run_id);
                return Ok(());
            }
        }
        self.hand_waiting(hold, run_id).await
    }

    /// Hands `run_id` every lead message waiting for it not yet handed, in the queue's order,
    /// when its provider takes messages at once and the run takes them now; nothing while an
    /// interrupt holds the run. Called under `hold`, so the hands join the chain in call order.
    /// Fails when a read fails or the run's driver is refused.
    pub(crate) async fn hand_waiting(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let session_id = *hold.key();
        let Some(run) = self.read_run(run_id).await? else {
            return Ok(());
        };
        let driver = self.driver_of(run_id).await?;
        let handing = driver.message_handing();
        match handing.hands_at {
            HandMoment::AtOnce => {}
            HandMoment::AtToolBoundary => return Ok(()),
        }
        let takes_now = self.lock_state().takes_messages_now(run.state, run_id);
        if !takes_now || self.is_held_for_interrupt(run_id) {
            return Ok(());
        }
        let lead_waiting = self.lead_waiting(self.read_waiting(run_id).await?, false);
        let process_id = self.shared.deps.processes.process_id(&session_id);
        let mut state = self.lock_state();
        let items = state.unhanded_of(lead_waiting, false);
        if items.is_empty() {
            return Ok(());
        }
        state.mark_handed(&items, run_id, HandRoute::Driver(handing), process_id);
        let job = ChainJob::Hand {
            run_id,
            driver,
            items,
        };
        self.push_job(&mut state, session_id, job);
        Ok(())
    }

    /// Hands the driver every lead message waiting for the run at a tool boundary of its turn, in
    /// the queue's order, when its provider takes messages there and no interrupt holds the run.
    /// Takes the session lock itself. Fails when a read fails or the run's driver is refused.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) async fn on_tool_boundary(
        &self,
        boundary: RunToolBoundary,
    ) -> Result<(), DeliveryError> {
        let RunToolBoundary { session_id, run_id } = boundary;
        let _session_hold = self.shared.deps.session_lock.acquire(session_id).await;
        if self.is_held_for_interrupt(run_id) {
            return Ok(());
        }
        let driver = self.driver_of(run_id).await?;
        let handing = driver.message_handing();
        match handing.hands_at {
            HandMoment::AtToolBoundary => {}
            HandMoment::AtOnce => return Ok(()),
        }
        let lead_waiting = self.lead_waiting(self.read_waiting(run_id).await?, false);
        let process_id = self.shared.deps.processes.process_id(&session_id);
        let mut state = self.lock_state();
        let items = state.unhanded_of(lead_waiting, false);
        if items.is_empty() {
            return Ok(());
        }
        state.mark_handed(&items, run_id, HandRoute::Driver(handing), process_id);
        let job = ChainJob::ToolBoundary {
            run_id,
            driver,
            items,
        };
        self.push_job(&mut state, session_id, job);
        Ok(())
    }

    /// Takes `items` back from their provider ahead of a change to them, on the session's chain,
    /// within [`WITHDRAW_DEADLINE`], and says of each whether it is the queue's to change: waiting,
    /// not a starting run's opening, and given back. One the provider did not give back in time,
    /// or that the chain did not reach by then, reads not delivered. Called under `hold`; fails
    /// when a read or a write fails.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the run queue's edit, removal and reorder")
    )]
    pub(crate) async fn take_back(
        &self,
        hold: &KeyHold<'_, SessionId>,
        items: &[QueueItemRecord],
    ) -> Result<HashMap<QueueItemId, QueueWithdrawal>, DeliveryError> {
        let session_id = *hold.key();
        let openings = &self.shared.deps.openings;
        let candidates: Vec<QueueItemRecord> = items
            .iter()
            .filter(|item| {
                item.state == RecordedQueueItemState::Queued && !openings.is_opening(&item.id)
            })
            .cloned()
            .collect();
        let deadline = CancellationToken::new();
        let has_started = Arc::new(Mutex::new(false));
        let (reply_sender, mut reply) = oneshot::channel();
        let job = WithdrawJob {
            candidates: candidates.clone(),
            deadline: deadline.clone(),
            has_started: Arc::clone(&has_started),
            reply: reply_sender,
        };
        self.push(session_id, ChainJob::Withdraw(job));
        // A job the chain dropped unanswered was not reached either.
        let answered = match wait_within(Pin::new(&mut reply), WITHDRAW_DEADLINE, None).await {
            Some(answered) => answered.ok(),
            None => {
                let is_started = {
                    let is_started = lock_flag(&has_started);
                    deadline.cancel();
                    *is_started
                };
                // Started withdraws are bounded by the same deadline, so they answer at once.
                if is_started { reply.await.ok() } else { None }
            }
        };
        let withdrawals = match answered {
            Some(answer) => answer?,
            None => {
                for item in &candidates {
                    self.record_unreturned(item, "waited past the deadline behind earlier hands")
                        .await?;
                }
                candidates
                    .iter()
                    .map(|item| {
                        let reason = UnreturnedReason::NotDelivered;
                        (item.id, QueueWithdrawal::Unreturned(reason))
                    })
                    .collect()
            }
        };
        let returned: Vec<QueueItemId> = withdrawals
            .iter()
            .filter(|(_, withdrawal)| **withdrawal == QueueWithdrawal::Returned)
            .map(|(item_id, _)| *item_id)
            .collect();
        let still_waiting = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let items = QueueItemReader::new(reader);
                let mut still_waiting = HashSet::new();
                for item_id in returned {
                    if items
                        .get(&item_id)?
                        .is_some_and(|item| item.state == RecordedQueueItemState::Queued)
                    {
                        still_waiting.insert(item_id);
                    }
                }
                Ok::<_, DeliveryError>(still_waiting)
            })
            .await?;
        Ok(items
            .iter()
            .map(|item| {
                let withdrawal = match withdrawals.get(&item.id) {
                    Some(QueueWithdrawal::Returned) if still_waiting.contains(&item.id) => {
                        QueueWithdrawal::Returned
                    }
                    Some(QueueWithdrawal::Unreturned(reason)) => {
                        QueueWithdrawal::Unreturned(*reason)
                    }
                    Some(QueueWithdrawal::Returned) | None => {
                        QueueWithdrawal::Unreturned(UnreturnedReason::Taken)
                    }
                };
                (item.id, withdrawal)
            })
            .collect())
    }

    /// Settles a message the provider recorded as taken by `run_id`, on the session's chain:
    /// `message_id` is the provider's own, and one that is no queue item id is dropped.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) fn message_taken(&self, session_id: SessionId, message_id: &str, run_id: RunId) {
        let Ok(item_id) = QueueItemId::new(message_id) else {
            return;
        };
        self.push(session_id, ChainJob::MessageTaken { item_id, run_id });
    }

    /// Forgets the hand of each of `cancelled` the provider was handed, as the provider gave them
    /// back with an interrupt; each stays waiting. An id never handed is ignored.
    pub(crate) fn give_back(&self, cancelled: &[QueueItemId]) {
        let mut state = self.lock_state();
        for item_id in cancelled {
            state.handed.remove(item_id);
        }
    }

    /// The interrupt's end writes for the lead messages waiting for `run_id`, called on the
    /// session's chain: `cancelled` is given back first, then the messages not handed and not an
    /// opening (a starting run's opening goes with the rest) are cancelled for `ReturnToDraft`,
    /// placed with `deliver_first` first for `NextTurn`, and left for `KeepWaiting`. Writes nothing
    /// itself. Fails when a read fails or an event cannot be drafted.
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's interrupt end"))]
    pub(crate) async fn interrupt_end_writes(
        &self,
        run_id: RunId,
        pending: InterruptPendingChoice,
        deliver_first: Option<QueueItemId>,
        cancelled: &[QueueItemId],
    ) -> Result<InterruptEndWrites, DeliveryError> {
        self.give_back(cancelled);
        let (run, waiting) = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let run = RunStateReader::new(reader).read_run(&run_id)?;
                let waiting = QueueItemReader::new(reader).list_waiting_for_run(&run_id)?;
                Ok::<_, DeliveryError>((run, waiting))
            })
            .await?;
        let is_starting = run.is_some_and(|run| run.state == RunState::Starting);
        let lead_waiting = self.lead_waiting(waiting, is_starting);
        let kept: Vec<QueueItemRecord> = {
            let state = self.lock_state();
            lead_waiting
                .into_iter()
                .filter(|item| !state.handed.contains_key(&item.id))
                .collect()
        };
        let now = WireInstant::now();
        match pending {
            InterruptPendingChoice::ReturnToDraft => {
                let mut statements = Vec::with_capacity(kept.len());
                let mut preceding_events = Vec::with_capacity(kept.len());
                for item in &kept {
                    let (draft, statement) =
                        outcome_draft_of(item, &QueueItemOutcome::Canceled, &now)
                            .map_err(QueueRecordError::from)?;
                    statements.push(statement);
                    preceding_events.push(draft);
                }
                Ok(InterruptEndWrites {
                    statements,
                    preceding_events,
                    changed: kept,
                    moves_order: false,
                })
            }
            InterruptPendingChoice::NextTurn => {
                let (statements, changed) = match reordered_of(&kept, deliver_first) {
                    Some(ordered) => (placement_statements(&ordered, &now), ordered),
                    None => (Vec::new(), Vec::new()),
                };
                Ok(InterruptEndWrites {
                    statements,
                    preceding_events: Vec::new(),
                    changed,
                    moves_order: true,
                })
            }
            InterruptPendingChoice::KeepWaiting => Ok(InterruptEndWrites {
                statements: Vec::new(),
                preceding_events: Vec::new(),
                changed: Vec::new(),
                moves_order: false,
            }),
        }
    }

    /// Forgets that the provider was handed any of `item_ids` or that one waits for a next turn,
    /// once another's write moved them.
    #[expect(dead_code, reason = "the run queue's edit, removal and reorder")]
    pub(crate) fn forget(&self, item_ids: &[QueueItemId]) {
        let mut state = self.lock_state();
        for item_id in item_ids {
            state.handed.remove(item_id);
            state.next_turn_runs.remove(item_id);
        }
    }

    /// Settles once every job pushed on the session's chain before it has settled.
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's run lifecycle"))]
    pub(crate) async fn settle(&self, session_id: SessionId) {
        self.run_between_hands(session_id, async {}).await;
    }

    /// Runs `task` on the session's chain, once every job pushed before it has settled and before
    /// any pushed after it, so no message changes state while it reads and writes.
    pub(crate) async fn run_between_hands<Output>(
        &self,
        session_id: SessionId,
        task: impl Future<Output = Output>,
    ) -> Output {
        let (go_sender, go) = oneshot::channel();
        // The drain waits until this closes, when the task is done or its caller left.
        let (done, done_receiver) = oneshot::channel::<()>();
        self.push(
            session_id,
            ChainJob::Gate {
                go: go_sender,
                done: done_receiver,
            },
        );
        // A chain dropped with the runtime has nothing left to wait for.
        go.await.unwrap_or(());
        let output = task.await;
        drop(done);
        output
    }

    /// Holds back every hand to `run_id` until [`QueueDelivery::release_interrupt_hold`], and
    /// waits out a hand to it already inside its driver call, never the jobs queued on the chain.
    /// Called under `hold`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the run queue's interrupt hold")
    )]
    pub(crate) async fn hold_for_interrupt(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) {
        let in_flight = {
            let mut state = self.lock_state();
            state.interrupt_holds.insert(run_id);
            state
                .chains
                .get(hold.key())
                .map(SessionChain::follow_in_flight)
        };
        if let Some(mut in_flight) = in_flight {
            let settled = in_flight
                .wait_for(|in_flight| *in_flight != Some(run_id))
                .await;
            // A closed follow means the chain ended, with nothing in flight.
            drop(settled);
        }
    }

    /// Ends an interrupt's hold on `run_id`, answering whether one was held.
    #[expect(dead_code, reason = "the run queue's interrupt hold")]
    pub(crate) fn release_interrupt_hold(&self, run_id: RunId) -> bool {
        self.lock_state().interrupt_holds.remove(&run_id)
    }

    /// Whether an interrupt of `run_id` is under way.
    pub(crate) fn is_held_for_interrupt(&self, run_id: RunId) -> bool {
        self.lock_state().interrupt_holds.contains(&run_id)
    }

    /// Records whether the provider holds a credits choice on `run_id`, which a message settles.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) fn note_credits_choice(&self, run_id: RunId, is_held: bool) {
        let mut state = self.lock_state();
        if is_held {
            state.credits_choice_runs.insert(run_id);
        } else {
            state.credits_choice_runs.remove(&run_id);
        }
    }

    /// Settles what was handed to the ended run `run_id`: its credits choice, its next-turn marks
    /// and every hand but one the session's live provider process keeps go; the run's other
    /// waiting messages are left for the next run. Called after [`QueueDelivery::settle`].
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's run lifecycle"))]
    pub(crate) fn end_run(&self, session_id: SessionId, run_id: RunId) {
        let live_process_id = self.shared.deps.processes.process_id(&session_id);
        let mut state = self.lock_state();
        state.credits_choice_runs.remove(&run_id);
        state.handed.retain(|_, handed| {
            handed.run_id != run_id || is_kept_by_process(handed, live_process_id)
        });
        state
            .next_turn_runs
            .retain(|_, next_turn_run_id| *next_turn_run_id != run_id);
    }

    /// Forgets each message of `session_id` a provider process kept past its ended run when that
    /// process is no longer the session's, and answers those runs: each message stays waiting and
    /// goes with the person's next send, never on its own. Fails when a read fails.
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's run lifecycle"))]
    pub(crate) async fn forget_kept_by_gone_process(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<RunId>, DeliveryError> {
        let live_process_id = self.shared.deps.processes.process_id(&session_id);
        let kept_by_gone: Vec<(QueueItemId, u64, RunId)> = self
            .lock_state()
            .handed
            .iter()
            .filter(|(_, handed)| {
                let is_kept = match handed.route {
                    HandRoute::Driver(handing) => handing.kept_by_process,
                    HandRoute::Continue => false,
                };
                is_kept && !is_kept_by_process(handed, live_process_id)
            })
            .map(|(item_id, handed)| (*item_id, handed.hand_number, handed.run_id))
            .collect();
        if kept_by_gone.is_empty() {
            return Ok(Vec::new());
        }
        let of_ended_runs = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let items = QueueItemReader::new(reader);
                let runs = RunStateReader::new(reader);
                let mut of_ended_runs = Vec::new();
                for (item_id, hand_number, run_id) in kept_by_gone {
                    let is_session_item = items
                        .get(&item_id)?
                        .is_some_and(|item| item.session_id == session_id);
                    let has_run_ended = runs
                        .read_run(&run_id)?
                        .is_some_and(|run| run.state.is_terminal());
                    if is_session_item && has_run_ended {
                        of_ended_runs.push((item_id, hand_number, run_id));
                    }
                }
                Ok::<_, DeliveryError>(of_ended_runs)
            })
            .await?;
        let mut state = self.lock_state();
        let mut ended_run_ids = Vec::new();
        for (item_id, hand_number, run_id) in of_ended_runs {
            // A hand made since the snapshot is not the one read.
            let is_same_hand = state
                .handed
                .get(&item_id)
                .is_some_and(|handed| handed.hand_number == hand_number);
            if is_same_hand {
                state.handed.remove(&item_id);
                if !ended_run_ids.contains(&run_id) {
                    ended_run_ids.push(run_id);
                }
            }
        }
        Ok(ended_run_ids)
    }

    /// Whether the provider has been handed `item_id` and has not yet said what became of it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the run queue's interrupt end"))]
    pub(crate) fn is_handed(&self, item_id: &QueueItemId) -> bool {
        self.lock_state().handed.contains_key(item_id)
    }

    /// Whether the session's live provider process keeps a message handed for `run_id`, which it
    /// starts a turn of its own with.
    #[expect(dead_code, reason = "the run queue's run lifecycle")]
    pub(crate) fn is_message_kept_for_run(&self, session_id: SessionId, run_id: RunId) -> bool {
        let live_process_id = self.shared.deps.processes.process_id(&session_id);
        self.lock_state()
            .handed
            .values()
            .any(|handed| handed.run_id == run_id && is_kept_by_process(handed, live_process_id))
    }

    // The delivery's state. No holder awaits or panics while it changes the state, so a poisoned
    // lock still guards a whole state.
    fn lock_state(&self) -> MutexGuard<'_, DeliveryState> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn forget_hand(&self, item_id: QueueItemId) {
        self.lock_state().handed.remove(&item_id);
    }

    async fn read_run(&self, run_id: RunId) -> Result<Option<RunRead>, DeliveryError> {
        read_run_through(&self.shared.deps.pool, run_id).await
    }

    async fn read_item(
        &self,
        item_id: QueueItemId,
    ) -> Result<Option<QueueItemRecord>, DeliveryError> {
        self.shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, DeliveryError>(QueueItemReader::new(reader).get(&item_id)?)
            })
            .await
    }

    async fn read_waiting(&self, run_id: RunId) -> Result<Vec<QueueItemRecord>, DeliveryError> {
        self.shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let waiting = QueueItemReader::new(reader).list_waiting_for_run(&run_id)?;
                Ok::<_, DeliveryError>(waiting)
            })
            .await
    }

    // The driver of the provider `run_id` is bound to.
    async fn driver_of(&self, run_id: RunId) -> Result<Arc<dyn ProviderDriver>, DeliveryError> {
        let bound = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, DeliveryError>(read_run_provider(reader, &run_id)?)
            })
            .await?;
        let resolved = resolve_run_driver(&self.shared.deps.providers, run_id, bound)
            .map_err(DeliveryError::Driver)?;
        Ok(resolved.driver)
    }

    // The lead's messages among `waiting`, a child's steer box delivering the child's own, less
    // the openings of runs being started unless `keeps_openings`.
    fn lead_waiting(
        &self,
        waiting: Vec<QueueItemRecord>,
        keeps_openings: bool,
    ) -> Vec<QueueItemRecord> {
        let openings = &self.shared.deps.openings;
        waiting
            .into_iter()
            .filter(|item| {
                item.child_handle.is_none() && (keeps_openings || !openings.is_opening(&item.id))
            })
            .collect()
    }

    // Records `item` admitted into `run_id`. The hand is forgotten once the write lands or fails:
    // until then the message still reads waiting, and a hand in between would send it again.
    async fn record_admission(
        &self,
        item: &QueueItemRecord,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let admitted = self
            .shared
            .deps
            .recorder
            .record_outcome(
                item,
                QueueItemOutcome::Admitted { run_id },
                &WireInstant::now(),
            )
            .await;
        self.forget_hand(item.id);
        Ok(admitted?)
    }

    // Records `item` not delivered, its delivery failed.
    async fn record_failed(&self, item: &QueueItemRecord) -> Result<(), DeliveryError> {
        let outcome = QueueItemOutcome::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed,
        };
        self.shared
            .deps
            .recorder
            .record_outcome(item, outcome, &WireInstant::now())
            .await?;
        Ok(())
    }

    // A handed message its provider did not give back: whether it reaches the agent is unknown, so
    // while it still waits it reads not delivered and can be sent again.
    async fn record_unreturned(
        &self,
        item: &QueueItemRecord,
        what: &str,
    ) -> Result<(), DeliveryError> {
        tracing::warn!(
            session_id = %item.session_id,
            queue_item_id = %item.id,
            "the withdraw of a queued message {what}"
        );
        let is_waiting = self
            .read_item(item.id)
            .await?
            .is_some_and(|current| current.state == RecordedQueueItemState::Queued);
        if is_waiting {
            self.record_failed(item).await?;
        }
        Ok(())
    }

    // The unhanded lead messages waiting for `run_id`, a continue that did not go read again, each
    // marked handed by the continue, in the queue's order.
    async fn read_continued(&self, run_id: RunId) -> Result<Vec<WaitingMessage>, DeliveryError> {
        let lead_waiting = self.lead_waiting(self.read_waiting(run_id).await?, false);
        let Some(session_id) = lead_waiting.first().map(|item| item.session_id) else {
            return Ok(Vec::new());
        };
        let process_id = self.shared.deps.processes.process_id(&session_id);
        let items = {
            let mut state = self.lock_state();
            let items = state.unhanded_of(lead_waiting, true);
            state.mark_handed(&items, run_id, HandRoute::Continue, process_id);
            items
        };
        Ok(items
            .into_iter()
            .map(|item| WaitingMessage {
                id: item.id,
                attachments: attachments_of(&item.body),
                skills: item.body.skills.unwrap_or_default(),
                content: item.body.content,
            })
            .collect())
    }

    // The ids of the messages the continue of `run_id` holds.
    fn continued_of(&self, run_id: RunId) -> Vec<QueueItemId> {
        self.lock_state()
            .handed
            .iter()
            .filter(|(_, handed)| {
                handed.run_id == run_id && matches!(handed.route, HandRoute::Continue)
            })
            .map(|(item_id, _)| *item_id)
            .collect()
    }

    async fn admit_continued(&self, run_id: RunId) -> Result<(), DeliveryError> {
        for item_id in self.continued_of(run_id) {
            if let Some(item) = self.read_item(item_id).await? {
                self.record_admission(&item, run_id).await?;
            }
        }
        Ok(())
    }
}

impl ContinuedMessages for QueueDelivery {
    fn read(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>> {
        Box::pin(async move { Ok(self.read_continued(run_id).await?) })
    }

    fn admit(
        &self,
        _session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        Box::pin(async move { Ok(self.admit_continued(run_id).await?) })
    }

    fn release(
        &self,
        _session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.lock_state().handed.retain(|_, handed| {
            handed.run_id != run_id || !matches!(handed.route, HandRoute::Continue)
        });
        Box::pin(async { Ok(()) })
    }
}

// The steer that hands `item` to `run_id`, at the run version `run_version` the queue read.
fn steer_of(item: &QueueItemRecord, run_id: RunId, run_version: i64) -> ApplyInterventionParams {
    ApplyInterventionParams::Steer {
        target_run_id: run_id,
        expected_run_version: safe_run_version(run_version),
        client_idempotency_key: item.id,
        payload: SteerPayload {
            content: item.body.content.clone(),
            attachments: attachments_of(&item.body),
            skills: item.body.skills.clone().unwrap_or_default(),
            expected_turn_id: None,
        },
    }
}

fn attachments_of(body: &QueueItemBody) -> Vec<ArtifactId> {
    body.attachments
        .as_ref()
        .map(|attachments| attachments.0.clone())
        .unwrap_or_default()
}

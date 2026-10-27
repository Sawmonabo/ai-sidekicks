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
//! that process runs; once it is gone, the message waits for the person's next send, unless a
//! resume sent it, whose record then says what became of it. While an
//! interrupt of a run is under way nothing more is handed to it. Every hand, withdraw and settle
//! of a session's messages runs on one chain per session, so they reach the driver in the order
//! the queue decided them.

mod chain;
mod continued;
mod state;
#[cfg(test)]
mod tests;
mod withdraw;

use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;

use crate::delivery::chain::{ChainJob, SessionChain};
use crate::delivery::state::{DeliveryState, HandRoute, is_kept_by_process};
use crate::recorder::{QueueRecordError, QueueRecorder, outcome_draft_of};
use crate::refusals::UnreturnedReason;
use crate::session_lock::QueueSessionLock;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{
    ApplyInterventionParams, InterruptPendingChoice, RunToolBoundary, SteerPayload,
};
use sidekicks_provider::process_identity::{ProviderProcessIdentity, ProviderProcessIds};
use sidekicks_session::driver_resolution::{LiveRunDriverError, read_run_driver};
use sidekicks_session::queue_store::{
    QueueItemOutcome, QueueItemReader, QueueItemRecord, placement_statements,
};
use sidekicks_session::run::read::{RunRead, RunStateReader, read_run_through, safe_run_version};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraft;

/// How long a change waits for a provider to give its handed messages back.
pub(crate) const WITHDRAW_DEADLINE: Duration = Duration::from_secs(10);

/// Which waiting messages open a run whose driver is being started.
pub(crate) trait OpeningMessages: Send + Sync {
    /// Whether the waiting message `item` opens the run it waits for, whose driver is being
    /// started, which that start delivers.
    fn is_opening(&self, item: &QueueItemRecord) -> bool;
}

/// Continues an interrupted run with the messages waiting for it.
pub(crate) trait InterruptedRunContinuation: Send + Sync {
    /// Called off the session lock once the last message the provider kept for `run_id` was taken.
    fn continue_interrupted_run(&self, session_id: SessionId, run_id: RunId);
}

/// What the delivery reads, writes and calls.
pub(crate) struct QueueDeliveryDeps {
    /// The read pool every queue and run read goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Records each message's outcome.
    pub(crate) recorder: Arc<QueueRecorder>,
    /// The drivers, found by the provider a run is bound to.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The queue's own per-session lock, never the session append lock: a withdraw waits under it.
    pub(crate) session_lock: Arc<QueueSessionLock>,
    /// The identity of each session's provider process.
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

/// What one interrupt's release did to its run's hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterruptHoldRelease {
    /// The interrupt held nothing: it was released before, or never held.
    NotHeld,
    /// Another interrupt still holds the run.
    StillHeld,
    /// The run's last hold went; its messages may be handed again.
    Released,
}

/// The interrupt's end writes for the messages waiting for its run.
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
pub enum DeliveryError {
    /// SQLite refused a read, or a stored value does not read as its type.
    #[error("the run queue's read failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("the run queue's read did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The run's driver was not resolved: the run has no binding, or no driver answers its
    /// provider.
    #[error("the run's provider driver could not be found")]
    Driver(#[from] LiveRunDriverError),
    /// A message's outcome was not recorded.
    #[error("a queued message's outcome was not recorded")]
    Record(#[from] QueueRecordError),
}

// The state every clone of one delivery shares, and the tasks it runs on its own: each chain's
// drain, a tool boundary's hand and a withdraw's late answer.
struct DeliveryShared {
    deps: QueueDeliveryDeps,
    state: Mutex<DeliveryState>,
    tasks: TaskTracker,
}

/// Hands live runs their waiting messages, and takes them back ahead of a change. A cheap handle;
/// clones share one state.
#[derive(Clone)]
pub struct QueueDelivery {
    shared: Arc<DeliveryShared>,
}

impl QueueDelivery {
    /// A delivery over `deps`, holding nothing.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start, which builds the run queue")
    )]
    pub(crate) fn new(deps: QueueDeliveryDeps) -> Self {
        Self {
            shared: Arc::new(DeliveryShared {
                deps,
                state: Mutex::new(DeliveryState::default()),
                tasks: TaskTracker::new(),
            }),
        }
    }

    /// Takes `item`, just sent, into the live run `run_id`: kept for the next turn while the run
    /// waits on input with no credits choice held, else handed as [`QueueDelivery::hand_waiting`]
    /// does. Called under `hold`; fails as that does.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start, which builds the run queue")
    )]
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
    /// interrupt holds the run. A message a person sent now goes first, marked priority, so the
    /// provider reads it ahead of what it holds. Called under `hold`, so the hands join the chain
    /// in call order. Fails when a read fails or the run's driver is refused.
    pub(crate) async fn hand_waiting(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), DeliveryError> {
        let Some(run) = self.read_run(run_id).await? else {
            return Ok(());
        };
        let driver = read_run_driver::<DeliveryError>(
            &self.shared.deps.pool,
            &self.shared.deps.providers,
            run_id,
        )
        .await?;
        let handing = driver.message_handing();
        let session_id = *hold.key();
        let process = self.shared.deps.processes.process_identity(&session_id);
        let (lead_waiting, mut state) = self.waiting_to_hand(Some(&run), run_id, handing).await?;
        self.push_waiting_hands(
            &mut state,
            session_id,
            run_id,
            &driver,
            lead_waiting,
            process,
        );
        Ok(())
    }

    /// Hands `item`, waiting for `run_id` and taken back from the provider, to the run marked
    /// priority, so the provider reads it ahead of what it holds, then every other lead message
    /// waiting for the run, in the queue's order, as [`QueueDelivery::hand_waiting`] does. Called
    /// under `hold`, so the priority hand joins the chain first. Fails when a read fails or the
    /// run's driver is refused.
    pub(crate) async fn hand_first(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        item: QueueItemRecord,
    ) -> Result<(), DeliveryError> {
        let session_id = *hold.key();
        let driver = read_run_driver::<DeliveryError>(
            &self.shared.deps.pool,
            &self.shared.deps.providers,
            run_id,
        )
        .await?;
        let handing = driver.message_handing();
        let run = self.read_run(run_id).await?;
        let process = self.shared.deps.processes.process_identity(&session_id);
        // Both hands join the chain under one hold of the state, so the priority hand's end, a
        // steer whose turn ended among them, cannot free the message for the rest's hand to send.
        let (lead_waiting, mut state) = self.waiting_to_hand(run.as_ref(), run_id, handing).await?;
        let items = vec![item];
        state.mark_handed(&items, run_id, HandRoute::Driver(handing), process);
        let job = ChainJob::Hand {
            run_id,
            driver: Arc::clone(&driver),
            items,
            is_priority: true,
        };
        self.push_job(&mut state, session_id, job);
        self.push_waiting_hands(
            &mut state,
            session_id,
            run_id,
            &driver,
            lead_waiting,
            process,
        );
        Ok(())
    }

    /// Hands the driver every lead message waiting for the run at a tool boundary of its turn, in
    /// the queue's order, when its provider takes messages there and no interrupt holds the run.
    /// Answers once the run's driver is read: the hand runs on a task of its own under the session
    /// lock, so the caller, the provider's event reader, never waits on a hand or the lock. Fails
    /// when the read of the run's driver fails or the driver is refused.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn on_tool_boundary(
        &self,
        boundary: RunToolBoundary,
    ) -> Result<(), DeliveryError> {
        let RunToolBoundary { session_id, run_id } = boundary;
        let driver = read_run_driver::<DeliveryError>(
            &self.shared.deps.pool,
            &self.shared.deps.providers,
            run_id,
        )
        .await?;
        let handing = driver.message_handing();
        match handing.hands_at {
            HandMoment::AtToolBoundary => {}
            HandMoment::AtOnce => return Ok(()),
        }
        let delivery = self.clone();
        self.shared.tasks.spawn(
            async move {
                let hold = delivery
                    .shared
                    .deps
                    .session_lock
                    .hold_session(session_id)
                    .await;
                let handed = delivery
                    .hand_at_boundary(&hold, run_id, driver, handing)
                    .await;
                if let Err(error) = handed {
                    tracing::error!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &error as &(dyn Error + 'static),
                        "the messages waiting for a tool boundary could not be handed"
                    );
                }
            }
            .instrument(tracing::Span::current()),
        );
        Ok(())
    }

    // Pushes the boundary's steer of every lead message waiting for `run_id` and not yet handed,
    // under `hold`, unless an interrupt holds the run.
    async fn hand_at_boundary(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        driver: Arc<dyn ProviderDriver>,
        handing: MessageHanding,
    ) -> Result<(), DeliveryError> {
        let session_id = *hold.key();
        if self.is_held_for_interrupt(run_id) {
            return Ok(());
        }
        let process = self.shared.deps.processes.process_identity(&session_id);
        let (lead_waiting, mut state) = self.lead_waiting_under_lock(run_id).await?;
        let items = state.unhanded_of(lead_waiting, false);
        if items.is_empty() {
            return Ok(());
        }
        state.mark_handed(&items, run_id, HandRoute::Driver(handing), process);
        let job = ChainJob::ToolBoundary {
            run_id,
            driver,
            items,
        };
        self.push_job(&mut state, session_id, job);
        Ok(())
    }

    // Forgets the hand of each of `cancelled` the provider was handed, as the provider gave them
    // back with an interrupt; each stays waiting. An id never handed is ignored.
    fn give_back(&self, cancelled: &[QueueItemId]) {
        let mut state = self.lock_state();
        for item_id in cancelled {
            state.forget_hand(item_id);
        }
    }

    /// The interrupt's end writes for the lead messages waiting for `run_id`, called on the
    /// session's chain: `cancelled` is given back first, then the messages not handed and not an
    /// opening (a starting run's opening goes with the rest) are cancelled for `ReturnToDraft`,
    /// placed with `deliver_first` first for `NextTurn`, and left for `KeepWaiting`. Writes nothing
    /// itself. Fails when a read fails or an event cannot be drafted.
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
                .filter(|item| state.hand_of(&item.id).is_none())
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
    pub(crate) fn forget(&self, item_ids: &[QueueItemId]) {
        let mut state = self.lock_state();
        for item_id in item_ids {
            state.forget_hand(item_id);
            state.next_turn_runs.remove(item_id);
        }
    }

    /// Settles once every job pushed on the session's chain before it has settled.
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

    /// Holds back every hand to `run_id` for the interrupt `intervention_id` until its
    /// [`QueueDelivery::release_interrupt_hold`], a tool boundary's included, and waits out a hand
    /// to it already inside its driver call, never the jobs queued on the chain. Called under
    /// `hold`.
    pub(crate) async fn hold_for_interrupt(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        intervention_id: InterventionId,
    ) {
        let in_flight = {
            let mut state = self.lock_state();
            state
                .interrupt_holds
                .entry(run_id)
                .or_default()
                .insert(intervention_id);
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

    /// Ends the hold the interrupt `intervention_id` took on `run_id`, answering what became of
    /// the run's hold; a second release of one interrupt changes nothing.
    pub(crate) fn release_interrupt_hold(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
    ) -> InterruptHoldRelease {
        let mut state = self.lock_state();
        let Some(holders) = state.interrupt_holds.get_mut(&run_id) else {
            return InterruptHoldRelease::NotHeld;
        };
        if !holders.remove(&intervention_id) {
            return InterruptHoldRelease::NotHeld;
        }
        if !holders.is_empty() {
            return InterruptHoldRelease::StillHeld;
        }
        state.interrupt_holds.remove(&run_id);
        InterruptHoldRelease::Released
    }

    /// Whether an interrupt of `run_id` is under way.
    pub(crate) fn is_held_for_interrupt(&self, run_id: RunId) -> bool {
        self.lock_state().interrupt_holds.contains_key(&run_id)
    }

    /// Records whether the provider holds a credits choice on `run_id`, which a message settles.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start, which builds the run queue")
    )]
    pub(crate) fn note_credits_choice(&self, run_id: RunId, is_held: bool) {
        let mut state = self.lock_state();
        if is_held {
            state.credits_choice_runs.insert(run_id);
        } else {
            state.credits_choice_runs.remove(&run_id);
        }
    }

    /// Settles what was handed to the ended run `run_id`: its credits choice, its next-turn marks
    /// and every hand go, but one the session's live provider process keeps and one a resume kept,
    /// which waits for the provider's word or, once no live process holds it, its record; the
    /// run's other waiting messages are left for the next run. Called after
    /// [`QueueDelivery::settle`].
    pub(crate) fn end_run(&self, session_id: SessionId, run_id: RunId) {
        let live_process = self.shared.deps.processes.process_identity(&session_id);
        let mut state = self.lock_state();
        state.credits_choice_runs.remove(&run_id);
        state.retain_hands(|handed| {
            handed.run_id != run_id
                || is_kept_by_process(handed, live_process)
                || matches!(handed.route, HandRoute::Continue { is_kept: true, .. })
        });
        state
            .next_turn_runs
            .retain(|_, next_turn_run_id| *next_turn_run_id != run_id);
    }

    /// Forgets each message of `session_id` a provider process kept past its ended run when that
    /// process is no longer the session's, and answers those runs: each message stays waiting and
    /// goes with the person's next send, never on its own. Fails when a read fails.
    pub(crate) async fn forget_kept_by_gone_process(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<RunId>, DeliveryError> {
        let live_process = self.shared.deps.processes.process_identity(&session_id);
        let kept_by_gone: Vec<(QueueItemId, u64, RunId)> = self
            .lock_state()
            .hands()
            .filter(|(_, handed)| {
                let is_kept = match handed.route {
                    HandRoute::Driver(handing) => handing.kept_by_process,
                    HandRoute::Continue { .. } => false,
                };
                is_kept && !is_kept_by_process(handed, live_process)
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
                .hand_of(&item_id)
                .is_some_and(|handed| handed.hand_number == hand_number);
            if is_same_hand {
                state.forget_hand(&item_id);
                if !ended_run_ids.contains(&run_id) {
                    ended_run_ids.push(run_id);
                }
            }
        }
        Ok(ended_run_ids)
    }

    /// Whether the provider has been handed `item_id` and has not yet said what became of it.
    pub(crate) fn is_handed(&self, item_id: &QueueItemId) -> bool {
        self.lock_state().hand_of(item_id).is_some()
    }

    /// Whether the session's live provider process keeps a message handed for `run_id`, which it
    /// starts a turn of its own with.
    pub(crate) fn is_message_kept_for_run(&self, session_id: SessionId, run_id: RunId) -> bool {
        let live_process = self.shared.deps.processes.process_identity(&session_id);
        self.lock_state()
            .hands()
            .any(|(_, handed)| handed.run_id == run_id && is_kept_by_process(handed, live_process))
    }

    /// Marks the delivery stopping, so [`QueueDelivery::wait`] answers once no task of its own
    /// runs; a task started after still counts.
    pub(crate) fn close(&self) {
        self.shared.tasks.close();
    }

    /// Waits, once closed, for every task the delivery runs on its own: each chain's drain, so a
    /// hand in flight finishes or fails before it answers.
    pub(crate) async fn wait(&self) {
        self.shared.tasks.wait().await;
    }

    /// Whether no task of the delivery's own runs.
    pub(crate) fn is_idle(&self) -> bool {
        self.shared.tasks.is_empty()
    }

    // The delivery's state. No holder awaits or panics while it changes the state, so a poisoned
    // lock still guards a whole state.
    fn lock_state(&self) -> MutexGuard<'_, DeliveryState> {
        lock(&self.shared.state)
    }

    fn forget_hand(&self, item_id: QueueItemId) {
        self.lock_state().forget_hand(&item_id);
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

    // The lead messages waiting for `run_id` that a hand sends now, in the queue's order, beside
    // the state locked to hand them: none when its provider takes them only at a tool boundary,
    // the run is gone or takes none now, or an interrupt holds it.
    async fn waiting_to_hand(
        &self,
        run: Option<&RunRead>,
        run_id: RunId,
        handing: MessageHanding,
    ) -> Result<(Vec<QueueItemRecord>, MutexGuard<'_, DeliveryState>), DeliveryError> {
        let takes_now = match handing.hands_at {
            HandMoment::AtOnce => run.is_some_and(|run| {
                let state = self.lock_state();
                state.takes_messages_now(run.state, run_id)
                    && !state.interrupt_holds.contains_key(&run_id)
            }),
            HandMoment::AtToolBoundary => false,
        };
        if !takes_now {
            return Ok((Vec::new(), self.lock_state()));
        }
        self.lead_waiting_under_lock(run_id).await
    }

    // The lead messages waiting for `run_id`, in the queue's order, beside the state locked to
    // hand them. A hand forgotten between the read and the lock may have settled a message the
    // read saw waiting, which a hand would then send again, so the read goes again.
    async fn lead_waiting_under_lock(
        &self,
        run_id: RunId,
    ) -> Result<(Vec<QueueItemRecord>, MutexGuard<'_, DeliveryState>), DeliveryError> {
        loop {
            let forgotten = self.lock_state().forgotten_hands();
            let lead_waiting = self.lead_waiting(self.read_waiting(run_id).await?, false);
            let state = self.lock_state();
            if state.forgotten_hands() == forgotten {
                return Ok((lead_waiting, state));
            }
        }
    }

    // Joins the chain with the hands of `lead_waiting` not yet handed: a message sent now first,
    // marked priority, then the rest.
    fn push_waiting_hands(
        &self,
        state: &mut DeliveryState,
        session_id: SessionId,
        run_id: RunId,
        driver: &Arc<dyn ProviderDriver>,
        lead_waiting: Vec<QueueItemRecord>,
        process: Option<ProviderProcessIdentity>,
    ) {
        let handing = driver.message_handing();
        let (sent_now, rest): (Vec<_>, Vec<_>) = state
            .unhanded_of(lead_waiting, false)
            .into_iter()
            .partition(|item| item.sent_now_id.is_some());
        for (items, is_priority) in [(sent_now, true), (rest, false)] {
            if items.is_empty() {
                continue;
            }
            state.mark_handed(&items, run_id, HandRoute::Driver(handing), process);
            let job = ChainJob::Hand {
                run_id,
                driver: Arc::clone(driver),
                items,
                is_priority,
            };
            self.push_job(state, session_id, job);
        }
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
                item.child_handle.is_none() && (keeps_openings || !openings.is_opening(item))
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
            reason: QueueItemNotDeliveredReason::Failed {},
        };
        self.shared
            .deps
            .recorder
            .record_outcome(item, outcome, &WireInstant::now())
            .await?;
        Ok(())
    }
}

/// `waiting` with the item `deliver_first` names moved ahead of the rest, which keep their order;
/// `None` when it names none of them.
pub(crate) fn reordered_of(
    waiting: &[QueueItemRecord],
    deliver_first: Option<QueueItemId>,
) -> Option<Vec<QueueItemRecord>> {
    let first_id = deliver_first?;
    let first = waiting.iter().find(|item| item.id == first_id)?;
    let mut ordered = vec![first.clone()];
    ordered.extend(waiting.iter().filter(|item| item.id != first_id).cloned());
    Some(ordered)
}

// The steer that hands `item` to `run_id`, at the run version `run_version` the queue read; one
// `is_priority` the provider reads ahead of what it holds.
fn steer_of(
    item: &QueueItemRecord,
    run_id: RunId,
    run_version: i64,
    is_priority: bool,
) -> ApplyInterventionParams {
    ApplyInterventionParams::Steer {
        target_run_id: run_id,
        expected_run_version: safe_run_version(run_version),
        client_idempotency_key: item.id,
        payload: SteerPayload {
            content: item.body.content.clone(),
            attachments: item.body.attachment_ids(),
            skills: item.body.skills.clone().unwrap_or_default(),
            expected_turn_id: None,
            is_priority,
        },
    }
}

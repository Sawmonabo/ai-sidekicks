//! Keeps the queue's places at the memory gate and its waiting messages in step with each run's
//! state, from the session log's committed events. A follower notes each change per session, the
//! newest change of a run replacing an older one not yet applied, and one drain task per session
//! applies them in turn: every action keys on the state the run is in now, so the coalesced change
//! decides as the whole series would.
//!
//! A run waiting on a person gives its place up and takes it again when it runs; a run that runs
//! is handed what waits for it. At a run's end its place is released, and the lead's messages still
//! waiting for it, but those the provider's live process keeps for its next turn, become the next
//! run's, or go into the lead run another start made live meanwhile. A run a person interrupted
//! keeps its messages instead and is continued with them, its place parked while its process
//! lives; one interrupted at a limit rests with them waiting until a send continues it. A newer
//! lead run whose start failed before it ran leaves the interrupted run before it current, which
//! rests again and takes the newer run's messages. An end seen while an interrupt of the run is
//! under way waits for the interrupt's choice; the messages an end moved on stay the interrupt's to
//! decide until the run they went to ends. The messages a resume kept are settled from the
//! provider's record at the run's end and at its process's end, an unanswered read retried at the
//! next of these. The lifecycle never takes the queue's session lock from under a holder: a settle
//! a holder starts runs on the session's drain.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};

use rusqlite::OptionalExtension as _;
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemState};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::ports::ProcessGoneListener;
use sidekicks_provider::port::run_pause::ContinuedMessages;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord};
use sidekicks_session::run::pause::{RunPauseControl, RunPauseError};
use sidekicks_session::run::read::read_run_through;
use sidekicks_session::run::stored_state_change::{
    StoredRunStateChange, read_stored_run_state_change,
};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::events::session::followers::CommittedEvent;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;

use crate::admission::QueueAdmission;
use crate::delivery::{InterruptedRunContinuation, QueueDelivery};
use crate::error::QueueError;
use crate::memory_gate::MemoryGate;
use crate::provider_session::ProviderSessions;
use crate::recorder::QueueRecorder;
use crate::session_lock::QueueSessionLock;

mod ends;
#[cfg(test)]
mod tests;

// The trigger of the newest interrupted end of a run; a person's interrupt stores none.
static SELECT_INTERRUPT_TRIGGER_SQL: LazyLock<String> = LazyLock::new(|| {
    let interrupted = SessionEventType::AgentRunInterrupted;
    format!(
        "SELECT json_extract(payload, '$.trigger') FROM session_events
  WHERE session_id = ? AND run_id = ? AND category = '{}' AND type = '{}'
  ORDER BY sequence DESC LIMIT 1",
        interrupted.category().as_str(),
        interrupted.as_str()
    )
});

/// What the run lifecycle reads, writes and calls.
pub(crate) struct QueueRunLifecycleDeps {
    /// The read pool every queue and run read goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Moves an ended run's messages on.
    pub(crate) recorder: Arc<QueueRecorder>,
    /// Starts, continues, parks and releases runs at the memory gate.
    pub(crate) admission: Arc<QueueAdmission>,
    /// Hands live runs their messages and settles an ended run's hands.
    pub(crate) delivery: QueueDelivery,
    /// Forgets a closed session's provider session.
    pub(crate) provider_sessions: Arc<ProviderSessions>,
    /// Weighed again at each run state change.
    pub(crate) memory_gate: Arc<MemoryGate>,
    /// Settles the messages a resume kept, from the provider's record.
    pub(crate) pauses: Arc<RunPauseControl>,
    /// The queue's own per-session lock.
    pub(crate) session_lock: Arc<QueueSessionLock>,
}

// The lead's messages an ended run's end moved on, and the session and run they went to.
struct MovedLeftovers {
    session_id: SessionId,
    to_run_id: RunId,
    item_ids: Vec<QueueItemId>,
}

// What a session's drain still has to apply, in the order it applies it.
#[derive(Default)]
struct PendingWork {
    // The newest change of each run, in the order the runs first changed.
    changes: Vec<StoredRunStateChange>,
    // Runs whose waiting messages a change left for a run that takes no more.
    ended_runs: Vec<RunId>,
    // Runs whose resumes' kept messages a settle under the lock left for the drain to read.
    kept_settles: Vec<RunId>,
    // Interrupted runs the provider kept nothing more for, continued under the lock.
    continues: Vec<RunId>,
    // The session's provider process is gone.
    is_process_gone: bool,
    // The session closed: what the queue kept for it is forgotten after everything before it.
    is_closed: bool,
    // The session's waiting messages are read again from the record, once for each caller
    // waiting on the outcome.
    reconciles: Vec<oneshot::Sender<Result<(), QueueError>>>,
}

// The lifecycle's state across its drains.
#[derive(Default)]
struct LifecycleState {
    pending: HashMap<SessionId, PendingWork>,
    draining: HashSet<SessionId>,
    // Each session's runs whose end was seen while an interrupt of them was under way, until that
    // end is settled.
    ends_awaiting_interrupt: HashMap<SessionId, HashSet<RunId>>,
    // Each session's interrupted lead run whose end is settled, which a continue may take on.
    resting_run_by_session: HashMap<SessionId, RunId>,
    // What each ended run's end moved on, until the run they went to ends.
    moved_leftovers_by_run: HashMap<RunId, MovedLeftovers>,
    // Each session's resting run whose continue was under way when a newer lead run superseded
    // it, until a run's end has waited for that continue.
    superseded_continue_by_session: HashMap<SessionId, RunId>,
    // Each session's runs whose resumes kept messages no settle has read the record of yet.
    kept_unsettled: HashMap<SessionId, HashSet<RunId>>,
}

/// Keeps the queue's places and waiting messages in step with each run's state. A failure of the
/// work it runs on its own is written to the service log.
pub(crate) struct QueueRunLifecycle {
    deps: QueueRunLifecycleDeps,
    state: Mutex<LifecycleState>,
    tasks: TaskTracker,
}

impl QueueRunLifecycle {
    /// A lifecycle over `deps`, following nothing yet.
    pub(crate) fn new(deps: QueueRunLifecycleDeps) -> Self {
        Self {
            deps,
            state: Mutex::new(LifecycleState::default()),
            tasks: TaskTracker::new(),
        }
    }

    /// Takes one committed session event, as the event log's every-session follow delivers it: a
    /// run state change and a session's close go to the session's drain, where the close forgets
    /// what the queue kept for the session after every change committed before it, and a credits
    /// choice is noted at once. Fails when a run state change or a
    /// credits choice does not read as its type.
    pub(crate) fn observe(
        self: &Arc<Self>,
        event: &CommittedEvent,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let envelope = &event.envelope;
        let session_id = envelope.session_id();
        let event_type = envelope.event_type();
        if let Some(change) = read_stored_run_state_change(event_type.as_str(), envelope.payload())?
        {
            self.deps.memory_gate.weigh();
            self.schedule(session_id, |work| {
                let run_id = *change.run_id();
                match work
                    .changes
                    .iter_mut()
                    .find(|noted| *noted.run_id() == run_id)
                {
                    Some(noted) => *noted = change,
                    None => work.changes.push(change),
                }
            });
            return Ok(());
        }
        if event_type == SessionEventType::SessionClosed {
            self.schedule(session_id, |work| work.is_closed = true);
            return Ok(());
        }
        let is_held = if event_type == SessionEventType::AgentRunUsageCreditsChoiceRequested {
            true
        } else if event_type == SessionEventType::AgentRunUsageCreditsChoiceResolved {
            false
        } else {
            return Ok(());
        };
        let run_id = match envelope.payload().get("runId") {
            Some(Value::String(text)) => RunId::new(text)?,
            _ => return Err("a credits choice's payload names no run".into()),
        };
        self.deps.delivery.note_credits_choice(run_id, is_held);
        Ok(())
    }

    /// Moves on what waits for runs of the session that ended while its provider process kept a
    /// message for them, once that process is gone, as at their end, and settles the messages
    /// their resumes kept from the provider's record.
    pub(crate) fn on_process_gone(self: &Arc<Self>, session_id: SessionId) {
        self.schedule(session_id, |work| work.is_process_gone = true);
    }

    /// Moves on what waits for `run_id` as at its end, once a change took back a message the
    /// provider kept past that end and left it waiting for a run that takes no more. A run still
    /// live, and an interrupted one resting for its continue, keep theirs.
    pub(crate) fn settle_ended_run(self: &Arc<Self>, session_id: SessionId, run_id: RunId) {
        self.schedule(session_id, |work| work.ended_runs.push(run_id));
    }

    /// Reads the session's waiting messages again from the record, after its drain's earlier
    /// work: a run they wait for that ended is ended as at its end, a queued run no start holds is
    /// started, and a live run is handed what waits for it. The receiver answers how the read went;
    /// it closes unanswered only when the drain panicked.
    pub(crate) fn reconcile(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> oneshot::Receiver<Result<(), QueueError>> {
        let (reconciled, outcome) = oneshot::channel();
        self.schedule(session_id, |work| work.reconciles.push(reconciled));
        outcome
    }

    /// Settles the end of `run_id` seen while an interrupt of it was under way, once the
    /// interrupt's choice is written and its hold released; a run whose end was not seen is left
    /// to its own. Called under `hold`; fails as the settle does, the end then kept for a later
    /// settle.
    pub(crate) async fn settle_end_after_interrupt(
        self: &Arc<Self>,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let session_id = *hold.key();
        let is_awaiting = self
            .lock()
            .ends_awaiting_interrupt
            .get(&session_id)
            .is_some_and(|run_ids| run_ids.contains(&run_id));
        if !is_awaiting {
            return Ok(());
        }
        self.settle_end(hold, run_id).await?;
        {
            let mut state = self.lock();
            if let Some(run_ids) = state.ends_awaiting_interrupt.get_mut(&session_id) {
                run_ids.remove(&run_id);
                if run_ids.is_empty() {
                    state.ends_awaiting_interrupt.remove(&session_id);
                }
            }
        }
        // The record is read off the lock, which its settle takes.
        self.schedule(session_id, |work| work.kept_settles.push(run_id));
        Ok(())
    }

    /// The runs of the held session whose end an interrupt held back and no interrupt holds any
    /// more, which their release left unsettled. Called under `hold`.
    pub(crate) fn ends_no_longer_held(&self, hold: &KeyHold<'_, SessionId>) -> Vec<RunId> {
        let awaiting: Vec<RunId> = self
            .lock()
            .ends_awaiting_interrupt
            .get(hold.key())
            .map(|run_ids| run_ids.iter().copied().collect())
            .unwrap_or_default();
        awaiting
            .into_iter()
            .filter(|run_id| !self.deps.delivery.is_held_for_interrupt(*run_id))
            .collect()
    }

    /// Takes the ids of the lead's messages the end of `run_id` moved on to another run, which an
    /// interrupt of the run still decides; `None` when its end moved none or the run they went to
    /// has ended. Called under the session lock.
    pub(crate) fn take_moved_leftovers(&self, run_id: RunId) -> Option<Vec<QueueItemId>> {
        self.lock()
            .moved_leftovers_by_run
            .remove(&run_id)
            .map(|moved| moved.item_ids)
    }

    /// Continues the interrupted run `run_id` with the lead's messages waiting for it, once its
    /// end is settled, unless none waits, an interrupt of it is under way, the provider's live
    /// process keeps one, which it continues the run with itself, or the run rests from a limit
    /// and `is_by_send` is false: only a send continues that one. Called under `hold`; fails as a
    /// read fails.
    pub(crate) async fn continue_interrupted_run(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        is_by_send: bool,
    ) -> Result<(), QueueError> {
        let session_id = *hold.key();
        if self.let_go_superseded_resting_run(session_id).await? != Some(run_id) {
            return Ok(());
        }
        let is_interrupted = read_run_through::<QueueError>(&self.deps.pool, run_id)
            .await?
            .is_some_and(|run| run.state == RunState::Interrupted);
        let delivery = &self.deps.delivery;
        if !is_interrupted || delivery.is_held_for_interrupt(run_id) {
            return Ok(());
        }
        if !is_by_send && self.rests_for_send(session_id, run_id).await? {
            return Ok(());
        }
        let has_waiting = self
            .read_waiting(run_id)
            .await?
            .iter()
            .any(|item| item.child_handle.is_none());
        if has_waiting && !delivery.is_message_kept_for_run(session_id, run_id) {
            self.deps.admission.continue_run(session_id, run_id);
        }
        Ok(())
    }

    /// Hands the lead run `run_id` what waits for it, continues it with that when it rests
    /// interrupted, or moves it on from a run that ended while its provider kept a message, after
    /// a change took messages back. Called under `hold`; fails as a hand or a read fails.
    pub(crate) async fn hand_or_continue(
        self: &Arc<Self>,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        self.deps.delivery.hand_waiting(hold, run_id).await?;
        self.continue_interrupted_run(hold, run_id, false).await?;
        self.settle_ended_run(*hold.key(), run_id);
        Ok(())
    }

    /// Marks the lifecycle stopping, so [`QueueRunLifecycle::wait`] answers once no drain runs; a
    /// drain started after still counts.
    pub(crate) fn close(&self) {
        self.tasks.close();
    }

    /// Waits, once closed, for every drain under way.
    pub(crate) async fn wait(&self) {
        self.tasks.wait().await;
    }

    /// Whether no drain runs.
    pub(crate) fn is_idle(&self) -> bool {
        self.tasks.is_empty()
    }

    // Notes `add` in the session's pending work and starts its drain when none runs.
    fn schedule(self: &Arc<Self>, session_id: SessionId, add: impl FnOnce(&mut PendingWork)) {
        let mut state = self.lock();
        add(state.pending.entry(session_id).or_default());
        if state.draining.insert(session_id) {
            let lifecycle = Arc::clone(self);
            self.tasks.spawn(
                async move { lifecycle.drain(session_id).await }
                    .instrument(tracing::Span::current()),
            );
        }
    }

    // Applies the session's pending work until none is left.
    async fn drain(self: Arc<Self>, session_id: SessionId) {
        loop {
            let work = {
                let mut state = self.lock();
                let Some(work) = state.pending.remove(&session_id) else {
                    state.draining.remove(&session_id);
                    return;
                };
                work
            };
            self.apply_work(session_id, work).await;
        }
    }

    async fn apply_work(self: &Arc<Self>, session_id: SessionId, work: PendingWork) {
        for change in work.changes {
            if let Err(error) = self.apply(session_id, &change).await {
                log_failure(session_id, &error, "following a run's state change failed");
            }
        }
        for run_id in work.ended_runs {
            if let Err(error) = self.end_ended_run(session_id, run_id).await {
                log_failure(
                    session_id,
                    &error,
                    "moving an ended run's messages on failed",
                );
            }
        }
        for run_id in work.continues {
            let hold = self.deps.session_lock.hold_session(session_id).await;
            if let Err(error) = self.continue_interrupted_run(&hold, run_id, false).await {
                log_failure(session_id, &error, "continuing an interrupted run failed");
            }
        }
        if !work.kept_settles.is_empty() {
            self.settle_kept_messages(session_id, &work.kept_settles)
                .await;
        }
        if work.is_process_gone
            && let Err(error) = self.end_runs_of_gone_process(session_id).await
        {
            log_failure(session_id, &error, "settling a gone process's runs failed");
        }
        for reconciled in work.reconciles {
            // A caller that stopped waiting has nothing to hear.
            drop(reconciled.send(self.reconcile_now(session_id).await));
        }
        if work.is_closed {
            self.forget_session(session_id);
        }
    }

    // The peak is read before the change, which can let the run's place go, and a failed read
    // never holds the change back: it is surfaced once the change is made.
    async fn apply(
        self: &Arc<Self>,
        session_id: SessionId,
        change: &StoredRunStateChange,
    ) -> Result<(), QueueError> {
        let run_id = *change.run_id();
        let peak = self
            .deps
            .admission
            .observe_process_peak(session_id, run_id)
            .await;
        self.apply_state_change(session_id, run_id, change).await?;
        peak
    }

    async fn apply_state_change(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
        change: &StoredRunStateChange,
    ) -> Result<(), QueueError> {
        let admission = &self.deps.admission;
        match change {
            StoredRunStateChange::Completed(_)
            | StoredRunStateChange::Interrupted(_)
            | StoredRunStateChange::Stopped(_)
            | StoredRunStateChange::Failed(_) => self.end_run(session_id, run_id).await,
            StoredRunStateChange::WaitingForApproval(_)
            | StoredRunStateChange::WaitingForInput(_)
            | StoredRunStateChange::Paused(_) => {
                admission.park(run_id);
                Ok(())
            }
            StoredRunStateChange::Starting(_) | StoredRunStateChange::Pausing(_) => {
                self.let_go_superseded_resting_run(session_id).await?;
                Ok(())
            }
            StoredRunStateChange::Running(_) => {
                self.let_go_superseded_resting_run(session_id).await?;
                {
                    let mut state = self.lock();
                    if state.resting_run_by_session.get(&session_id) == Some(&run_id) {
                        state.resting_run_by_session.remove(&session_id);
                    }
                }
                admission.resume(run_id);
                // The start writes its opening's outcome first, so the opening is never handed
                // again.
                admission.settled(run_id).await;
                let hold = self.deps.session_lock.hold_session(session_id).await;
                self.deps.delivery.hand_waiting(&hold, run_id).await?;
                Ok(())
            }
        }
    }

    // Ends `run_id` by what its end leaves of its place and messages, unless an interrupt of it is
    // under way, whose choice is written first; then settles what its resumes kept, off the lock.
    async fn end_run(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        self.deps.admission.settled(run_id).await;
        // Outside the lock, which a failed continue takes: once it has settled, the end's messages
        // go to the run it made live rather than to a next run beside it.
        self.settle_superseded_continue(session_id).await;
        {
            let hold = self.deps.session_lock.hold_session(session_id).await;
            if self.deps.delivery.is_held_for_interrupt(run_id) {
                self.lock()
                    .ends_awaiting_interrupt
                    .entry(session_id)
                    .or_default()
                    .insert(run_id);
                return Ok(());
            }
            self.settle_end(&hold, run_id).await?;
        }
        self.settle_kept_messages(session_id, &[run_id]).await;
        Ok(())
    }

    async fn end_ended_run(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let is_ended = read_run_through::<QueueError>(&self.deps.pool, run_id)
            .await?
            .is_some_and(|run| run.state.is_terminal());
        let is_resting = self.lock().resting_run_by_session.get(&session_id) == Some(&run_id);
        if !is_ended || is_resting {
            return Ok(());
        }
        self.end_run(session_id, run_id).await
    }

    async fn end_runs_of_gone_process(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> Result<(), QueueError> {
        for run_id in self
            .deps
            .delivery
            .forget_kept_by_gone_process(session_id)
            .await?
        {
            self.end_run(session_id, run_id).await?;
        }
        // The process's end makes every message a resume kept final in the provider's record.
        self.settle_kept_messages(session_id, &[]).await;
        Ok(())
    }

    // Settles, from the provider's record, the messages resumes of `run_ids` kept, and those of
    // every run of the session a settle before left kept: an unanswered read keeps the run for the
    // next settle, and one whose messages a live process still holds stays for the process's end.
    async fn settle_kept_messages(&self, session_id: SessionId, run_ids: &[RunId]) {
        let mut runs: Vec<RunId> = self
            .lock()
            .kept_unsettled
            .remove(&session_id)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for run_id in run_ids {
            if !runs.contains(run_id) {
                runs.push(*run_id);
            }
        }
        let continued: &dyn ContinuedMessages = &self.deps.delivery;
        let mut still_kept = HashSet::new();
        for run_id in runs {
            let settled = self
                .deps
                .pauses
                .settle_kept_by_record(session_id, run_id, continued)
                .await;
            match settled {
                Ok(()) => {}
                Err(error @ RunPauseError::RecordUnanswered(_)) => {
                    log_failure(
                        session_id,
                        &error,
                        "a provider left a kept message's record unanswered",
                    );
                    still_kept.insert(run_id);
                    continue;
                }
                Err(error) => {
                    log_failure(
                        session_id,
                        &error,
                        "settling the messages a resume kept failed",
                    );
                }
            }
            let hold = continued.hold_session(session_id).await;
            if !continued.kept(&hold, run_id).is_empty() {
                still_kept.insert(run_id);
            }
        }
        if !still_kept.is_empty() {
            self.lock()
                .kept_unsettled
                .entry(session_id)
                .or_default()
                .extend(still_kept);
        }
    }

    async fn reconcile_now(self: &Arc<Self>, session_id: SessionId) -> Result<(), QueueError> {
        let (waiting, live_run_id) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let items = QueueItemReader::new(reader);
                let waiting = items.list(&session_id, None, Some(QueueItemState::Queued))?;
                Ok::<_, QueueError>((waiting, items.read_live_lead_run(&session_id)?))
            })
            .await?;
        let mut run_ids: Vec<RunId> = Vec::new();
        for run_id in waiting
            .iter()
            .filter_map(|item| item.target_run_id)
            .chain(live_run_id)
        {
            if !run_ids.contains(&run_id) {
                run_ids.push(run_id);
            }
        }
        let admission = &self.deps.admission;
        for run_id in run_ids {
            let Some(run) = read_run_through::<QueueError>(&self.deps.pool, run_id).await? else {
                continue;
            };
            match run.state {
                RunState::Completed
                | RunState::Interrupted
                | RunState::Stopped
                | RunState::Failed => {
                    self.end_run(session_id, run_id).await?;
                }
                RunState::Queued => {
                    if !admission.is_admitting(run_id) {
                        admission.start(session_id, run_id);
                    }
                }
                RunState::WaitingForApproval | RunState::WaitingForInput | RunState::Paused => {
                    admission.park(run_id);
                }
                RunState::Running => {
                    admission.resume(run_id);
                    admission.settled(run_id).await;
                    let hold = self.deps.session_lock.hold_session(session_id).await;
                    self.deps.delivery.hand_waiting(&hold, run_id).await?;
                }
                RunState::Starting | RunState::Pausing => {}
            }
        }
        Ok(())
    }

    // Makes `run_id` the session's resting run, letting go the one that rested before.
    fn rest(&self, session_id: SessionId, run_id: RunId) {
        self.let_go_resting_run(session_id);
        self.lock()
            .resting_run_by_session
            .insert(session_id, run_id);
    }

    // Lets the session's resting interrupted run go, with its parked place, once a newer lead run
    // exists, and answers the one still resting. A continue under way keeps the place, which the
    // continue's own end lets go.
    async fn let_go_superseded_resting_run(
        &self,
        session_id: SessionId,
    ) -> Result<Option<RunId>, QueueError> {
        let Some(resting_run_id) = self.lock().resting_run_by_session.get(&session_id).copied()
        else {
            return Ok(None);
        };
        let current = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(
                    QueueItemReader::new(reader).read_current_lead_run(&session_id)?,
                )
            })
            .await?;
        if current.is_some_and(|current| current.run_id == resting_run_id) {
            return Ok(Some(resting_run_id));
        }
        let mut state = self.lock();
        // Another settle moved the resting run on during the read.
        if state.resting_run_by_session.get(&session_id) != Some(&resting_run_id) {
            return Ok(None);
        }
        state.resting_run_by_session.remove(&session_id);
        if self.deps.admission.is_starting(resting_run_id) {
            state
                .superseded_continue_by_session
                .insert(session_id, resting_run_id);
        } else {
            drop(state);
            self.deps.admission.release(resting_run_id);
        }
        Ok(None)
    }

    fn let_go_resting_run(&self, session_id: SessionId) {
        let resting = self.lock().resting_run_by_session.remove(&session_id);
        if let Some(resting_run_id) = resting {
            self.deps.admission.release(resting_run_id);
        }
    }

    async fn settle_superseded_continue(&self, session_id: SessionId) {
        let continuing = self
            .lock()
            .superseded_continue_by_session
            .get(&session_id)
            .copied();
        let Some(continuing_run_id) = continuing else {
            return;
        };
        self.deps.admission.settled(continuing_run_id).await;
        let mut state = self.lock();
        if state.superseded_continue_by_session.get(&session_id) == Some(&continuing_run_id) {
            state.superseded_continue_by_session.remove(&session_id);
        }
    }

    // A closed session's provider session, resting run, held-back run ends and moved-on messages
    // are forgotten; its resting run and each run whose end it held back give back their places.
    fn forget_session(&self, session_id: SessionId) {
        self.deps.provider_sessions.forget(session_id);
        self.let_go_resting_run(session_id);
        let ends_awaiting = {
            let mut state = self.lock();
            state.superseded_continue_by_session.remove(&session_id);
            state
                .moved_leftovers_by_run
                .retain(|_, moved| moved.session_id != session_id);
            state.ends_awaiting_interrupt.remove(&session_id)
        };
        for run_id in ends_awaiting.into_iter().flatten() {
            self.deps.admission.release(run_id);
        }
    }

    // Whether `run_id` was interrupted at a limit, so it rests with its messages waiting until a
    // send continues it.
    async fn rests_for_send(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<bool, QueueError> {
        let trigger = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let trigger: Option<Option<String>> = reader
                    .prepare_cached(&SELECT_INTERRUPT_TRIGGER_SQL)?
                    .query_row(
                        [session_id.text().as_str(), run_id.text().as_str()],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok::<_, QueueError>(trigger.flatten())
            })
            .await?;
        Ok(trigger.is_some())
    }

    async fn read_waiting(&self, run_id: RunId) -> Result<Vec<QueueItemRecord>, QueueError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list_waiting_for_run(&run_id)?)
            })
            .await
    }

    // The lifecycle's state. No holder awaits or panics while it changes the state, so a poisoned
    // lock still guards a whole state.
    fn lock(&self) -> MutexGuard<'_, LifecycleState> {
        lock(&self.state)
    }
}

/// The run lifecycle as the drivers' port holds it: weakly, since the port outlives no queue.
pub(crate) struct RunLifecycleListener(pub(crate) Weak<QueueRunLifecycle>);

// A driver tells of a process that ended through the port.
impl ProcessGoneListener for RunLifecycleListener {
    fn process_gone(&self, session_id: SessionId) {
        if let Some(lifecycle) = self.0.upgrade() {
            lifecycle.on_process_gone(session_id);
        }
    }
}

impl InterruptedRunContinuation for Weak<QueueRunLifecycle> {
    // On the session's drain, which takes the lock the caller just let go.
    fn continue_interrupted_run(&self, session_id: SessionId, run_id: RunId) {
        if let Some(lifecycle) = self.upgrade() {
            lifecycle.schedule(session_id, |work| work.continues.push(run_id));
        }
    }
}

fn log_failure(session_id: SessionId, error: &(dyn Error + 'static), what: &'static str) {
    tracing::error!(session_id = %session_id, error, "{what}");
}

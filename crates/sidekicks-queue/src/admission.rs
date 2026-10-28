//! Starts each run a send queued, and continues an interrupted run with the messages waiting for
//! it. The run waits its turn at the memory gate, then passes the run's setup gates; the session's
//! provider session is opened at its first admission after them, and the driver is handed the
//! run's first waiting item as the turn's opening: a message, or a review, which opens a run of its
//! own and is never a continue's opening. Before the run's binding is opened the driver is waited
//! on until the session's process no longer comes back on its own, so the binding names the leg
//! it settled on. A run still waiting at the gate past the delivery timeout ends failed with its
//! messages not delivered, and so does a run whose start failed while it still read queued; a
//! process not settled within that same timeout fails the start `provider.unavailable`. An interrupt that ends a run during its start leaves the
//! opening to the interrupt's choice.
//!
//! The place the gate grants is the run's until it ends: the run lifecycle parks it while the run
//! waits on a person, and while it rests interrupted with its provider process alive, so a continue
//! takes it again, and releases it at any other end. The gate learns a run's peak only from a
//! provider process the run's own start brought up, since one already running holds memory the run
//! did not grow.

mod continues;
mod opening;
mod skill_picks;

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::{DaemonFailureOrigin, RunFailureCause};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, ProviderDriver, bound_failure_detail};
use sidekicks_provider::driver::error_causes::session_process_unavailable;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::process_identity::ProviderProcessIds;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_session::queue_store::summary::summary_of;
use sidekicks_session::queue_store::{
    QueueItemOutcome, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
};
use sidekicks_session::run::engine::{RunEngine, RunEngineError};
use sidekicks_session::run::read::read_run_through;
use sidekicks_session::run::refusals::RunRefusal;
use sidekicks_session::run::start_request::RunStartRequest;
use sidekicks_session::run::state_change::{RunStateChange, RunStateChangeCompanions};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::sync::watch;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;

pub(crate) use self::opening::RunOpenings;
use crate::delivery::QueueDelivery;
use crate::error::QueueError;
use crate::memory_gate::{
    AdmissionWork, MemoryAdmission, MemoryAdmissionState, MemoryGate, ProviderStartEstimate,
};
use crate::provider_session::ProviderSessions;
use crate::recorder::{QueueRecordError, QueueRecorder, outcome_draft_of};
use crate::session_lock::QueueSessionLock;

/// How long a queued run waits for the memory gate before its messages are not delivered, and
/// then for its session's process to settle: past five minutes a run is not starting soon, and the
/// person is better told so.
pub(crate) const QUEUE_DELIVERY_TIMEOUT: Duration = Duration::from_mins(5);

// The detail of a run that waited past the delivery timeout.
static TIMED_OUT_DETAIL: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The run waited longer than the delivery timeout to start".to_owned())
            .expect("the detail is non-blank and within the cap")
    });

// The detail of a failed start whose failure has no words.
static START_FAILED_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The run could not be started".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// What the admission reads, writes and calls.
pub(crate) struct QueueAdmissionDeps {
    /// The read pool every queue and run read goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// Records each opening's outcome.
    pub(crate) recorder: Arc<QueueRecorder>,
    /// Starts, continues and ends runs.
    pub(crate) engine: Arc<RunEngine>,
    /// Opens each session's provider session and each run's binding.
    pub(crate) provider_sessions: Arc<ProviderSessions>,
    /// The drivers and their descriptors.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The gate every start waits its turn at.
    pub(crate) memory_gate: Arc<MemoryGate>,
    /// The identity of each session's provider process.
    pub(crate) processes: Arc<dyn ProviderProcessIds>,
    /// The queue's own per-session lock.
    pub(crate) session_lock: Arc<QueueSessionLock>,
    /// Where each damaged session's log stops being readable.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The openings of the runs whose drivers are being started.
    pub(crate) openings: Arc<RunOpenings>,
    /// Hands the messages a newer lead run took over from a continue given up.
    pub(crate) delivery: QueueDelivery,
    /// How long a run waits at the gate, and then for its session's process to settle.
    pub(crate) delivery_timeout: Duration,
}

// What the admission holds per run.
#[derive(Default)]
struct AdmissionState {
    // Each run's place at the gate, from its queuing until it ends.
    places: HashMap<RunId, Arc<MemoryAdmission>>,
    // Each start or continue in flight, which reads `true` once it has written its opening's
    // outcome.
    starts: HashMap<RunId, watch::Receiver<bool>>,
    // Runs released while their start still read what it weighs at the gate; they never enqueue.
    released_before_enqueue: HashSet<RunId>,
    // Runs whose own start brought up the provider process the gate learns their peak from.
    process_starting: HashSet<RunId>,
}

// How a wait at the gate ended.
enum Placed {
    Admitted,
    Released,
    TimedOut,
}

/// Starts the runs sends queue and holds each one's place at the memory gate until it ends. A
/// start's failure is written to the run and its messages, and to the service log.
pub struct QueueAdmission {
    deps: QueueAdmissionDeps,
    state: Mutex<AdmissionState>,
    tasks: TaskTracker,
}

impl QueueAdmission {
    /// An admission over `deps`, holding no place.
    pub(crate) fn new(deps: QueueAdmissionDeps) -> Self {
        Self {
            deps,
            state: Mutex::new(AdmissionState::default()),
            tasks: TaskTracker::new(),
        }
    }

    /// Starts the queued run `run_id` on a task of its own, once the memory gate admits it. A start
    /// of the run already under way is left to finish.
    pub(crate) fn start(self: &Arc<Self>, session_id: SessionId, run_id: RunId) {
        let Some(done) = self.begin(run_id) else {
            return;
        };
        let admission = Arc::clone(self);
        self.tasks.spawn(
            async move {
                if let Err(error) = admission.start_queued(session_id, run_id).await {
                    admission
                        .settle_failed_start(session_id, run_id, error)
                        .await;
                }
                admission.finish(run_id, &done);
            }
            .instrument(tracing::Span::current()),
        );
    }

    /// Continues the interrupted run `run_id` on a task of its own, the first lead message waiting
    /// for it opening its next turn and the rest handed once it runs: its parked place taken
    /// again, else a new place it waits for as a start does. A wait past the delivery timeout
    /// leaves the run interrupted with its messages not delivered; a continue that fails while the
    /// run still reads interrupted leaves those still waiting not delivered too; one a newer lead
    /// run took them over from is let go quietly. A start or continue already under way is left.
    pub(crate) fn continue_run(self: &Arc<Self>, session_id: SessionId, run_id: RunId) {
        let Some(done) = self.begin(run_id) else {
            return;
        };
        let admission = Arc::clone(self);
        self.tasks.spawn(
            async move {
                if let Err(error) = admission.continue_interrupted(session_id, run_id).await {
                    admission
                        .settle_failed_continue(session_id, run_id, error)
                        .await;
                }
                admission.finish(run_id, &done);
            }
            .instrument(tracing::Span::current()),
        );
    }

    /// Settles once the start or continue of `run_id` has written its opening's outcome; at once
    /// when none runs.
    pub(crate) async fn settled(&self, run_id: RunId) {
        let start = self.lock().starts.get(&run_id).cloned();
        if let Some(mut start) = start {
            // A start dropped with the runtime has nothing left to wait for.
            drop(start.wait_for(|is_done| *is_done).await);
        }
    }

    /// Whether the queue holds `run_id`'s place at the gate or is starting it.
    pub(crate) fn is_admitting(&self, run_id: RunId) -> bool {
        let state = self.lock();
        state.places.contains_key(&run_id) || state.starts.contains_key(&run_id)
    }

    /// Whether a start or continue of `run_id` is under way.
    pub(crate) fn is_starting(&self, run_id: RunId) -> bool {
        self.lock().starts.contains_key(&run_id)
    }

    /// Gives up the run's reservation while it waits on a person; a run holding none is left.
    pub(crate) fn park(&self, run_id: RunId) {
        let place = self.lock().places.get(&run_id).cloned();
        if let Some(place) = place
            && place.state() == MemoryAdmissionState::Admitted
            && let Err(error) = place.park()
        {
            tracing::error!(
                run_id = %run_id,
                error = &error as &(dyn Error + 'static),
                "a run's place at the memory gate could not be parked"
            );
        }
    }

    /// Puts a parked run back in the gate's line, the run going on while it waits; a run not
    /// parked is left.
    pub(crate) fn resume(&self, run_id: RunId) {
        let place = self.lock().places.get(&run_id).cloned();
        if let Some(place) = place
            && place.state() == MemoryAdmissionState::Parked
            && let Err(error) = place.resume()
        {
            tracing::error!(
                run_id = %run_id,
                error = &error as &(dyn Error + 'static),
                "a run's place at the memory gate could not rejoin the line"
            );
        }
    }

    /// Keeps the place of `run_id`, which ended interrupted, parked while its provider process
    /// lives, so a continue takes it again until [`QueueAdmission::release`]; with no process, or
    /// none granted, it is released.
    pub(crate) fn park_interrupted(&self, session_id: SessionId, run_id: RunId) {
        self.park(run_id);
        let is_parked = self
            .lock()
            .places
            .get(&run_id)
            .is_some_and(|place| place.state() == MemoryAdmissionState::Parked);
        if !is_parked || self.deps.processes.process_identity(&session_id).is_none() {
            self.release(run_id);
        }
    }

    /// Reads the peak of the session's provider process into the run's place at the gate, when the
    /// run's own start brought that process up. Fails when the read does.
    pub(crate) async fn observe_process_peak(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let place = {
            let state = self.lock();
            if !state.process_starting.contains(&run_id) {
                return Ok(());
            }
            state.places.get(&run_id).cloned()
        };
        let Some(place) = place else {
            return Ok(());
        };
        if place.state() == MemoryAdmissionState::Waiting {
            return Ok(());
        }
        if let Some(process) = self.deps.processes.process_identity(&session_id) {
            place.observe_process_peak(process.process_id).await?;
        }
        Ok(())
    }

    /// Ends the run's place at the gate: a run still waiting leaves the line and is never started.
    pub(crate) fn release(&self, run_id: RunId) {
        let mut state = self.lock();
        state.process_starting.remove(&run_id);
        if state.places.remove(&run_id).is_none() && state.starts.contains_key(&run_id) {
            state.released_before_enqueue.insert(run_id);
        }
    }

    /// Writes the `admitted` outcome the opening of the ended run `run_id` still owes, its driver
    /// having started with it, and forgets the opening once written. Called at the run's end under
    /// the session lock; fails as the read or the write fails, the opening then kept for a settle
    /// tried again.
    pub(crate) async fn settle_opening(&self, run_id: RunId) -> Result<(), QueueError> {
        let Some(opening) = self.deps.openings.get(run_id) else {
            return Ok(());
        };
        if self
            .read_item(&opening)
            .await?
            .as_ref()
            .is_some_and(is_waiting)
        {
            self.deps
                .recorder
                .record_outcome(
                    &opening,
                    QueueItemOutcome::Admitted { run_id },
                    &WireInstant::now(),
                )
                .await?;
        }
        self.deps.openings.remove(run_id);
        Ok(())
    }

    /// Ends the queued run `run_id` `failed` as a setup failure saying `detail`, with each of
    /// `outcomes` in the same write, and releases its place. Called under the session's `_hold`;
    /// fails with the write's refusal when the run has left `queued` or one of the messages has.
    pub(crate) async fn end_queued_run(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        outcomes: Vec<(QueueItemRecord, QueueItemOutcome)>,
        detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    ) -> Result<(), QueueError> {
        let now = WireInstant::now();
        let mut companions = RunStateChangeCompanions::default();
        let mut items = Vec::with_capacity(outcomes.len());
        for (item, outcome) in outcomes {
            let (draft, statement) =
                outcome_draft_of(&item, &outcome, &now).map_err(QueueRecordError::from)?;
            companions.statements.push(statement);
            companions.preceding_events.push(draft);
            items.push(item);
        }
        let failed = RunStateChange {
            expected_state: Some(RunState::Queued),
            failure_category: Some(RunFailureCategory::SetupFailure),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: Some(RunFailureCause::SetupFailed {
                        origin: DaemonFailureOrigin::Value,
                        code: None,
                        message: detail,
                    }),
                    provider_failure_detail: None,
                    process_exit: None,
                },
            )
        };
        self.deps.engine.transition(failed, companions).await?;
        self.release(run_id);
        self.deps.recorder.raise_committed(&items, false);
        Ok(())
    }

    /// Marks the admission stopping, so [`QueueAdmission::wait`] answers once no start or
    /// continue runs; one started after still counts.
    pub(crate) fn close(&self) {
        self.tasks.close();
    }

    /// Waits, once closed, for every start and continue under way.
    pub(crate) async fn wait(&self) {
        self.tasks.wait().await;
    }

    /// Whether no start or continue runs.
    pub(crate) fn is_idle(&self) -> bool {
        self.tasks.is_empty()
    }

    // Marks a start or continue of `run_id` under way, answering its done signal, or `None` when
    // one already is.
    fn begin(&self, run_id: RunId) -> Option<watch::Sender<bool>> {
        let mut state = self.lock();
        if state.starts.contains_key(&run_id) {
            return None;
        }
        let (done, start) = watch::channel(false);
        state.starts.insert(run_id, start);
        Some(done)
    }

    fn finish(&self, run_id: RunId, done: &watch::Sender<bool>) {
        let mut state = self.lock();
        state.starts.remove(&run_id);
        state.released_before_enqueue.remove(&run_id);
        done.send_replace(true);
    }

    async fn start_queued(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let (provider, provider_account_id, driver) = self.read_session_driver(session_id).await?;
        match self
            .take_place(
                &provider,
                provider_account_id,
                driver.as_ref(),
                session_id,
                run_id,
            )
            .await?
        {
            Placed::Admitted => {}
            Placed::Released => return Ok(()),
            Placed::TimedOut => {
                let hold = self.deps.session_lock.hold_session(session_id).await;
                return self
                    .end_undelivered(&hold, run_id, QueueItemNotDeliveredReason::TimedOut {})
                    .await;
            }
        }
        let execution_posture = self
            .deps
            .provider_sessions
            .read_execution_posture(session_id)
            .await?;
        // Taken under the lock, so a removal either lands first or finds the opening taken.
        let opening = {
            let _hold = self.deps.session_lock.hold_session(session_id).await;
            let is_placed = self.lock().places.contains_key(&run_id);
            let head = if is_placed {
                self.read_waiting(run_id).await?.into_iter().next()
            } else {
                None
            };
            if let Some(head) = &head {
                self.deps.openings.insert(run_id, head.clone());
            }
            head
        };
        let Some(opening) = opening else {
            return Ok(());
        };
        let started = self
            .deps
            .engine
            .start_run(RunStartRequest {
                turn: self.turn_start(
                    session_id,
                    run_id,
                    &driver,
                    &opening,
                    execution_posture,
                    false,
                ),
                queue_item: Some(summary_of(opening.clone())),
                provider,
                output_speed: opening
                    .body
                    .as_message()
                    .and_then(|message| message.output_speed_for_turn.clone()),
                running_statements: None,
            })
            .await;
        if let Err(start_error) = started {
            // The opening never reached the provider's turn: a run the engine ended, or failed to
            // end, keeps the rest for the next run, and one an interrupt claimed leaves the
            // opening to the interrupt's choice.
            self.deps.openings.remove(run_id);
            let state = read_run_through::<QueueError>(&self.deps.pool, run_id)
                .await?
                .map(|run| run.state);
            let is_unended = state == Some(RunState::Starting)
                && matches!(start_error, RunEngineError::Several(_));
            if (state == Some(RunState::Failed) || is_unended)
                && self
                    .read_item(&opening)
                    .await?
                    .as_ref()
                    .is_some_and(is_waiting)
            {
                self.record_not_delivered(&opening, QueueItemNotDeliveredReason::Failed {})
                    .await?;
            }
            return Err(start_error.into());
        }
        // Kept as the opening until this write lands, so a failed write never hands it again.
        self.record_admitted(&opening, run_id).await?;
        self.deps.openings.remove(run_id);
        Ok(())
    }

    // What a start that failed leaves: a run an interrupt claimed keeps the interrupt's choice, and
    // one still queued ends with every message, since a run left queued would hold every later
    // send.
    async fn settle_failed_start(&self, session_id: SessionId, run_id: RunId, error: QueueError) {
        if is_invalid_transition(&error) {
            return;
        }
        let state = match read_run_through::<QueueError>(&self.deps.pool, run_id).await {
            Ok(run) => run.map(|run| run.state),
            Err(read) => {
                log_failure(
                    session_id,
                    run_id,
                    &read,
                    "reading a run after its failed start",
                );
                None
            }
        };
        if state == Some(RunState::Interrupted) {
            return;
        }
        log_failure(session_id, run_id, &error, "starting a queued run failed");
        if state != Some(RunState::Queued) {
            return;
        }
        self.release(run_id);
        let detail = bound_failure_detail(&describe_error(&error), START_FAILED_FALLBACK.clone());
        let hold = self.deps.session_lock.hold_session(session_id).await;
        let ended = self
            .end_waiting_undelivered(
                &hold,
                run_id,
                QueueItemNotDeliveredReason::Failed {},
                detail,
            )
            .await;
        if let Err(end_error) = ended {
            log_failure(
                session_id,
                run_id,
                &end_error,
                "ending a run after its failed start failed",
            );
        }
    }

    // Waits until the session's process no longer comes back on its own, within the delivery
    // timeout; past it the start fails `provider.unavailable`, as it does for a process down, in
    // the daemon's own words alone.
    async fn settle_session(
        &self,
        session_id: SessionId,
        driver: &dyn ProviderDriver,
    ) -> Result<(), QueueError> {
        tokio::time::timeout(
            self.deps.delivery_timeout,
            driver.settle_session(session_id),
        )
        .await
        .map_err(|_elapsed| DriverError::Refused(session_process_unavailable(session_id)))??;
        Ok(())
    }

    // Puts `run_id` in the gate's line and waits for its turn within the delivery timeout. The
    // gate weighs a process start on `provider_account_id`, the account the run is admitted
    // against.
    async fn take_place(
        &self,
        provider: &ProviderId,
        provider_account_id: Option<ProviderAccountId>,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<Placed, QueueError> {
        let starts_process = driver.starts_process(session_id, provider_account_id).await;
        let work = provider_work(&self.deps.providers, provider, !starts_process)?;
        let mut admitted = {
            let mut state = self.lock();
            if state.released_before_enqueue.contains(&run_id) {
                return Ok(Placed::Released);
            }
            let place = Arc::new(self.deps.memory_gate.enqueue(work));
            let admitted = place.admitted();
            state.places.insert(run_id, place);
            admitted
        };
        // A wait past the timeout reads the place as still waiting below.
        drop(
            tokio::time::timeout(
                self.deps.delivery_timeout,
                admitted.wait_for(Option::is_some),
            )
            .await,
        );
        let place_state = self.lock().places.get(&run_id).map(|place| place.state());
        Ok(match place_state {
            Some(MemoryAdmissionState::Admitted) => {
                if starts_process {
                    self.lock().process_starting.insert(run_id);
                }
                Placed::Admitted
            }
            Some(MemoryAdmissionState::Waiting) => {
                self.release(run_id);
                Placed::TimedOut
            }
            Some(MemoryAdmissionState::Parked) | None => Placed::Released,
        })
    }

    // Every lead message waiting for the run reads not delivered, for `reason`. Called under
    // `_hold`.
    async fn mark_waiting_undelivered(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        reason: QueueItemNotDeliveredReason,
    ) -> Result<(), QueueError> {
        for item in self.read_waiting(run_id).await? {
            if item.child_handle.is_none() {
                self.record_not_delivered(&item, reason.clone()).await?;
            }
        }
        Ok(())
    }

    // Ends the queued run with every message waiting for it not delivered, for a wait past the
    // timeout. Called under `hold`.
    async fn end_undelivered(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        reason: QueueItemNotDeliveredReason,
    ) -> Result<(), QueueError> {
        self.end_waiting_undelivered(hold, run_id, reason, TIMED_OUT_DETAIL.clone())
            .await
    }

    async fn end_waiting_undelivered(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        reason: QueueItemNotDeliveredReason,
        detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    ) -> Result<(), QueueError> {
        let outcomes = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .map(|item| {
                let outcome = QueueItemOutcome::NotDelivered {
                    reason: reason.clone(),
                };
                (item, outcome)
            })
            .collect();
        self.end_queued_run(hold, run_id, outcomes, detail).await
    }

    async fn record_admitted(
        &self,
        item: &QueueItemRecord,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        self.deps
            .recorder
            .record_outcome(
                item,
                QueueItemOutcome::Admitted { run_id },
                &WireInstant::now(),
            )
            .await?;
        Ok(())
    }

    async fn record_not_delivered(
        &self,
        item: &QueueItemRecord,
        reason: QueueItemNotDeliveredReason,
    ) -> Result<(), QueueError> {
        self.deps
            .recorder
            .record_outcome(
                item,
                QueueItemOutcome::NotDelivered { reason },
                &WireInstant::now(),
            )
            .await?;
        Ok(())
    }

    async fn read_session_driver(
        &self,
        session_id: SessionId,
    ) -> Result<
        (
            ProviderId,
            Option<ProviderAccountId>,
            Arc<dyn ProviderDriver>,
        ),
        QueueError,
    > {
        read_session_driver::<QueueError>(
            &self.deps.pool,
            &self.deps.providers,
            self.deps.read_damaged_from_sequence.as_ref(),
            session_id,
        )
        .await
    }

    async fn read_waiting(&self, run_id: RunId) -> Result<Vec<QueueItemRecord>, QueueError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).list_waiting_for_run(&run_id)?)
            })
            .await
    }

    async fn read_item(
        &self,
        item: &QueueItemRecord,
    ) -> Result<Option<QueueItemRecord>, QueueError> {
        let item_id = item.id;
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).get(&item_id)?)
            })
            .await
    }

    // The admission's state. No holder awaits or panics while it changes the state, so a poisoned
    // lock still guards a whole state.
    fn lock(&self) -> MutexGuard<'_, AdmissionState> {
        lock(&self.state)
    }
}

// The gate's work of one start of `provider`: a conversation joining its running process where
// `joins_running_process`, else a new process.
fn provider_work(
    providers: &ProviderRegistry,
    provider: &ProviderId,
    joins_running_process: bool,
) -> Result<AdmissionWork, DomainError> {
    Ok(AdmissionWork::Provider {
        start: ProviderStartEstimate::new(providers.descriptor(provider)?, joins_running_process),
        workflow_node_key: None,
    })
}

fn is_waiting(item: &QueueItemRecord) -> bool {
    item.state == RecordedQueueItemState::Queued
}

// Whether the engine refused the move because the run had moved on: an interrupt claimed it, or a
// provider continues it.
fn is_invalid_transition(error: &QueueError) -> bool {
    matches!(
        error,
        QueueError::Engine(RunEngineError::Refused(
            RunRefusal::InvalidTransition { .. }
        ))
    )
}

fn log_failure(session_id: SessionId, run_id: RunId, error: &QueueError, what: &'static str) {
    tracing::error!(
        session_id = %session_id,
        run_id = %run_id,
        error = error as &(dyn Error + 'static),
        "{what}"
    );
}

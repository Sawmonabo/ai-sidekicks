//! The epoch cursor of each run's runtime binding. It opens at the start every run opens at, as
//! the binding is recorded or, for a binding its caller minted, before its row is written, and
//! drops once its run has ended and the session has opened a newer binding, or the session closed,
//! so the provider's last deliveries on an ended run still find it and are absorbed as late, and a
//! session holds the cursors of its newest bindings alone. A binding minted for a resume of a
//! session in a new process carries the cursor of the session's leg on, opened before the resume
//! runs, since the resumed provider delivers under it at once. A cursor whose row is not written is
//! forgotten, and an open whose session closes while it reads opens none.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBinding, RuntimeBindingRelaunch, RuntimeBindingStore,
    RuntimeBindingStoreError,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::followers::CommittedEvent;

use crate::run::epochs::{EpochBinding, EpochCursorError, ExecutionEpochs};
use crate::run::read::{RunRead, RunStateReader};
use crate::run::stored_leg::read_session_leg;
use crate::run::stored_state_change::read_stored_run_state_change;

/// The statements the cursors prepare on a pooled connection: a run's row, and a session's run ids
/// and their bindings for its leg.
pub const RUN_BINDING_CURSORS_STATEMENT_CAPACITY: usize = 3;

/// Why a binding was not recorded or its cursor not opened; a binding whose cursor did not open
/// is not recorded, and one whose row was not written keeps no cursor.
#[derive(Debug, thiserror::Error)]
pub enum RunBindingCursorError {
    /// No session holds the run, so no binding is recorded for it.
    #[error("run {run_id} is held by no session, so no binding is recorded for it")]
    RunNotHeld {
        /// The run.
        run_id: RunId,
    },
    /// The binding's cursor is already open.
    #[error(transparent)]
    Cursor(#[from] EpochCursorError),
    /// The store did not record the binding.
    #[error(transparent)]
    Store(#[from] RuntimeBindingStoreError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the run or its binding could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error("the read pool did not run the run's or the binding's read")]
    Pool(#[from] DatabaseReadError),
    /// The session closed while the open read, so no cursor opens for it.
    #[error("session {session_id} closed while its cursor opened, so none opens")]
    SessionClosed {
        /// The session.
        session_id: SessionId,
    },
}

// One session's bindings with a cursor open, the ended runs whose cursors wait to drop, and the
// binding a driver's own relaunch opened with the leg it continued, until its result is recorded.
#[derive(Default)]
struct SessionCursors {
    binding_ids_by_run: HashMap<RunId, Vec<RuntimeBindingId>>,
    ended_run_ids: HashSet<RunId>,
    driver_relaunch: Option<(RuntimeBindingId, RuntimeBinding)>,
}

// The opens and continues of one session in flight, and whether its close was heard meanwhile.
struct InFlight {
    count: usize,
    is_closed: bool,
}

// Every session's cursors, and the sessions with an open or a continue in flight: a close heard
// while one awaits its read marks the session, so that one opens nothing, and the mark goes with
// the last of them.
#[derive(Default)]
struct HeldSessions {
    by_session: HashMap<SessionId, SessionCursors>,
    in_flight: HashMap<SessionId, InFlight>,
}

impl HeldSessions {
    // The cursors of `session_id`, made on first use; refused for a session whose close was heard
    // while this open was in flight.
    fn open(
        &mut self,
        session_id: SessionId,
    ) -> Result<&mut SessionCursors, RunBindingCursorError> {
        if self
            .in_flight
            .get(&session_id)
            .is_some_and(|in_flight| in_flight.is_closed)
        {
            return Err(RunBindingCursorError::SessionClosed { session_id });
        }
        Ok(self.by_session.entry(session_id).or_default())
    }

    // Closes `binding_id`'s cursor wherever its run holds it.
    fn forget(&mut self, epochs: &mut ExecutionEpochs, binding_id: &RuntimeBindingId) {
        epochs.close_binding(binding_id);
        for session in self.by_session.values_mut() {
            session.binding_ids_by_run.retain(|_, binding_ids| {
                binding_ids.retain(|held| held != binding_id);
                !binding_ids.is_empty()
            });
        }
    }
}

// An open or a continue of one session, counted in flight from before its first await until it
// drops; the last of the session's to drop takes its close mark with it.
struct InFlightOperation<'a> {
    sessions: &'a Mutex<HeldSessions>,
    session_id: SessionId,
}

impl Drop for InFlightOperation<'_> {
    fn drop(&mut self) {
        if let Entry::Occupied(mut entry) = lock(self.sessions).in_flight.entry(self.session_id) {
            entry.get_mut().count -= 1;
            if entry.get().count == 0 {
                entry.remove();
            }
        }
    }
}

/// Records each run's binding with its epoch cursor open, and drops the cursors runs left. The
/// sessions' lock is taken before the cursors' and neither is held across an await.
pub struct RunBindingCursors {
    pool: Arc<DatabaseReadPool>,
    store: Arc<RuntimeBindingStore>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    sessions: Mutex<HeldSessions>,
    /// Holds an open once its run is read, before its cursor opens.
    #[cfg(test)]
    held_run_read_pause: sidekicks_std::pause_point::PausePoint,
}

impl RunBindingCursors {
    /// Cursors over `epochs`, the ones the inbound dispatch attributes on, reading runs and
    /// bindings through `pool` and recording bindings through `store`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        store: Arc<RuntimeBindingStore>,
        epochs: Arc<Mutex<ExecutionEpochs>>,
    ) -> Self {
        Self {
            pool,
            store,
            epochs,
            sessions: Mutex::new(HeldSessions::default()),
            #[cfg(test)]
            held_run_read_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// Records a binding of a run of `session_id` in the store and opens its cursor at the run's
    /// start, dropping the cursors of the session's runs that have ended. Fails with
    /// [`RunBindingCursorError::RunNotHeld`] for a run no session holds, recording nothing,
    /// [`RunBindingCursorError::SessionClosed`] for a session that closed meanwhile, its row
    /// recorded and no cursor opened, and with the store's or the read's failure.
    pub async fn create(
        &self,
        session_id: SessionId,
        input: CreateRuntimeBindingInput,
    ) -> Result<RuntimeBinding, RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        self.read_held_run(input.run_id).await?;
        let binding = self.store.create(input).await?;
        self.open_held(session_id, epoch_binding_of(&binding))?;
        Ok(binding)
    }

    /// Opens the cursor of the binding `binding_id` the caller minted for `run_id`, a run of
    /// `session_id`, at the run's start, before its row is written, so the provider can deliver
    /// under it at once, dropping the cursors of the session's runs that have ended. Fails with
    /// [`RunBindingCursorError::RunNotHeld`] for a run no session holds,
    /// [`RunBindingCursorError::SessionClosed`] for a session that closed meanwhile and
    /// [`RunBindingCursorError::Cursor`] for a binding already open, and with the read's failure.
    pub async fn open_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
        run_id: RunId,
        provider_name: ProviderId,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<(), RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        self.read_held_run(run_id).await?;
        self.open_held(
            session_id,
            EpochBinding {
                id: binding_id,
                run_id,
                provider_name,
                provider_account_id,
            },
        )?;
        Ok(())
    }

    /// Records the row of a binding `open_binding` opened; when the write fails, forgets its
    /// cursor and fails with the store's error.
    pub async fn record_opened_binding(
        &self,
        input: CreateRuntimeBindingInput,
    ) -> Result<RuntimeBinding, RunBindingCursorError> {
        let binding_id = input.id.clone();
        match self.store.create(input).await {
            Ok(binding) => Ok(binding),
            Err(error) => {
                self.forget_binding(&binding_id);
                Err(error.into())
            }
        }
    }

    /// Opens the cursor of `binding_id`, minted for a resume of `leg`'s conversation in a new
    /// process, on `leg`'s run, a run of `session_id`, where `leg`'s cursor stands. Fails with
    /// [`RunBindingCursorError::RunNotHeld`] for a leg whose run no session holds,
    /// [`RunBindingCursorError::SessionClosed`] for a session that closed meanwhile,
    /// [`RunBindingCursorError::Cursor`] for a binding already open, and with the read's failure.
    pub async fn open_relaunch(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
        binding_id: RuntimeBindingId,
    ) -> Result<(), RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        self.continue_binding(session_id, leg, binding_id, false)
            .await
    }

    /// Opens the cursor of `binding_id`, which a driver minted for its own resume of
    /// `session_id`'s conversation, where the cursor of the session's leg, its newest binding with
    /// a conversation, stands, and keeps the binding with that leg for the relaunch's result, until
    /// [`RunBindingCursors::take_driver_relaunch`] takes it or the session closes; an earlier one
    /// whose result never came is forgotten. A session with no leg has no cursor to carry on, and
    /// nothing opens. Fails as [`RunBindingCursors::open_relaunch`] fails.
    pub async fn open_driver_relaunch(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<(), RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        let Some(leg) = read_session_leg(&self.pool, session_id).await? else {
            return Ok(());
        };
        self.continue_binding(session_id, &leg, binding_id, true)
            .await
    }

    /// Takes the binding a driver's own relaunch of `session_id` opened and the leg it continued,
    /// for the relaunch's result; `None` when none is open.
    pub fn take_driver_relaunch(
        &self,
        session_id: SessionId,
    ) -> Option<(RuntimeBindingId, RuntimeBinding)> {
        self.lock_sessions()
            .by_session
            .get_mut(&session_id)?
            .driver_relaunch
            .take()
    }

    // Opens `binding_id`'s cursor on `leg`'s run, a run of `session_id`, where `leg`'s stands, and
    // where `is_drivers_own` keeps it with `leg` for the relaunch's result, forgetting an earlier
    // one, all under the one sessions' lock a close is heard under.
    async fn continue_binding(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
        binding_id: RuntimeBindingId,
        is_drivers_own: bool,
    ) -> Result<(), RunBindingCursorError> {
        let predecessor = epoch_binding_of(leg);
        let run = self.read_held_run(predecessor.run_id).await?;
        let mut sessions = self.lock_sessions();
        let session = sessions.open(session_id)?;
        let mut epochs = lock(&self.epochs);
        let binding = EpochBinding {
            id: binding_id.clone(),
            ..predecessor.clone()
        };
        epochs.continue_binding(binding, &predecessor.id, RUN_START_POSITION)?;
        hold(session, predecessor.run_id, binding_id.clone());
        // A leg resumed on a run that has already ended drops at the session's next binding.
        if run.state.is_terminal() {
            session.ended_run_ids.insert(predecessor.run_id);
        }
        if is_drivers_own
            && let Some((replaced_id, _)) =
                session.driver_relaunch.replace((binding_id, leg.clone()))
        {
            sessions.forget(&mut epochs, &replaced_id);
        }
        Ok(())
    }

    /// Records the binding a resume runs under, whose cursor `open_relaunch` opened, without
    /// opening it again. Fails as the store fails, its predecessor missing among the refused writes, and
    /// then forgets the binding's cursor, recording nothing.
    pub async fn record_relaunch(
        &self,
        relaunch: RuntimeBindingRelaunch,
    ) -> Result<(), RunBindingCursorError> {
        let binding_id = relaunch.binding_id.clone();
        if let Err(error) = self.store.record_relaunch(relaunch).await {
            self.forget_binding(&binding_id);
            return Err(error.into());
        }
        Ok(())
    }

    /// Forgets the cursor of a binding whose provider session never opened, or whose row was not
    /// written, wherever its run holds it; one with no cursor is already forgotten.
    pub fn forget_binding(&self, binding_id: &RuntimeBindingId) {
        let mut sessions = self.lock_sessions();
        sessions.forget(&mut lock(&self.epochs), binding_id);
    }

    /// Takes a committed session event, on the writer's pump: a run's end marks its cursors to
    /// drop and its continue unmarks them; a close drops all, and an open or a continue of the
    /// session in flight opens none. Fails when a run state change's payload does not read as its
    /// type's, changing nothing.
    pub fn observe(&self, event: &CommittedEvent) -> Result<(), SessionEventReadError> {
        let envelope = &event.envelope;
        let session_id = envelope.session_id();
        let mut sessions = self.lock_sessions();
        if envelope.event_type() == SessionEventType::SessionClosed {
            if let Some(in_flight) = sessions.in_flight.get_mut(&session_id) {
                in_flight.is_closed = true;
            }
            if let Some(mut session) = sessions.by_session.remove(&session_id) {
                let mut epochs = lock(&self.epochs);
                for run_id in session
                    .binding_ids_by_run
                    .keys()
                    .copied()
                    .collect::<Vec<_>>()
                {
                    drop_run(&mut session, &mut epochs, &run_id);
                }
            }
            return Ok(());
        }
        let Some(session) = sessions.by_session.get_mut(&session_id) else {
            return Ok(());
        };
        let Some(change) =
            read_stored_run_state_change(envelope.event_type().as_str(), envelope.payload())?
        else {
            return Ok(());
        };
        let run_id = *change.run_id();
        if !session.binding_ids_by_run.contains_key(&run_id) {
            return Ok(());
        }
        if RunState::from(change.new_state()).is_terminal() {
            session.ended_run_ids.insert(run_id);
        } else {
            // An interrupted run a send continued is live again on the same cursors.
            session.ended_run_ids.remove(&run_id);
        }
        Ok(())
    }

    // Counts an open or a continue of `session_id` in flight until the answer drops.
    fn begin(&self, session_id: SessionId) -> InFlightOperation<'_> {
        self.lock_sessions()
            .in_flight
            .entry(session_id)
            .or_insert(InFlight {
                count: 0,
                is_closed: false,
            })
            .count += 1;
        InFlightOperation {
            sessions: &self.sessions,
            session_id,
        }
    }

    // The run's row; a run no session holds is refused.
    async fn read_held_run(&self, run_id: RunId) -> Result<RunRead, RunBindingCursorError> {
        let run = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunBindingCursorError>(RunStateReader::new(reader).read_run(&run_id)?)
            })
            .await?
            .ok_or(RunBindingCursorError::RunNotHeld { run_id })?;
        #[cfg(test)]
        self.held_run_read_pause.pass().await;
        Ok(run)
    }

    // Opens `binding`'s cursor at the run's start in `session_id`'s cursors, first dropping the
    // cursors of the session's runs that have ended; refused for a session that closed meanwhile.
    fn open_held(
        &self,
        session_id: SessionId,
        binding: EpochBinding,
    ) -> Result<(), RunBindingCursorError> {
        let mut sessions = self.lock_sessions();
        let session = sessions.open(session_id)?;
        let mut epochs = lock(&self.epochs);
        for ended_run_id in std::mem::take(&mut session.ended_run_ids) {
            drop_run(session, &mut epochs, &ended_run_id);
        }
        let (run_id, binding_id) = (binding.run_id, binding.id.clone());
        epochs.open_binding(binding, RUN_START_POSITION)?;
        hold(session, run_id, binding_id);
        Ok(())
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HeldSessions> {
        lock(&self.sessions)
    }
}

// The cursor's view of a stored binding.
fn epoch_binding_of(binding: &RuntimeBinding) -> EpochBinding {
    EpochBinding {
        id: binding.id.clone(),
        run_id: binding.run_id,
        provider_name: binding.provider_name.clone(),
        provider_account_id: binding.spawn_config.provider_account_id.clone(),
    }
}

fn hold(session: &mut SessionCursors, run_id: RunId, binding_id: RuntimeBindingId) {
    session
        .binding_ids_by_run
        .entry(run_id)
        .or_default()
        .push(binding_id);
}

// Closes every cursor `run_id` holds in `session`.
fn drop_run(session: &mut SessionCursors, epochs: &mut ExecutionEpochs, run_id: &RunId) {
    for binding_id in session
        .binding_ids_by_run
        .remove(run_id)
        .unwrap_or_default()
    {
        epochs.close_binding(&binding_id);
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_provider::runtime_binding::store::{
        CreateRuntimeBindingInput, RuntimeBindingSpawnConfig,
    };
    use sidekicks_provider::runtime_binding::test_store::{
        binding_input, open_store, spawned_build,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::events::session::followers::CommittedEvent;

    use super::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursorError, RunBindingCursors};
    use crate::questions::schema::schema_parts;
    use crate::run::engine::test_fixture::insert_running_run;
    use crate::run::epochs::ExecutionEpochs;

    struct Harness {
        database: TestDatabase,
        session_id: SessionId,
        epochs: Arc<Mutex<ExecutionEpochs>>,
        cursors: RunBindingCursors,
    }

    impl Harness {
        async fn new() -> Self {
            let database = TestDatabase::new(schema_parts());
            let store = open_store(&database).await;
            let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
                NonZeroUsize::new(8).expect("the cap is not zero"),
            )));
            let cursors = RunBindingCursors::new(
                Arc::new(DatabaseReadPool::new(
                    database.path(),
                    RUN_BINDING_CURSORS_STATEMENT_CAPACITY,
                )),
                Arc::new(store),
                Arc::clone(&epochs),
            );
            Self {
                database,
                session_id: test_session_id(),
                epochs,
                cursors,
            }
        }

        // A running run of the session.
        fn run(&self) -> RunId {
            let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
            insert_running_run(&self.database, self.session_id, run_id);
            run_id
        }

        // Records a binding of `run_id` through the cursors.
        async fn bind(&self, run_id: RunId) -> RuntimeBindingId {
            self.cursors
                .create(self.session_id, binding_of(run_id))
                .await
                .expect("the binding is recorded")
                .id
        }

        // Opens a binding of `run_id` through the cursors before its row, then records the row.
        async fn bind_opened(&self, run_id: RunId) -> RuntimeBindingId {
            let input = binding_of(run_id);
            self.cursors
                .open_binding(
                    self.session_id,
                    input.id.clone(),
                    run_id,
                    input.provider_name.clone(),
                    None,
                )
                .await
                .expect("the cursor opens");
            self.cursors
                .record_opened_binding(input)
                .await
                .expect("the binding is recorded")
                .id
        }

        // Has the cursors hear `run_id` move from `from` to `to` by an event of `event_type`.
        fn hear_run_move(
            &self,
            run_id: RunId,
            event_type: SessionEventType,
            from: RunState,
            to: RunState,
        ) {
            self.hear(json!({
                "type": event_type.as_str(),
                "payload": {
                    "sessionId": self.session_id,
                    "runId": run_id,
                    "runVersion": 2,
                    "previousState": <&'static str>::from(from),
                    "newState": <&'static str>::from(to),
                },
            }));
        }

        // Has the cursors hear `event`, a session event as the wire writes it.
        fn hear(&self, event: serde_json::Value) {
            let event: SessionEvent =
                serde_json::from_value(event).expect("the test writes a session event");
            self.cursors
                .observe(&CommittedEvent {
                    envelope: Arc::new(test_envelope(self.session_id, &event)),
                    sequence: SafeInt::new(1).expect("a sequence"),
                })
                .expect("the event reads as its type");
        }

        fn is_open(&self, binding_id: &RuntimeBindingId) -> bool {
            self.epochs
                .lock()
                .expect("no test thread panics holding the cursors")
                .binding(binding_id)
                .is_ok()
        }

        // Has the cursors hear the session close.
        fn hear_close(&self) {
            self.hear(json!({
                "type": SessionEventType::SessionClosed.as_str(),
                "payload": {
                    "sessionId": self.session_id,
                    "previousState": "active",
                    "newState": "closed",
                },
            }));
        }

        // Arms a hold for each of `count` opens, once its run is read and before its cursor
        // opens; waits until all are held, has the cursors hear the session close, and lets them
        // go on.
        async fn close_while_held(&self, count: usize) {
            let holds: Vec<_> = (0..count)
                .map(|_| self.cursors.held_run_read_pause.arm())
                .collect();
            let mut releases = Vec::new();
            for hold in holds {
                hold.reached.await.expect("the open reaches its hold");
                releases.push(hold.release);
            }
            self.hear_close();
            for release in releases {
                release.send(()).expect("the open waits at its hold");
            }
        }
    }

    fn binding_of(run_id: RunId) -> CreateRuntimeBindingInput {
        CreateRuntimeBindingInput {
            run_id,
            ..binding_input(
                RuntimeBindingSpawnConfig::default(),
                spawned_build("2.0.0", "/opt/provider/bin"),
            )
        }
    }

    // Killed by a run's end dropping its cursor at once, so a late delivery finds none; by a
    // continue leaving the run marked, so the next binding drops a live run's cursor; and by the
    // next binding, opened before its row, leaving an ended run's cursor open.
    #[tokio::test]
    async fn binding_cursors_drop_an_ended_run_only_at_the_sessions_next_binding() {
        let harness = Harness::new().await;
        let first_run = harness.run();
        let first_binding = harness.bind(first_run).await;

        let completed = SessionEventType::AgentRunCompleted;
        harness.hear_run_move(first_run, completed, RunState::Running, RunState::Completed);
        assert!(
            harness.is_open(&first_binding),
            "an ended run keeps its cursor until then"
        );

        let running = SessionEventType::AgentRunRunning;
        harness.hear_run_move(first_run, running, RunState::Interrupted, RunState::Running);
        harness.bind(harness.run()).await;
        assert!(
            harness.is_open(&first_binding),
            "a continued run keeps its cursor"
        );

        harness.hear_run_move(first_run, completed, RunState::Running, RunState::Completed);
        let last_binding = harness.bind_opened(harness.run()).await;
        assert!(
            !harness.is_open(&first_binding),
            "the next binding drops the ended run's"
        );
        assert!(harness.is_open(&last_binding));
    }

    // Killed by an open that does not check for the session's close: a close heard while an open
    // awaits its read would leave a cursor and an entry for the closed session that nothing drops.
    #[tokio::test]
    async fn a_session_closed_while_its_opens_read_opens_no_cursor() {
        let harness = Harness::new().await;
        let run_id = harness.run();
        let leg = harness
            .cursors
            .create(harness.session_id, binding_of(run_id))
            .await
            .expect("the binding is recorded");
        let (minted, relaunched, opened) = (
            binding_of(run_id).id,
            binding_of(run_id).id,
            binding_of(run_id),
        );
        let session_id = harness.session_id;

        let (opened_answer, relaunch_answer, driver_relaunch_answer, ()) = tokio::join!(
            harness.cursors.open_binding(
                session_id,
                opened.id.clone(),
                run_id,
                opened.provider_name,
                None,
            ),
            harness
                .cursors
                .open_relaunch(session_id, &leg, minted.clone()),
            harness
                .cursors
                .open_driver_relaunch(session_id, relaunched.clone()),
            harness.close_while_held(3),
        );

        for answer in [opened_answer, relaunch_answer, driver_relaunch_answer] {
            assert!(
                matches!(
                    answer,
                    Err(RunBindingCursorError::SessionClosed { session_id: closed })
                        if closed == session_id
                ),
                "{answer:?}"
            );
        }
        for binding_id in [&leg.id, &opened.id, &minted, &relaunched] {
            assert!(!harness.is_open(binding_id), "no cursor stays open");
        }
        assert!(
            harness.cursors.lock_sessions().by_session.is_empty(),
            "no entry outlives the session"
        );
    }

    // Killed by a close mark the last open in flight leaves behind, which the cursors would keep
    // for every session that ever closed.
    #[tokio::test]
    async fn a_close_mark_goes_with_the_last_open_in_flight() {
        let harness = Harness::new().await;
        let run_id = harness.run();
        let opened = binding_of(run_id);

        let (answer, ()) = tokio::join!(
            harness.cursors.open_binding(
                harness.session_id,
                opened.id,
                run_id,
                opened.provider_name,
                None,
            ),
            harness.close_while_held(1),
        );

        assert!(
            matches!(answer, Err(RunBindingCursorError::SessionClosed { .. })),
            "{answer:?}"
        );
        assert!(
            harness.cursors.lock_sessions().in_flight.is_empty(),
            "no mark outlives the opens"
        );
    }
}

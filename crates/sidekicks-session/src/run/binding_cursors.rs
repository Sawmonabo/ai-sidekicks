//! The epoch cursor of each run's runtime binding. It opens as the binding is recorded, at the
//! start every run opens at, and drops once its run has ended and the session has recorded a newer
//! binding, or the session closed, so the provider's last deliveries on an ended run still find it
//! and are absorbed as late, and a session holds the cursors of its newest bindings alone. A
//! binding a driver mints when it resumes a session in a new process carries its predecessor's
//! cursor on, opened before its row is written, since the resumed provider delivers under it at
//! once.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBinding, RuntimeBindingRelaunch, RuntimeBindingStore,
    RuntimeBindingStoreError, read_binding,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::followers::CommittedEvent;

use crate::run::epochs::{EpochBinding, EpochCursorError, ExecutionEpochs};
use crate::run::read::{RunRead, RunStateReader};
use crate::run::stored_state_change::read_stored_run_state_change;

/// The statements the cursors prepare on a pooled connection: a run's row and a binding's row.
pub const RUN_BINDING_CURSORS_STATEMENT_CAPACITY: usize = 2;

/// Why a binding was not recorded or its cursor not opened; a binding whose cursor did not open
/// is not recorded.
#[derive(Debug, thiserror::Error)]
pub enum RunBindingCursorError {
    /// No session holds the run, so no binding is recorded for it.
    #[error("run {run_id} is held by no session, so no binding is recorded for it")]
    RunNotHeld {
        /// The run.
        run_id: RunId,
    },
    /// The binding a relaunch resumes from has no row.
    #[error("runtime binding {} has no row to resume from", .binding_id.as_str())]
    PredecessorMissing {
        /// The predecessor.
        binding_id: RuntimeBindingId,
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
}

// One session's bindings with a cursor open, and the ended runs whose cursors wait to drop.
#[derive(Default)]
struct SessionCursors {
    binding_ids_by_run: HashMap<RunId, Vec<RuntimeBindingId>>,
    ended_run_ids: HashSet<RunId>,
}

/// Records each run's binding with its epoch cursor open, and drops the cursors runs left. The
/// sessions' lock is taken before the cursors' and neither is held across an await.
pub struct RunBindingCursors {
    pool: Arc<DatabaseReadPool>,
    store: Arc<RuntimeBindingStore>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    sessions: Mutex<HashMap<SessionId, SessionCursors>>,
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
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Records a binding of a run in the store and opens its cursor at the run's start, dropping
    /// the cursors of the session's runs that have ended. Fails with
    /// [`RunBindingCursorError::RunNotHeld`] for a run no session holds, recording nothing, and
    /// with the store's or the read's failure.
    pub async fn create(
        &self,
        input: CreateRuntimeBindingInput,
    ) -> Result<RuntimeBinding, RunBindingCursorError> {
        let run = self.read_held_run(input.run_id).await?;
        let binding = self.store.create(input).await?;
        let mut sessions = self.lock_sessions();
        let session = sessions.entry(run.session_id).or_default();
        let mut epochs = lock(&self.epochs);
        for ended_run_id in std::mem::take(&mut session.ended_run_ids) {
            drop_run(session, &mut epochs, &ended_run_id);
        }
        epochs
            .open_binding(epoch_binding_of(&binding), RUN_START_POSITION)
            .expect("the store minted the binding's id, so no cursor holds it");
        hold(session, binding.run_id, binding.id.clone());
        Ok(binding)
    }

    /// Opens the cursor of `binding_id`, which a driver minted when it resumed `predecessor`'s
    /// conversation in a new process, on `predecessor`'s run, where `predecessor`'s cursor stands.
    /// Fails with [`RunBindingCursorError::RunNotHeld`] for a run no session holds, with
    /// [`RunBindingCursorError::Cursor`] for a binding that already has a cursor, and with the
    /// read's failure.
    pub(crate) async fn continue_binding(
        &self,
        predecessor: &EpochBinding,
        binding_id: RuntimeBindingId,
    ) -> Result<(), RunBindingCursorError> {
        let run = self.read_held_run(predecessor.run_id).await?;
        let mut sessions = self.lock_sessions();
        let session = sessions.entry(run.session_id).or_default();
        let binding = EpochBinding {
            id: binding_id.clone(),
            ..predecessor.clone()
        };
        lock(&self.epochs).continue_binding(binding, &predecessor.id, RUN_START_POSITION)?;
        hold(session, predecessor.run_id, binding_id);
        // A leg resumed on a run that has already ended drops at the session's next binding.
        if run.state.is_terminal() {
            session.ended_run_ids.insert(predecessor.run_id);
        }
        Ok(())
    }

    /// Records the binding a resume minted, with its cursor opened first as
    /// [`RunBindingCursors::continue_binding`] opens it. Fails with
    /// [`RunBindingCursorError::PredecessorMissing`] for a predecessor the store does not hold,
    /// and as the cursor's open or the store fails, recording nothing and leaving no cursor open.
    pub async fn record_relaunch(
        &self,
        relaunch: RuntimeBindingRelaunch,
    ) -> Result<(), RunBindingCursorError> {
        let predecessor_id = relaunch.predecessor_id.clone();
        let predecessor = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunBindingCursorError>(read_binding(reader, &predecessor_id)?)
            })
            .await?
            .ok_or_else(|| RunBindingCursorError::PredecessorMissing {
                binding_id: relaunch.predecessor_id.clone(),
            })?;
        let binding_id = relaunch.binding_id.clone();
        self.continue_binding(&epoch_binding_of(&predecessor), binding_id.clone())
            .await?;
        if let Err(error) = self.store.record_relaunch(relaunch).await {
            self.forget_binding(&binding_id);
            return Err(error.into());
        }
        Ok(())
    }

    /// Takes a committed session event, on the writer's pump: a run's end marks its cursors to
    /// drop and its continue unmarks them; a close drops all. Fails when a run state change's
    /// payload does not read as its type's, changing nothing.
    pub fn observe(&self, event: &CommittedEvent) -> Result<(), SessionEventReadError> {
        let envelope = &event.envelope;
        let mut sessions = self.lock_sessions();
        let Some(session) = sessions.get_mut(&envelope.session_id()) else {
            return Ok(());
        };
        if envelope.event_type() == SessionEventType::SessionClosed {
            let mut epochs = lock(&self.epochs);
            for run_id in session
                .binding_ids_by_run
                .keys()
                .copied()
                .collect::<Vec<_>>()
            {
                drop_run(session, &mut epochs, &run_id);
            }
            sessions.remove(&envelope.session_id());
            return Ok(());
        }
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

    // The run's row; a run no session holds is refused.
    async fn read_held_run(&self, run_id: RunId) -> Result<RunRead, RunBindingCursorError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunBindingCursorError>(RunStateReader::new(reader).read_run(&run_id)?)
            })
            .await?
            .ok_or(RunBindingCursorError::RunNotHeld { run_id })
    }

    // Closes one binding's cursor, which no row records, wherever its run holds it.
    fn forget_binding(&self, binding_id: &RuntimeBindingId) {
        let mut sessions = self.lock_sessions();
        lock(&self.epochs).close_binding(binding_id);
        for session in sessions.values_mut() {
            for binding_ids in session.binding_ids_by_run.values_mut() {
                binding_ids.retain(|held| held != binding_id);
            }
        }
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<SessionId, SessionCursors>> {
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

    use super::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursors};
    use crate::questions::schema::schema_parts;
    use crate::run::engine::tests::insert_running_run;
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
                .create(CreateRuntimeBindingInput {
                    run_id,
                    ..binding_input(
                        RuntimeBindingSpawnConfig::default(),
                        spawned_build("2.0.0", "/opt/provider/bin"),
                    )
                })
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
            let event: SessionEvent = serde_json::from_value(json!({
                "type": event_type.as_str(),
                "payload": {
                    "sessionId": self.session_id,
                    "runId": run_id,
                    "runVersion": 2,
                    "previousState": <&'static str>::from(from),
                    "newState": <&'static str>::from(to),
                },
            }))
            .expect("the test writes a run state change");
            self.cursors
                .observe(&CommittedEvent {
                    envelope: Arc::new(test_envelope(self.session_id, &event)),
                    sequence: SafeInt::new(1).expect("a sequence"),
                })
                .expect("the change reads as its type");
        }

        fn is_open(&self, binding_id: &RuntimeBindingId) -> bool {
            self.epochs
                .lock()
                .expect("no test thread panics holding the cursors")
                .binding(binding_id)
                .is_ok()
        }
    }

    // Killed by a run's end dropping its cursor at once, so a late delivery finds none; by a
    // continue leaving the run marked, so the next binding drops a live run's cursor; and by the
    // next binding leaving an ended run's cursor open.
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
        let last_binding = harness.bind(harness.run()).await;
        assert!(
            !harness.is_open(&first_binding),
            "the next binding drops the ended run's"
        );
        assert!(harness.is_open(&last_binding));
    }
}

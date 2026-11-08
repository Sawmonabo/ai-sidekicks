//! The epoch cursor of each run's runtime binding. It opens where the run stands at its log's end,
//! read before any lock, as the binding is recorded (read again once its row is written, so a
//! rollback committed meanwhile is not missed) or, for a binding its caller minted, before its row
//! is written, and drops once its run has ended and the session has opened a newer binding, or the
//! session closed, so the provider's last deliveries on an ended run still find it and are absorbed
//! as late, and a session holds the cursors of its newest bindings alone. A binding minted for a
//! resume of a session in a new process carries the cursor of the session's leg on, opened before
//! the resume runs, since the resumed provider delivers under it at once. A cursor whose row is not
//! written is forgotten, and an open whose session closes while it reads opens none. An undo's
//! confirmed cut is fenced here, where a fork's binding joins its run's cursors. The drivers write
//! their bindings through the cursors, so a binding moved onto another account moves its cursor
//! too.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_provider::account::observer::AccountLiveTurns;
use sidekicks_provider::driver::session_control::SessionToolServer;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBinding, RuntimeBindingRebind, RuntimeBindingRelaunch,
    RuntimeBindingStore, RuntimeBindingStoreError,
};
use sidekicks_provider::runtime_binding::writer::RuntimeBindingWriter;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::followers::CommittedEvent;
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};

use crate::run::epochs::{ConfirmedCut, EpochBinding, EpochCursorError, ExecutionEpochs};
use crate::run::read::{RunRead, RunStateReader};
use crate::run::stored_leg::read_session_leg;
use crate::run::stored_state_change::read_stored_run_state_change;
use crate::transcript::turn_attribution::{RunTurnReads, TurnAttributionError};

/// The statements the cursors prepare on a pooled connection: a run's row, a session's run ids and
/// their bindings for its leg, and the run's rollbacks and turn starts its standing is read from.
pub const RUN_BINDING_CURSORS_STATEMENT_CAPACITY: usize = 3 + 2;

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
    /// Where the run stands could not be read from its log.
    #[error("where the run stands could not be read from its log")]
    Standing(#[from] TurnAttributionError),
    /// The session closed while the open read, so no cursor opens for it.
    #[error("session {session_id} closed while its cursor opened, so none opens")]
    SessionClosed {
        /// The session.
        session_id: SessionId,
    },
    /// The run's read after its binding's row was written failed, and removing that row failed
    /// too, so the row stays with no cursor.
    #[error(transparent)]
    RowNotRemoved(Box<CleanupFailures<RunBindingCursorError, RuntimeBindingStoreError>>),
}

// One session's bindings with a cursor open, the ended runs whose cursors wait to drop, and the
// binding a driver's own relaunch opened with the leg it continued, until its result is recorded.
#[derive(Default)]
struct SessionCursors {
    binding_ids_by_run: HashMap<RunId, Vec<RuntimeBindingId>>,
    ended_run_ids: HashSet<RunId>,
    driver_relaunch: Option<(RuntimeBindingId, RuntimeBinding)>,
    // The binding held last, which the session runs on now, until its run's cursors drop.
    current_binding: Option<(RunId, RuntimeBindingId)>,
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
            if session
                .current_binding
                .as_ref()
                .is_some_and(|(_, current)| current == binding_id)
            {
                session.current_binding = None;
            }
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
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    store: Arc<RuntimeBindingStore>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    sessions: Mutex<HeldSessions>,
    /// Holds an open once its run is read, before its cursor opens.
    #[cfg(test)]
    held_run_read_pause: sidekicks_std::pause_point::PausePoint,
}

impl RunBindingCursors {
    /// Cursors over `epochs`, the ones the inbound dispatch attributes on, reading runs, their logs
    /// and bindings through `pool`, no log read passing where `read_damaged_from_sequence` stops a
    /// damaged session, and recording bindings through `store`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
        store: Arc<RuntimeBindingStore>,
        epochs: Arc<Mutex<ExecutionEpochs>>,
    ) -> Self {
        Self {
            pool,
            read_damaged_from_sequence,
            store,
            epochs,
            sessions: Mutex::new(HeldSessions::default()),
            #[cfg(test)]
            held_run_read_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// Records a binding of a run of `session_id` in the store and opens its cursor where the run
    /// stands at its log's end once the row is written, dropping the cursors of the session's runs
    /// that have ended. Fails with [`RunBindingCursorError::RunNotHeld`] for a run no session holds
    /// and with the store's or the read's failure, recording nothing (a row written before the
    /// read failed is removed, or [`RunBindingCursorError::RowNotRemoved`] says it stays), and
    /// with [`RunBindingCursorError::SessionClosed`] for a session that closed meanwhile, its row
    /// recorded and no cursor opened.
    pub async fn create(
        &self,
        session_id: SessionId,
        input: CreateRuntimeBindingInput,
    ) -> Result<RuntimeBinding, RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        let run_id = input.run_id;
        self.read_held_run(run_id).await?;
        let binding = self.store.create(input).await?;
        // Read after the write, so a rollback committed while the row was written moves the
        // cursor into the epoch it opened; a failed read removes the row it would have opened on.
        let standing = match self.read_held_run(run_id).await {
            Ok((_, standing)) => standing,
            Err(failure) => {
                return Err(match self.store.delete(&binding.id).await {
                    Ok(_) => failure,
                    Err(removal) => RunBindingCursorError::RowNotRemoved(Box::new(
                        CleanupFailures::new(failure, vec![removal], "recording a binding"),
                    )),
                });
            }
        };
        self.open_held(session_id, epoch_binding_of(&binding), standing)?;
        Ok(binding)
    }

    /// Opens the cursor of the binding `binding_id` the caller minted for `run_id`, a run of
    /// `session_id`, where the run stands at its log's end, before its row is written, so the
    /// provider can deliver under it at once, dropping the cursors of the session's runs that have
    /// ended. Fails with [`RunBindingCursorError::RunNotHeld`] for a run no session holds,
    /// [`RunBindingCursorError::SessionClosed`] for a session that closed meanwhile and
    /// [`RunBindingCursorError::Cursor`] for a binding already open, and with the read's failure.
    pub async fn open_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
        run_id: RunId,
        provider_name: ProviderId,
        provider_account_id: ProviderAccountId,
    ) -> Result<(), RunBindingCursorError> {
        let _in_flight = self.begin(session_id);
        let (_, standing) = self.read_held_run(run_id).await?;
        self.open_held(
            session_id,
            EpochBinding {
                id: binding_id,
                run_id,
                provider_name,
                provider_account_id,
            },
            standing,
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
    /// process, on `leg`'s run, a run of `session_id`, where `leg`'s cursor stands, else where the
    /// run stands at its log's end. Fails with [`RunBindingCursorError::RunNotHeld`] for a leg
    /// whose run no session holds, [`RunBindingCursorError::SessionClosed`] for a session that
    /// closed meanwhile, [`RunBindingCursorError::Cursor`] for a binding already open, and with the
    /// read's failure.
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
    /// a conversation, stands, else where the leg's run stands at its log's end, and keeps the
    /// binding with that leg for the relaunch's result, until
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

    // Opens `binding_id`'s cursor on `leg`'s run, a run of `session_id`, where `leg`'s stands, else
    // where the run stands at its log's end, and where `is_drivers_own` keeps it with `leg` for the
    // relaunch's result, forgetting an earlier one, all under the one sessions' lock a close is
    // heard under.
    async fn continue_binding(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
        binding_id: RuntimeBindingId,
        is_drivers_own: bool,
    ) -> Result<(), RunBindingCursorError> {
        let predecessor = epoch_binding_of(leg);
        let (run, standing) = self.read_held_run(predecessor.run_id).await?;
        let mut sessions = self.lock_sessions();
        let session = sessions.open(session_id)?;
        let mut epochs = lock(&self.epochs);
        let binding = EpochBinding {
            id: binding_id.clone(),
            ..predecessor.clone()
        };
        epochs.continue_binding(binding, &predecessor.id, standing)?;
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

    /// Records the binding a resume or a fork restart runs under, whose cursor `open_relaunch` or
    /// the fork restart's `fence_cut` opened, without opening it again. Fails as the store fails,
    /// its predecessor missing among the refused writes, and then forgets the binding's cursor,
    /// recording nothing.
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

    /// Sets the fence of `cut` once its rollback is written, so a delivery from before the cut is
    /// told apart from the new epoch's. A fork and restart holds the fork's binding as the run's,
    /// and the session's current one, so its cursor drops with the run's. Fails as
    /// [`ExecutionEpochs::fence_cut`] fails, fencing nothing.
    pub fn fence_cut(&self, cut: ConfirmedCut) -> Result<(), EpochCursorError> {
        let mut sessions = self.lock_sessions();
        let mut epochs = lock(&self.epochs);
        let ConfirmedCut::ForkRestart {
            binding_id,
            new_binding_id,
            ..
        } = cut.clone()
        else {
            return epochs.fence_cut(cut);
        };
        let run_id = epochs.binding(&binding_id)?.run_id;
        // Found before the fence changes the epochs, so nothing moves unless the fork's cursor is
        // held too.
        let session = sessions
            .by_session
            .values_mut()
            .find(|session| {
                session
                    .binding_ids_by_run
                    .get(&run_id)
                    .is_some_and(|binding_ids| binding_ids.contains(&binding_id))
            })
            .expect("every open cursor is held by its session under the same two locks");
        epochs.fence_cut(cut)?;
        hold(session, run_id, new_binding_id);
        Ok(())
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

    /// Whether `binding_id`'s cursor is open, for a test that reads the cursors from outside.
    #[cfg(any(test, feature = "test-support"))]
    pub fn is_binding_open(&self, binding_id: &RuntimeBindingId) -> bool {
        lock(&self.epochs).binding(binding_id).is_ok()
    }

    /// The binding `session_id` runs on now: the one its cursors recorded or continued last,
    /// `None` once that run's cursors dropped or the session closed.
    pub fn current_binding(&self, session_id: &SessionId) -> Option<RuntimeBindingId> {
        self.lock_sessions()
            .by_session
            .get(session_id)
            .and_then(|session| session.current_binding.as_ref())
            .map(|(_, binding_id)| binding_id.clone())
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

    // The run's row and where the run stands at its log's end, on one pooled connection; a run no
    // session holds is refused.
    async fn read_held_run(
        &self,
        run_id: RunId,
    ) -> Result<(RunRead, EpochPosition), RunBindingCursorError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let held = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let Some(run) = RunStateReader::new(reader).read_run(&run_id)? else {
                    return Ok::<_, RunBindingCursorError>(None);
                };
                let log_end =
                    session_read_bound(&*read_damaged_from_sequence, &run.session_id, None);
                let standing = RunTurnReads::new(reader, &*read_damaged_from_sequence)
                    .read_standing_before(&run.session_id, &run_id, log_end)?;
                Ok(Some((run, standing)))
            })
            .await?
            .ok_or(RunBindingCursorError::RunNotHeld { run_id })?;
        #[cfg(test)]
        self.held_run_read_pause.pass().await;
        Ok(held)
    }

    // Opens `binding`'s cursor at `standing`, where its run stands, in `session_id`'s cursors,
    // first dropping the cursors of the session's runs that have ended; refused for a session that
    // closed meanwhile.
    fn open_held(
        &self,
        session_id: SessionId,
        binding: EpochBinding,
        standing: EpochPosition,
    ) -> Result<(), RunBindingCursorError> {
        let mut sessions = self.lock_sessions();
        let session = sessions.open(session_id)?;
        let mut epochs = lock(&self.epochs);
        for ended_run_id in std::mem::take(&mut session.ended_run_ids) {
            drop_run(session, &mut epochs, &ended_run_id);
        }
        let (run_id, binding_id) = (binding.run_id, binding.id.clone());
        epochs.open_binding(binding, standing)?;
        hold(session, run_id, binding_id);
        Ok(())
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HeldSessions> {
        lock(&self.sessions)
    }
}

impl AccountLiveTurns for RunBindingCursors {
    /// The sessions holding a run not yet ended on a binding under `provider_account_id`.
    fn sessions_with_live_turns(&self, provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        let sessions = self.lock_sessions();
        let epochs = lock(&self.epochs);
        sessions
            .by_session
            .iter()
            .filter(|(_, session)| {
                session
                    .binding_ids_by_run
                    .iter()
                    .filter(|(run_id, _)| !session.ended_run_ids.contains(run_id))
                    .flat_map(|(_, binding_ids)| binding_ids)
                    .any(|binding_id| {
                        epochs.binding(binding_id).is_ok_and(|binding| {
                            binding.provider_account_id == *provider_account_id
                        })
                    })
            })
            .map(|(session_id, _)| *session_id)
            .collect()
    }
}

/// The store's writes, the account move also moving the binding's open cursor, so the sessions
/// with a live turn on an account are the ones running on it now.
impl RuntimeBindingWriter for RunBindingCursors {
    fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.store.rebind(rebind)
    }

    fn keep_recovery_data(
        &self,
        binding_id: RuntimeBindingId,
        runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.store.keep_recovery_data(binding_id, runtime_metadata)
    }

    /// Fails as the store's move fails, the cursor then left on the account it was on.
    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            RuntimeBindingWriter::move_account(
                &*self.store,
                binding_id.clone(),
                provider_account_id.clone(),
            )
            .await?;
            lock(&self.epochs).move_account(&binding_id, provider_account_id);
            Ok(())
        }
        .boxed()
    }

    fn replace_tool_servers(
        &self,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        RuntimeBindingWriter::replace_tool_servers(&*self.store, run_id, tool_servers)
    }
}

/// The cursor's view of a stored binding.
pub(crate) fn epoch_binding_of(binding: &RuntimeBinding) -> EpochBinding {
    EpochBinding {
        id: binding.id.clone(),
        run_id: binding.run_id,
        provider_name: binding.provider_name.clone(),
        provider_account_id: binding.spawn_config.provider_account_id.clone(),
    }
}

fn hold(session: &mut SessionCursors, run_id: RunId, binding_id: RuntimeBindingId) {
    session.current_binding = Some((run_id, binding_id.clone()));
    session
        .binding_ids_by_run
        .entry(run_id)
        .or_default()
        .push(binding_id);
}

// Closes every cursor `run_id` holds in `session`.
fn drop_run(session: &mut SessionCursors, epochs: &mut ExecutionEpochs, run_id: &RunId) {
    if session
        .current_binding
        .as_ref()
        .is_some_and(|(current_run_id, _)| current_run_id == run_id)
    {
        session.current_binding = None;
    }
    for binding_id in session
        .binding_ids_by_run
        .remove(run_id)
        .unwrap_or_default()
    {
        epochs.close_binding(&binding_id);
    }
}

#[cfg(test)]
mod tests;

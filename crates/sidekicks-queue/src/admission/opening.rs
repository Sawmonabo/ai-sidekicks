//! The item each run the queue starts or continues opens with: the table of openings whose
//! outcome is not yet written, with the openings an undo's release reserved beside it; the lock a
//! read of a run's opening takes once no undo holds the session; the driver's start of the run's
//! turn with it; and the admission and binding of a turn the daemon starts on a session itself,
//! which opens a session this daemon has not opened as an admitted run does, after a place at the
//! memory gate.

use std::collections::HashMap;
use std::error::Error;
use std::mem::ManuallyDrop;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::params_and_results::{
    RunOpening, RunOpeningItem, StartRunParams,
};
use sidekicks_provider::driver::run_control::{
    DaemonTurnAdmission, DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
    DaemonTurnProcess, InterruptRunRequest,
};
use sidekicks_session::console_state::read_session_max_steps_per_turn;
use sidekicks_session::queue_store::{QueueItemBody, QueueItemReader, QueueItemRecord};
use sidekicks_session::run::agent::read_lead_agent_through;
use sidekicks_session::run::start_request::RunTurnStart;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use super::{Placed, QueueAdmission};
use crate::delivery::OpeningMessages;
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;

/// The message each run being started or continued opens with, until the start writes its
/// outcome, and beside them the item an undo's release reserved as a run's opening, which the run's
/// read of its opening takes first and which no outcome is ever written for.
#[derive(Default)]
pub(crate) struct RunOpenings {
    table: Mutex<OpeningsTable>,
}

// The openings and the reservations, behind the one mutex.
#[derive(Default)]
struct OpeningsTable {
    by_run: HashMap<RunId, QueueItemRecord>,
    reserved_by_run: HashMap<RunId, QueueItemId>,
}

impl RunOpenings {
    /// The opening of `run_id`, if one is recorded; a reservation is never one.
    pub(super) fn get(&self, run_id: RunId) -> Option<QueueItemRecord> {
        self.lock().by_run.get(&run_id).cloned()
    }

    /// Forgets the opening of `run_id`, answering it.
    pub(super) fn remove(&self, run_id: RunId) -> Option<QueueItemRecord> {
        self.lock().by_run.remove(&run_id)
    }

    // The table. No holder awaits or panics while it changes, so a poisoned lock still guards a
    // whole table.
    fn lock(&self) -> MutexGuard<'_, OpeningsTable> {
        lock(&self.table)
    }
}

impl OpeningMessages for RunOpenings {
    // One a newer lead run took over waits for that run, whose to hand it is.
    fn is_opening(&self, item: &QueueItemRecord) -> bool {
        item.target_run_id.is_some_and(|run_id| {
            let table = self.lock();
            table
                .by_run
                .get(&run_id)
                .is_some_and(|opening| opening.id == item.id)
                || table.reserved_by_run.get(&run_id) == Some(&item.id)
        })
    }

    fn take_reserved(&self, run_id: RunId) -> Option<QueueItemId> {
        self.lock().reserved_by_run.remove(&run_id)
    }
}

/// The reservation of a run whose start or continue has not yet read its opening: dropped, with
/// no write, at whatever exit leaves before that read, and handed to the read by
/// [`QueueAdmission::take_opening`], which consumes it.
pub(super) struct PendingReservation<'admission> {
    admission: &'admission QueueAdmission,
    run_id: RunId,
}

impl PendingReservation<'_> {
    // The run, the guard spent without its drop.
    fn into_run_id(self) -> RunId {
        ManuallyDrop::new(self).run_id
    }
}

impl Drop for PendingReservation<'_> {
    fn drop(&mut self) {
        self.admission.drop_reservation(self.run_id);
    }
}

impl QueueAdmission {
    /// Guards the reservation of `run_id` for its start or continue, taken first thing, so an exit
    /// before the read of its opening, an error among them, leaves no reservation behind.
    pub(super) fn pending_reservation(&self, run_id: RunId) -> PendingReservation<'_> {
        PendingReservation {
            admission: self,
            run_id,
        }
    }

    /// Takes the session's queue lock for a read of a run's opening, once no undo holds the
    /// session: while one does, the lock is let go until the undo's release and taken again, as
    /// often as another undo holds it meanwhile. Answers only a hold taken with no undo holding.
    pub(super) async fn hold_session_for_opening(
        &self,
        session_id: SessionId,
    ) -> KeyHold<'_, SessionId> {
        #[cfg(test)]
        self.head_read_pause.pass().await;
        loop {
            let hold = self.deps.session_lock.hold_session(session_id).await;
            let Some(mut release) = self.deps.delivery.undo_release(session_id) else {
                return hold;
            };
            // The release takes the same lock, so it is let go before the wait.
            drop(hold);
            // The signal sends nothing, so its wait ends as it closes, with its hold.
            drop(release.changed().await);
        }
    }

    /// Records the opening of the run `pending` guards among `candidates`, the waiting items its
    /// read found, and answers it: the item reserved for the run when `candidates` still holds it,
    /// else the first. The run's reservation is taken whatever is answered, so a read that finds
    /// nothing to open with leaves none behind. Called under the session's queue lock.
    pub(super) fn take_opening(
        &self,
        pending: PendingReservation<'_>,
        candidates: &[QueueItemRecord],
    ) -> Option<QueueItemRecord> {
        let run_id = pending.into_run_id();
        let mut table = self.deps.openings.lock();
        let reserved = table.reserved_by_run.remove(&run_id);
        let opening = reserved
            .and_then(|reserved| candidates.iter().find(|item| item.id == reserved))
            .or_else(|| candidates.first())
            .cloned()?;
        table.by_run.insert(run_id, opening.clone());
        Some(opening)
    }

    /// Reserves `item_id` as the opening of `run_id`, replacing any earlier reservation of the run,
    /// so the run's next read of its opening takes it whatever the queue's order says and no hand,
    /// take-back or reorder moves it meanwhile. Called under the session's queue lock.
    pub(crate) fn reserve_opening(&self, run_id: RunId, item_id: QueueItemId) {
        self.deps
            .openings
            .lock()
            .reserved_by_run
            .insert(run_id, item_id);
    }

    /// Drops the reservation of `run_id`, writing nothing, so the item waits as any message does.
    pub(crate) fn drop_reservation(&self, run_id: RunId) {
        self.deps.openings.lock().reserved_by_run.remove(&run_id);
    }

    /// Drops the reservation of `run_id` only while it still names `item_id`, leaving one a later
    /// undo made in its place.
    pub(crate) fn drop_reservation_naming(&self, run_id: RunId, item_id: QueueItemId) {
        let mut table = self.deps.openings.lock();
        if table.reserved_by_run.get(&run_id) == Some(&item_id) {
            table.reserved_by_run.remove(&run_id);
        }
    }

    /// The turn start of `run_id` opening with `opening`: the driver's start of it once the run's
    /// setup gates pass, and its interrupt. A continue's start is given up when a newer lead run
    /// took the opening over while the gates ran.
    pub(super) fn turn_start(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
        driver: &Arc<dyn ProviderDriver>,
        opening: &QueueItemRecord,
        execution_posture: ExecutionPosture,
        is_continue: bool,
    ) -> RunTurnStart {
        let start_driver = {
            let admission = Arc::clone(self);
            let driver = Arc::clone(driver);
            let opening = opening.clone();
            move |resolved_posture: ExecutionPosture| {
                let admission = Arc::clone(&admission);
                let driver = Arc::clone(&driver);
                let opening = opening.clone();
                async move {
                    admission
                        .start_driver(
                            session_id,
                            run_id,
                            driver.as_ref(),
                            opening,
                            resolved_posture,
                            is_continue,
                        )
                        .await
                        .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
                }
                .boxed()
            }
        };
        let interrupt_driver = {
            let driver = Arc::clone(driver);
            move || {
                let driver = Arc::clone(&driver);
                async move {
                    driver
                        .interrupt_run(InterruptRunRequest {
                            run_id,
                            reason: None,
                        })
                        .await
                        .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
                }
                .boxed()
            }
        };
        RunTurnStart {
            run_id,
            workspace_id: opening
                .body
                .as_message()
                .and_then(|message| message.workspace_id),
            execution_posture,
            start_driver: Box::new(start_driver),
            interrupt_driver: Box::new(interrupt_driver),
        }
    }

    // Opens the session's provider session once the setup gates have made its working folder,
    // waits for its process to settle, then hands the driver the run's opening on the run's own
    // binding, opened on the leg the process settled on.
    async fn start_driver(
        &self,
        session_id: SessionId,
        run_id: RunId,
        driver: &dyn ProviderDriver,
        opening: QueueItemRecord,
        execution_posture: ExecutionPosture,
        is_continue: bool,
    ) -> Result<(), QueueError> {
        if is_continue {
            let opening_id = opening.id;
            let current = self
                .deps
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, QueueError>(QueueItemReader::new(reader).get(&opening_id)?)
                })
                .await?;
            if current.and_then(|current| current.target_run_id) != Some(run_id) {
                return Err(QueueError::ContinueTakenOver { run_id });
            }
        }
        self.deps.provider_sessions.open(session_id, run_id).await?;
        self.settle_session(session_id, driver).await?;
        let binding_id = self
            .deps
            .provider_sessions
            .open_run_binding(run_id, session_id)
            .await?;
        let agent_id = read_lead_agent_through::<QueueError>(&self.deps.pool, session_id).await?;
        let step_bound = read_step_bound(&self.deps.pool, session_id).await?;
        // Skill picks, files and the turn's own output speed ride a message only.
        let (item, output_speed_for_turn) = match opening.body {
            QueueItemBody::Message(message) => (
                RunOpeningItem::Message {
                    attachments: message.attachment_ids(),
                    skills: message.skills.unwrap_or_default(),
                    content: message.content,
                },
                message.output_speed_for_turn,
            ),
            QueueItemBody::Review { target } => (RunOpeningItem::Review { target }, None),
            // A plan message opens its run as a message of its words alone.
            QueueItemBody::PlanMessage { text, .. } => (
                RunOpeningItem::Message {
                    attachments: Vec::new(),
                    skills: Vec::new(),
                    content: text.into(),
                },
                None,
            ),
        };
        driver
            .start_run(StartRunParams {
                run_id,
                opening: RunOpening {
                    session_id,
                    binding_id,
                    agent_id,
                    message_id: opening.id,
                    item,
                },
                conversation_history: None,
                output_speed: None,
                options: Vec::new(),
                output_speed_for_turn,
                execution_posture: Some(execution_posture),
                output_schema: None,
                step_bound,
            })
            .await?;
        Ok(())
    }
}

impl DaemonTurnBindingResolver for QueueAdmission {
    fn open_daemon_turn_binding(
        &self,
        run_id: RunId,
        session_id: SessionId,
        process: DaemonTurnProcess,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        async move {
            let not_recorded = |error: QueueError| DaemonTurnBindingError::BindingNotRecorded {
                session_id,
                source: Box::new(error),
            };
            // A process this daemon opened is bound as it stands: the turn may be opening on that
            // process's own task, so it waits for no settle a transition queued behind it holds. A
            // live-only turn opens none: the bind checks the process under its own lock, so one
            // let go meanwhile answers `NoProviderSession`.
            if process == DaemonTurnProcess::OpenWhenAbsent
                && !self.deps.provider_sessions.is_opened(session_id)
            {
                let (provider, admitted_account, driver) = self
                    .admit_session_account(session_id)
                    .await
                    .map_err(|error| not_admitted(session_id, error))?;
                // The process start waits its turn at the gate, weighed on the admitted account;
                // the place is the run's until the run ends.
                let placed = self
                    .take_place(
                        &provider,
                        admitted_account,
                        driver.as_ref(),
                        session_id,
                        run_id,
                    )
                    .await
                    .map_err(|error| not_admitted(session_id, error))?;
                match placed {
                    Placed::Admitted => {}
                    Placed::Released | Placed::TimedOut => {
                        return Err(DaemonTurnBindingError::NotAdmitted {
                            session_id,
                            source: Box::new(NotPlaced { run_id }),
                        });
                    }
                }
                self.deps
                    .provider_sessions
                    .open(session_id, run_id)
                    .await
                    .map_err(|error| binding_not_opened(session_id, error))?;
                self.settle_session(session_id, driver.as_ref())
                    .await
                    .map_err(not_recorded)?;
            }
            let binding_id = self
                .deps
                .provider_sessions
                .open_run_binding(run_id, session_id)
                .await
                .map_err(|error| binding_not_opened(session_id, error))?;
            let agent_id = read_lead_agent_through::<QueueError>(&self.deps.pool, session_id)
                .await
                .map_err(not_recorded)?;
            let step_bound = read_step_bound(&self.deps.pool, session_id)
                .await
                .map_err(not_recorded)?;
            Ok(DaemonTurnBinding {
                binding_id,
                agent_id,
                step_bound,
            })
        }
        .boxed()
    }

    fn admit_daemon_turn(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
        async move {
            let (_provider, admitted_provider_account_id, _driver) = self
                .admit_session_account(session_id)
                .await
                .map_err(|error| not_admitted(session_id, error))?;
            let execution_posture = self
                .deps
                .provider_sessions
                .read_execution_posture(session_id, admitted_provider_account_id.clone())
                .await
                .map_err(|error| not_admitted(session_id, error))?;
            Ok(DaemonTurnAdmission {
                admitted_provider_account_id,
                execution_posture,
            })
        }
        .boxed()
    }
}

// A daemon turn's run that got no place at the memory gate: it waited past the delivery timeout,
// or the run was let go while it waited.
#[derive(Debug, thiserror::Error)]
#[error("run {run_id} got no place at the memory gate")]
struct NotPlaced {
    run_id: RunId,
}

// A daemon turn on `session_id` whose admission failed: a refusal kept for the client to read by
// its code, as a handler would answer it, and any other failure a fault.
fn not_admitted(session_id: SessionId, failure: impl Into<HandlerError>) -> DaemonTurnBindingError {
    refusal_or_fault(session_id, failure.into(), |fault| {
        DaemonTurnBindingError::NotAdmitted {
            session_id,
            source: Box::new(fault),
        }
    })
}

// A daemon turn's process open or binding on `session_id` that failed: a process let go before its
// binding has none to run on, a refusal (a session closed or a provider missing meanwhile) is kept
// for the client to read by its code, and any other failure leaves the binding unopened.
fn binding_not_opened(
    session_id: SessionId,
    error: ProviderSessionError,
) -> DaemonTurnBindingError {
    if let ProviderSessionError::NotOpen { session_id } = error {
        return DaemonTurnBindingError::NoProviderSession { session_id };
    }
    refusal_or_fault(session_id, error.into(), |fault| {
        DaemonTurnBindingError::BindingNotRecorded {
            session_id,
            source: Box::new(fault),
        }
    })
}

// `failure` on `session_id` as a handler reads it: its refusal kept as `Refused`, and any fault
// answered as `fault` makes it.
fn refusal_or_fault(
    session_id: SessionId,
    failure: HandlerError,
    fault: impl FnOnce(HandlerError) -> DaemonTurnBindingError,
) -> DaemonTurnBindingError {
    match failure {
        HandlerError::Refused(refusal) => DaemonTurnBindingError::Refused {
            session_id,
            refusal: Box::new(refusal),
        },
        failure @ (HandlerError::Internal(_) | HandlerError::Canceled) => fault(failure),
    }
}

// The session's own bound on the steps one turn may take, which the turn reaches its driver with.
// Fails as the read fails.
async fn read_step_bound(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Option<SafeInt<1>>, QueueError> {
    pool.read(ReadLength::Short, move |reader| {
        Ok::<_, QueueError>(read_session_max_steps_per_turn(reader, &session_id)?)
    })
    .await
}

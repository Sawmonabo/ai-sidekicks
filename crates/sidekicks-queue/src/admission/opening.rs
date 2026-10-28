//! The item each run the queue starts or continues opens with: the table of openings whose
//! outcome is not yet written, the driver's start of the run's turn with it, and the binding of a
//! turn the daemon starts on a session itself.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::{
    ProviderDriver, RunOpening, RunOpeningItem, StartRunParams,
};
use sidekicks_provider::driver::run_control::{
    DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver, InterruptRunRequest,
};
use sidekicks_session::console_state::read_session_max_steps_per_turn;
use sidekicks_session::queue_store::{QueueItemBody, QueueItemReader, QueueItemRecord};
use sidekicks_session::run::agent::read_lead_agent_through;
use sidekicks_session::run::start_request::RunTurnStart;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use super::QueueAdmission;
use crate::delivery::OpeningMessages;
use crate::error::QueueError;
use crate::provider_session::ProviderSessionError;

/// The message each run being started or continued opens with, until the start writes its
/// outcome.
#[derive(Default)]
pub(crate) struct RunOpenings {
    by_run: Mutex<HashMap<RunId, QueueItemRecord>>,
}

impl RunOpenings {
    /// Records `item` as the opening of `run_id`.
    pub(super) fn insert(&self, run_id: RunId, item: QueueItemRecord) {
        self.lock().insert(run_id, item);
    }

    /// The opening of `run_id`, if one is recorded.
    pub(super) fn get(&self, run_id: RunId) -> Option<QueueItemRecord> {
        self.lock().get(&run_id).cloned()
    }

    /// Forgets the opening of `run_id`, answering it.
    pub(super) fn remove(&self, run_id: RunId) -> Option<QueueItemRecord> {
        self.lock().remove(&run_id)
    }

    // The table. No holder awaits or panics while it changes, so a poisoned lock still guards a
    // whole table.
    fn lock(&self) -> MutexGuard<'_, HashMap<RunId, QueueItemRecord>> {
        lock(&self.by_run)
    }
}

impl OpeningMessages for RunOpenings {
    // One a newer lead run took over waits for that run, whose to hand it is.
    fn is_opening(&self, item: &QueueItemRecord) -> bool {
        item.target_run_id.is_some_and(|run_id| {
            self.lock()
                .get(&run_id)
                .is_some_and(|opening| opening.id == item.id)
        })
    }
}

impl QueueAdmission {
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
    // then hands the driver the run's opening on the run's own binding.
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
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        async move {
            let binding_id = self
                .deps
                .provider_sessions
                .open_run_binding(run_id, session_id)
                .await
                .map_err(|error| match error {
                    ProviderSessionError::NotOpen { session_id } => {
                        DaemonTurnBindingError::NoProviderSession { session_id }
                    }
                    ProviderSessionError::NoConversation { session_id } => {
                        DaemonTurnBindingError::NoConversation { session_id }
                    }
                    other @ (ProviderSessionError::Compose { .. }
                    | ProviderSessionError::NoPosture { .. }
                    | ProviderSessionError::NoContractVersion { .. }
                    | ProviderSessionError::Provider(_)
                    | ProviderSessionError::Driver(_)
                    | ProviderSessionError::ResumeRefused { .. }
                    | ProviderSessionError::NotResumable(_)
                    | ProviderSessionError::Closed { .. }
                    | ProviderSessionError::BeingDeleted { .. }
                    | ProviderSessionError::Cursor(_)
                    | ProviderSessionError::LevelNotStored { .. }
                    | ProviderSessionError::LevelNotMovedBack { .. }
                    | ProviderSessionError::ModeNotStored { .. }
                    | ProviderSessionError::ModeNotMovedBack { .. }
                    | ProviderSessionError::Read(_)
                    | ProviderSessionError::Pool(_)) => {
                        DaemonTurnBindingError::BindingNotRecorded {
                            session_id,
                            source: Box::new(other),
                        }
                    }
                })?;
            let not_recorded = |error: QueueError| DaemonTurnBindingError::BindingNotRecorded {
                session_id,
                source: Box::new(error),
            };
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

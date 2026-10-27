//! A session's provider session, opened by its first admission: the driver's `create_session` and
//! the runtime binding that records it, or, when the session already has a conversation from before
//! the daemon started, the driver's `resume_session` of it and the binding the resume minted. Each
//! run after that gets a binding of its own on the session's current leg. A session's opening, its
//! run bindings and its level moves take the session's transition lock, so a process never opens
//! at a level a move is about to replace, two moves never store one level while the process runs
//! at the other, and no process opens between a close's end of the provider leg and its
//! `session.closed` write, nor after it: an opening under the lock refuses a closed session.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use serde_json::Map;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, SpawnedVersionBindingCarriers};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::{
    CreateSessionParams, DriverResumeResult, UpdatePermissionLevelParams,
};
use sidekicks_provider::left_conversations::LeftConversation;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::runtime_binding::resume::{
    ResumeFunctionLegs, RuntimeBindingNotResumable, compose_resume_session_params,
};
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBinding, RuntimeBindingPatch, RuntimeBindingRelaunch,
    RuntimeBindingSpawnConfig, RuntimeBindingStore, RuntimeBindingStoreError,
};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::permission_level::{
    permission_level_change_statement, read_session_permission_level,
};
use sidekicks_session::run::binding_cursors::{RunBindingCursorError, RunBindingCursors};
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

#[cfg(any(test, feature = "test-support"))]
pub mod test_opening;
#[cfg(test)]
mod tests;

/// The statements the provider sessions' reads prepare: a session's state, its runs, their
/// bindings, its mode and its level.
pub const PROVIDER_SESSIONS_STATEMENT_CAPACITY: usize = 5;

/// What a session's provider session opens with, composed from the session's lead as its log
/// stands now.
pub struct ProviderSessionOpening {
    /// The provider the lead runs on.
    pub provider: ProviderId,
    /// The git folder of the session's repository, which the posture of each level is built on.
    pub git_folder: FilesystemPath,
    /// The create's data legs, its posture the one of the level the session stands at; its
    /// function legs are left out and bound to the binding once it is minted.
    pub create_params: CreateSessionParams,
    /// The build the session's process spawns, which its binding records: the version it reports
    /// and the executable it resolved to, from one reading.
    pub spawned_version: SpawnedVersionBindingCarriers,
    /// The callbacks a process of the leg a binding id names is handed, bound to that leg.
    pub function_legs_for: Arc<dyn Fn(&RuntimeBindingId) -> ResumeFunctionLegs + Send + Sync>,
}

/// Composes a session's opening from its lead. Fails when the session has no lead or no
/// workspace, or its repository's git folder cannot be read.
pub type ProviderSessionOpeningComposer = Arc<
    dyn Fn(
            SessionId,
        )
            -> BoxFuture<'static, Result<ProviderSessionOpening, Box<dyn Error + Send + Sync>>>
        + Send
        + Sync,
>;

/// What the provider sessions read, write and call.
pub struct ProviderSessionsDeps {
    /// The read pool every read of a session's bindings, mode and level goes through.
    pub pool: Arc<DatabaseReadPool>,
    /// The writer a level move is stored through.
    pub writer: Arc<DatabaseWriter>,
    /// The binding rows an opening completes or removes.
    pub runtime_bindings: Arc<RuntimeBindingStore>,
    /// Records each binding a run opens on, or a resume minted, with its epoch cursor open.
    pub binding_cursors: Arc<RunBindingCursors>,
    /// The drivers, and the contract version each declares.
    pub providers: Arc<ProviderRegistry>,
    /// Composes a session's opening from its lead.
    pub compose_opening: ProviderSessionOpeningComposer,
    /// The session-wide transition lock, which a session's close holds from its driver's close
    /// until its `session.closed` write; each opening, run binding and level move takes it.
    pub transition_lock: Arc<KeyedLock<SessionId>>,
}

/// Why a session's provider session was not opened, a run's binding not recorded or a level not
/// moved; nothing of an opening that failed is left live.
#[derive(Debug, thiserror::Error)]
pub enum ProviderSessionError {
    /// The session's opening could not be composed.
    #[error("the provider session of session {session_id} could not be composed")]
    Compose {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// The session's lead runs at no posture.
    #[error("the lead of session {session_id} runs at no posture")]
    NoPosture {
        /// The session.
        session_id: SessionId,
    },
    /// The provider's driver has recorded no capabilities yet, so no contract version.
    #[error("the driver of {} declares no contract version yet", .provider.as_str())]
    NoContractVersion {
        /// The provider.
        provider: ProviderId,
    },
    /// No driver answers the session's provider.
    #[error(transparent)]
    Provider(#[from] DomainError),
    /// The driver failed the create, the resume or the level move.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The provider refused to resume the session's conversation.
    #[error("the provider could not resume session {session_id} ({recovery_condition:?})")]
    ResumeRefused {
        /// The session.
        session_id: SessionId,
        /// Why the resume needs recovery.
        recovery_condition: RecoveryCondition,
        /// The provider's own words.
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// The session's newest binding holds no conversation to resume.
    #[error(transparent)]
    NotResumable(#[from] RuntimeBindingNotResumable),
    /// The session closed, so no process opens for it.
    #[error("session {session_id} is closed")]
    Closed {
        /// The session.
        session_id: SessionId,
    },
    /// The session is being deleted, so no process opens for it.
    #[error("session {session_id} is being deleted")]
    BeingDeleted {
        /// The session.
        session_id: SessionId,
    },
    /// The driver's create failed, and the binding recorded for it could not be removed.
    #[error("the provider session of session {session_id} was not created ({create}), and its \
             binding {} could not be removed", .binding_id.as_str())]
    CreateLeftBinding {
        /// The session.
        session_id: SessionId,
        /// The binding left.
        binding_id: RuntimeBindingId,
        /// Why the create failed.
        create: DriverError,
        /// Why the removal failed.
        #[source]
        delete: RuntimeBindingStoreError,
    },
    /// The binding the opening recorded is gone before its conversation was named on it.
    #[error("the binding {} of session {session_id}'s opening is gone", .binding_id.as_str())]
    BindingGone {
        /// The session.
        session_id: SessionId,
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The session has no provider session open in this daemon.
    #[error("session {session_id} has no provider session open")]
    NotOpen {
        /// The session.
        session_id: SessionId,
    },
    /// The session has no conversation to run on.
    #[error("session {session_id} has no conversation to run on")]
    NoConversation {
        /// The session.
        session_id: SessionId,
    },
    /// The binding or its cursor was not recorded.
    #[error(transparent)]
    Cursor(#[from] RunBindingCursorError),
    /// A binding row was not written.
    #[error(transparent)]
    Store(#[from] RuntimeBindingStoreError),
    /// The level the session moved to was not stored, and its process moved back.
    #[error("the level session {session_id} moved to was not stored")]
    LevelNotStored {
        /// The session.
        session_id: SessionId,
        /// Why the store failed.
        #[source]
        cause: WriteError,
    },
    /// The level was not stored, and the process could not move back to the one stored.
    #[error(
        "the level session {session_id} moved to was not stored ({stored}), and its process \
             could not move back"
    )]
    LevelNotMovedBack {
        /// The session.
        session_id: SessionId,
        /// Why the store failed.
        stored: WriteError,
        /// Why the move back failed.
        #[source]
        moved_back: DriverError,
    },
    /// SQLite refused a read, or a stored value does not read as its type.
    #[error("a read of the session's bindings, mode or level failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("a read of the session's bindings, mode or level did not reach the database")]
    Pool(#[from] DatabaseReadError),
}

// One opened session: the provider it runs on, the posture its process runs at, which each of its
// runs is requested at, and the git folder each level's posture is built on.
#[derive(Clone)]
struct OpenedSession {
    provider: ProviderId,
    execution_posture: ExecutionPosture,
    git_folder: FilesystemPath,
}

/// Opens each session's provider session once per daemon process, at its first admission, and the
/// runtime binding of each run on it. A session holds one entry from its first admission until it
/// closes or the daemon stops.
pub struct ProviderSessions {
    deps: ProviderSessionsDeps,
    opened: Mutex<HashMap<SessionId, OpenedSession>>,
}

impl ProviderSessions {
    /// The provider sessions over `deps`, none open.
    pub fn new(deps: ProviderSessionsDeps) -> Self {
        Self {
            deps,
            opened: Mutex::new(HashMap::new()),
        }
    }

    /// The posture the session's process runs at, which each of its runs is requested at: the open
    /// one's, else the one it opens at. Fails with [`ProviderSessionError::NoPosture`] for a
    /// session whose lead runs at none, and as the opening's composition fails.
    pub(crate) async fn read_execution_posture(
        &self,
        session_id: SessionId,
    ) -> Result<ExecutionPosture, ProviderSessionError> {
        if let Some(opened) = self.lock_opened().get(&session_id) {
            return Ok(opened.execution_posture.clone());
        }
        posture_of(session_id, &self.compose(session_id).await?)
    }

    /// Moves the session to `level` and stores it, unless it stands there already. An open process
    /// is moved first, through its driver, so the record never names a level the provider refused;
    /// a store that fails then moves it back and fails. A process not open yet opens at the stored
    /// level. Fails as the driver's move fails, with nothing changed.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the session controls' level move")
    )]
    pub(crate) async fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let stored = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_session_permission_level(reader, &session_id)?)
            })
            .await?;
        if stored == level {
            return Ok(());
        }
        let opened = self.lock_opened().get(&session_id).cloned();
        let Some(opened) = opened else {
            return self
                .record_level(session_id, level)
                .await
                .map_err(|cause| ProviderSessionError::LevelNotStored { session_id, cause });
        };
        let posture = compose_execution_posture(level, opened.git_folder.clone());
        self.move_process(&opened.provider, session_id, &posture)
            .await?;
        self.set_posture(session_id, posture);
        let Err(stored_error) = self.record_level(session_id, level).await else {
            return Ok(());
        };
        let moved_back = self
            .move_process(&opened.provider, session_id, &opened.execution_posture)
            .await;
        match moved_back {
            Ok(()) => {
                self.set_posture(session_id, opened.execution_posture);
                Err(ProviderSessionError::LevelNotStored {
                    session_id,
                    cause: stored_error,
                })
            }
            Err(ProviderSessionError::Driver(moved_back)) => {
                Err(ProviderSessionError::LevelNotMovedBack {
                    session_id,
                    stored: stored_error,
                    moved_back,
                })
            }
            Err(other) => Err(other),
        }
    }

    /// Opens the session's provider session for `run_id`, its first admitted run, when this process
    /// has not opened it: resumed from the session's newest conversation where it has one, else
    /// created, with the binding `run_id` runs on. Fails with [`ProviderSessionError::Closed`] or
    /// [`ProviderSessionError::BeingDeleted`] for a closed session, with nothing spawned, with
    /// [`ProviderSessionError::ResumeRefused`] for a resume the provider refused, and as the
    /// composition, the driver or a binding's write fails, with no binding left for a create that
    /// failed.
    pub(crate) async fn open(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), ProviderSessionError> {
        let hold = self.deps.transition_lock.acquire(session_id).await;
        // Read under the lock, so a close that ran first has written `session.closed`, and before
        // the opened entry, which that event's listener drops only later.
        self.refuse_ended(session_id).await?;
        if self.lock_opened().contains_key(&session_id) {
            return Ok(());
        }
        let opened = match read_session_leg(&self.deps.pool, session_id).await? {
            None => self.create(session_id, run_id).await?,
            Some(leg) => self.resume(&hold, session_id, leg, run_id).await?,
        };
        self.lock_opened().insert(session_id, opened);
        Ok(())
    }

    /// The binding `run_id` runs on: the session's current leg, its newest binding with a
    /// conversation, recorded again for the run, unless the run is the one that leg is on. Fails
    /// when the session was not opened in this process or has no conversation.
    pub(crate) async fn open_run_binding(
        &self,
        run_id: RunId,
        session_id: SessionId,
    ) -> Result<RuntimeBindingId, ProviderSessionError> {
        let hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        self.bind_run(&hold, run_id).await
    }

    // Refuses, under the session's hold, a session that takes no process, binding or level: a
    // closed one, or one being deleted.
    async fn refuse_ended(&self, session_id: SessionId) -> Result<(), ProviderSessionError> {
        match read_session_state_through::<ProviderSessionError>(&self.deps.pool, session_id)
            .await?
        {
            Some(SessionState::Closed) => Err(ProviderSessionError::Closed { session_id }),
            Some(SessionState::PurgeRequested) => {
                Err(ProviderSessionError::BeingDeleted { session_id })
            }
            Some(SessionState::Provisioning | SessionState::Active | SessionState::Archived)
            | None => Ok(()),
        }
    }

    /// Forgets a closed session's provider session, whose process its close ended.
    pub(crate) fn forget(&self, session_id: SessionId) {
        self.lock_opened().remove(&session_id);
    }

    // `open_run_binding` under the session's `hold`, which the caller took.
    async fn bind_run(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<RuntimeBindingId, ProviderSessionError> {
        let session_id = *hold.key();
        if !self.lock_opened().contains_key(&session_id) {
            return Err(ProviderSessionError::NotOpen { session_id });
        }
        // Read afresh: a fork moves the leg onto another conversation and a relaunch records a new
        // leg, so the newest one is the session's.
        let current = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        if current.run_id == run_id {
            return Ok(current.id);
        }
        let binding = self
            .deps
            .binding_cursors
            .create(CreateRuntimeBindingInput {
                run_id,
                provider_name: current.provider_name,
                contract_version: current.contract_version,
                spawned_version: SpawnedVersionBindingCarriers {
                    cli_version: current.cli_version,
                    resolved_executable_path: PathBuf::from(current.resolved_executable_path),
                },
                resume_handle: current.resume_handle,
                spawn_config: current.spawn_config,
                runtime_metadata: Map::new(),
            })
            .await?;
        Ok(binding.id)
    }

    async fn create(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<OpenedSession, ProviderSessionError> {
        let opening = self.compose(session_id).await?;
        let execution_posture = posture_of(session_id, &opening)?;
        let ProviderSessionOpening {
            provider,
            git_folder,
            mut create_params,
            spawned_version,
            function_legs_for,
        } = opening;
        let driver = self.deps.providers.lookup(&provider)?;
        let contract_version = self
            .deps
            .providers
            .contract_version(&provider)?
            .ok_or_else(|| ProviderSessionError::NoContractVersion {
                provider: provider.clone(),
            })?;
        let binding = self
            .deps
            .binding_cursors
            .create(CreateRuntimeBindingInput {
                run_id,
                provider_name: provider.clone(),
                contract_version,
                spawned_version,
                resume_handle: None,
                spawn_config: spawn_config_of(&create_params),
                runtime_metadata: Map::new(),
            })
            .await?;
        let legs = function_legs_for(&binding.id);
        create_params.on_mcp_server_status = legs.on_mcp_server_status;
        let handle = match driver.create_session(create_params).await {
            Ok(handle) => handle,
            // A run whose session never opened keeps no binding.
            Err(create) => {
                return Err(match self.deps.runtime_bindings.delete(&binding.id).await {
                    Ok(_) => create.into(),
                    Err(delete) => ProviderSessionError::CreateLeftBinding {
                        session_id,
                        binding_id: binding.id,
                        create,
                        delete,
                    },
                });
            }
        };
        let patch = RuntimeBindingPatch {
            resume_handle: Some(handle.resume_handle),
            ..RuntimeBindingPatch::default()
        };
        if self
            .deps
            .runtime_bindings
            .update(&binding.id, patch, Vec::new())
            .await?
            .is_none()
        {
            return Err(ProviderSessionError::BindingGone {
                session_id,
                binding_id: binding.id,
            });
        }
        Ok(OpenedSession {
            provider,
            execution_posture,
            git_folder,
        })
    }

    // The session ran before this daemon started: its conversation is resumed in a fresh process,
    // and the binding the resume minted carries its cursor on; the run gets a binding of its own.
    async fn resume(
        &self,
        hold: &KeyHold<'_, SessionId>,
        session_id: SessionId,
        leg: RuntimeBinding,
        run_id: RunId,
    ) -> Result<OpenedSession, ProviderSessionError> {
        let opening = self.compose(session_id).await?;
        let execution_posture = posture_of(session_id, &opening)?;
        let mode = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_session_mode(reader, &session_id)?)
            })
            .await?;
        let params = compose_resume_session_params(
            session_id,
            opening.create_params.agent_id,
            &leg,
            opening.create_params.model.clone(),
            opening.create_params.larger_window,
            mode,
            execution_posture.clone(),
            opening.create_params.options.clone(),
            opening.create_params.row_values.clone(),
            (opening.function_legs_for)(&leg.id),
        )?;
        let driver = self.deps.providers.lookup(&leg.provider_name)?;
        let (binding_id, resume_handle, spawned_version) =
            match driver.resume_session(params).await? {
                DriverResumeResult::Resumed {
                    binding_id,
                    resume_handle,
                    spawned_version,
                    ..
                } => (binding_id, resume_handle, spawned_version),
                DriverResumeResult::Failed {
                    recovery_condition,
                    provider_failure_detail,
                } => {
                    return Err(ProviderSessionError::ResumeRefused {
                        session_id,
                        recovery_condition,
                        provider_failure_detail,
                    });
                }
            };
        // A provider that continued the conversation in a new one left the old one behind.
        let left_conversations = leg
            .resume_handle
            .as_ref()
            .filter(|handle| handle.as_str() != resume_handle.as_str())
            .map(|handle| LeftConversation {
                session_id,
                provider_account_id: leg.spawn_config.provider_account_id.clone(),
                conversation_id: handle.clone(),
            })
            .into_iter()
            .collect();
        self.deps
            .binding_cursors
            .record_relaunch(RuntimeBindingRelaunch {
                predecessor_id: leg.id.clone(),
                binding_id,
                resume_handle: resume_handle.as_str().to_owned(),
                spawned_version,
                left_conversations,
            })
            .await?;
        let opened = OpenedSession {
            provider: leg.provider_name,
            execution_posture,
            git_folder: opening.git_folder,
        };
        // The resumed leg sits on the run it was first opened for; this run gets its own.
        self.lock_opened().insert(session_id, opened.clone());
        if let Err(error) = self.bind_run(hold, run_id).await {
            self.forget(session_id);
            return Err(error);
        }
        Ok(opened)
    }

    async fn compose(
        &self,
        session_id: SessionId,
    ) -> Result<ProviderSessionOpening, ProviderSessionError> {
        (self.deps.compose_opening)(session_id)
            .await
            .map_err(|cause| ProviderSessionError::Compose { session_id, cause })
    }

    async fn move_process(
        &self,
        provider: &ProviderId,
        session_id: SessionId,
        posture: &ExecutionPosture,
    ) -> Result<(), ProviderSessionError> {
        let driver = self.deps.providers.lookup(provider)?;
        driver
            .update_permission_level(UpdatePermissionLevelParams {
                session_id,
                execution_posture: posture.clone(),
            })
            .await?;
        Ok(())
    }

    async fn record_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<(), WriteError> {
        self.deps
            .writer
            .write(vec![permission_level_change_statement(&session_id, level)])
            .await
            .map(drop)
    }

    fn set_posture(&self, session_id: SessionId, posture: ExecutionPosture) {
        if let Some(opened) = self.lock_opened().get_mut(&session_id) {
            opened.execution_posture = posture;
        }
    }

    fn lock_opened(&self) -> MutexGuard<'_, HashMap<SessionId, OpenedSession>> {
        // No code panics while it holds the map, so a poisoned lock still holds a whole one.
        lock(&self.opened)
    }
}

// The posture a session's process opens or resumes at, the one its opening names.
fn posture_of(
    session_id: SessionId,
    opening: &ProviderSessionOpening,
) -> Result<ExecutionPosture, ProviderSessionError> {
    opening
        .create_params
        .execution_posture
        .clone()
        .ok_or(ProviderSessionError::NoPosture { session_id })
}

// The spawn-bound legs a resume rebuilds the session from.
fn spawn_config_of(params: &CreateSessionParams) -> RuntimeBindingSpawnConfig {
    RuntimeBindingSpawnConfig {
        execution_posture: params.execution_posture.clone(),
        callback_tools: params.callback_tools.clone(),
        subagent_policy: params.subagent_policy.clone(),
        tool_servers: params.tool_servers.clone(),
        output_schema: params.output_schema.clone(),
        provider_account_id: params.provider_account_id.clone(),
        output_speed: params.output_speed.clone(),
    }
}

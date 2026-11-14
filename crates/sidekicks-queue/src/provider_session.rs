//! A session's provider session, opened by its first admission: the driver's `create_session` and
//! the runtime binding that records it, or, when the session already has a conversation from before
//! the daemon started, the driver's `resume_session` of it and the binding the resume minted; a
//! process that ended and stayed down comes back the same way through the driver's
//! `restart_session`. Each run after that gets a binding of its own on the session's current leg.
//! A session's opening and restart, its run bindings, its level and mode moves and the forgetting
//! of a process gone take the session's transition lock, so a process never opens at a level or in
//! a mode a move is about to replace, two moves never store one level while the process runs at
//! the other, and no process opens between a close's end of the provider leg and its
//! `session.closed` write, nor after it: an opening under the lock refuses a closed session. It is
//! the one place a session's process opens or resumes, so it tells the idle sleep of each opening
//! and close, and brings a sleeping session's process up for it.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::params_and_results::{
    SessionProcessState, SpawnedVersionBindingCarriers,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::{
    CloseSessionParams, CreateSessionParams, SessionAccountPin, SessionCloseCause,
};
use sidekicks_provider::port::session_level_follower::SessionLevelFollower;
use sidekicks_provider::run::posture::{
    ExecutionPostureRejection, ExecutionPostureService, StoredSessionPosture,
    compose_execution_posture, compose_folderless_posture,
};
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBindingSpawnConfig, mint_runtime_binding_id,
};
use sidekicks_session::agent_tree::reattach::HELPER_REATTACH_STATEMENT_CAPACITY;
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::directory::provider_port::OpeningToolServers;
use sidekicks_session::idle_sleep::openings::SessionProcessFollower;
use sidekicks_session::run::agent::RunAgentReader;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::session_posture::SessionPostureSource;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::events::session::appender::SessionEventAppender;

use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::held_run_continue::{HandedContinue, OrphanedAnswerSource};
use crate::provider_session::resumed_runs::ResumedRunsIngress;

mod continue_refusal;
pub mod controls;
pub mod errors;
pub mod held_run_continue;
pub mod held_tool_calls;
mod kept_turns;
mod provider_missing;
pub mod resume;
pub mod resumed_runs;
#[cfg(any(test, feature = "test-support"))]
pub mod test_opening;
#[cfg(test)]
mod tests;

/// The statements the provider sessions' reads prepare: a session's state, its live runs and their
/// open turns, their bindings, its mode, its level, its kept schedules and its place, and the read
/// of the helpers a relaunch re-attaches.
pub const PROVIDER_SESSIONS_STATEMENT_CAPACITY: usize = 8 + HELPER_REATTACH_STATEMENT_CAPACITY;

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
    /// The callbacks a process of the leg a binding id names is handed, bound to that leg.
    pub function_legs_for: Arc<dyn Fn(&RuntimeBindingId) -> ResumeFunctionLegs + Send + Sync>,
}

/// Composes a session's opening from its lead, on the account given, which its create carries,
/// with the tool servers the [`OpeningToolServers`] names. Fails when the session has no lead or no
/// workspace, or its repository's git folder cannot be read.
pub type ProviderSessionOpeningComposer = Arc<
    dyn Fn(
            SessionId,
            ProviderAccountId,
            OpeningToolServers,
        )
            -> BoxFuture<'static, Result<ProviderSessionOpening, Box<dyn Error + Send + Sync>>>
        + Send
        + Sync,
>;

/// Reads the git folder of a session's repository, which the posture of Sandboxed is built on.
/// Fails with [`GitFolderReadError::Unavailable`] when the session names no folder or git refuses
/// the one it names, and with [`GitFolderReadError::Failed`] when the reads fail.
pub type ProviderSessionGitFolderReader = Arc<
    dyn Fn(SessionId) -> BoxFuture<'static, Result<FilesystemPath, GitFolderReadError>>
        + Send
        + Sync,
>;

/// Why a session's git folder was not read.
#[derive(Debug, thiserror::Error)]
pub enum GitFolderReadError {
    /// The session names no folder to work in yet, or git refuses the one it names: no repository
    /// there, the folder gone or unreadable, or a repository git will not use.
    #[error("the session's repository folder is unavailable")]
    Unavailable(#[source] Box<dyn Error + Send + Sync>),
    /// The session's records could not be read, or git could not be run.
    #[error("the session's git folder could not be read")]
    Failed(#[source] Box<dyn Error + Send + Sync>),
}

/// What the provider sessions read, write and call.
pub struct ProviderSessionsDeps {
    /// The read pool every read of a session's bindings, mode and level goes through.
    pub pool: Arc<DatabaseReadPool>,
    /// The appender a level or mode move is stored through, with the notice that tells every
    /// client of it.
    pub appender: Arc<SessionEventAppender>,
    /// Records each binding with its epoch cursor open: a new session's, opened before its
    /// provider runs, a run's on the session's leg, and the one a resume minted.
    pub binding_cursors: Arc<RunBindingCursors>,
    /// The drivers, and the contract version each declares.
    pub providers: Arc<ProviderRegistry>,
    /// Composes a session's opening from its lead.
    pub compose_opening: ProviderSessionOpeningComposer,
    /// Reads a session's git folder, where no process of the session is open to name it.
    pub read_git_folder: ProviderSessionGitFolderReader,
    /// The session-wide transition lock, which a session's close holds from its driver's close
    /// until its `session.closed` write; each opening, run binding, level or mode move and the
    /// forgetting of a process gone takes it.
    pub transition_lock: Arc<KeyedLock<SessionId>>,
    /// The idle sleep, told of each session whose process opens or resumes and each close.
    pub process_follower: Arc<dyn SessionProcessFollower>,
    /// The runs' resolved postures, which a level move carries to the session's moved posture and
    /// a close forgets.
    pub execution_postures: Arc<ExecutionPostureService>,
    /// Settles each run a resume named as the provider answered for it, before the resumed
    /// binding is recorded.
    pub resumed_runs: Arc<PortRegistration<Arc<dyn ResumedRunsIngress>>>,
    /// The answers to approval cards kept while no process held their session, which a held
    /// lead's continue carries.
    pub orphaned_approvals: Arc<dyn OrphanedAnswerSource<ApprovalRequestId>>,
    /// The answers to questions kept while no process held their session, which a held lead's
    /// continue carries.
    pub orphaned_questions: Arc<dyn OrphanedAnswerSource<QuestionId>>,
}

/// Closes the process `driver` opened for `session_id` whose binding was not recorded, so none runs
/// under a binding with no row, and answers `recorded`, or `UnrecordedNotClosed` carrying both when
/// the close fails. The caller holds no lock the driver's close appends under.
pub(crate) async fn close_unrecorded(
    driver: &dyn ProviderDriver,
    session_id: SessionId,
    recorded: ProviderSessionError,
) -> ProviderSessionError {
    match driver
        .close_session(CloseSessionParams {
            session_id,
            cause: SessionCloseCause::UnrecordedOpening,
        })
        .await
    {
        Ok(()) => recorded,
        Err(closed) => ProviderSessionError::UnrecordedNotClosed {
            session_id,
            recorded: Box::new(recorded),
            closed,
        },
    }
}

// A session this daemon opened, where its process stands as the driver answers, and that driver.
struct OpenedProcess {
    state: SessionProcessState,
    opened: OpenedSession,
    driver: Arc<dyn ProviderDriver>,
}

// One opened session: the provider it runs on, the posture its process runs at, which each of its
// runs is requested at, and the git folder each level's posture is built on.
#[derive(Clone)]
struct OpenedSession {
    provider: ProviderId,
    execution_posture: ExecutionPosture,
    git_folder: FilesystemPath,
}

// A resting session's stored conversation, as its leg recorded it, and the driver of the leg's
// provider, which takes the work done on that conversation with no process of this daemon's.
struct StoredConversation {
    driver: Arc<dyn ProviderDriver>,
    provider_account_id: ProviderAccountId,
    conversation: String,
    runtime_metadata: Map<String, Value>,
}

/// Opens each session's provider session once per daemon process, at its first admission, and the
/// runtime binding of each run on it. A session holds one entry from its first admission until it
/// closes, its process is gone with no restart pending, or the daemon stops.
pub struct ProviderSessions {
    deps: ProviderSessionsDeps,
    opened: Mutex<HashMap<SessionId, OpenedSession>>,
    handed_continues: Mutex<HashMap<SessionId, HandedContinue>>,
}

impl ProviderSessions {
    /// The provider sessions over `deps`, none open.
    pub fn new(deps: ProviderSessionsDeps) -> Self {
        Self {
            deps,
            opened: Mutex::new(HashMap::new()),
            handed_continues: Mutex::new(HashMap::new()),
        }
    }

    /// The epoch cursors of every session's bindings, which name the binding a session runs on now
    /// and fence an undo's conversation cut.
    pub(crate) fn binding_cursors(&self) -> &RunBindingCursors {
        &self.deps.binding_cursors
    }

    /// The posture the session's process runs at, which each of its runs is requested at: the open
    /// one's, else the one it opens at on `provider_account_id`. Fails with
    /// [`ProviderSessionError::NoPosture`] for a session whose lead runs at none, and as the
    /// opening's composition fails.
    pub(crate) async fn read_execution_posture(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> Result<ExecutionPosture, ProviderSessionError> {
        if let Some(opened) = self.lock_opened().get(&session_id) {
            return Ok(opened.execution_posture.clone());
        }
        posture_of(
            session_id,
            &self
                .compose(
                    session_id,
                    provider_account_id,
                    OpeningToolServers::Composed,
                )
                .await?,
        )
    }

    /// Opens the session's provider session for `run_id`, its first admitted run, when this process
    /// has not opened it: resumed from the session's newest conversation where it has one, else
    /// created, with the binding `run_id` runs on. Fails with [`ProviderSessionError::Closed`] or
    /// [`ProviderSessionError::BeingDeleted`] for a closed session, with nothing spawned, with
    /// [`ProviderSessionError::ResumeRefused`] for a resume the provider refused, and as the
    /// composition, the driver or a binding's write fails, with no binding left for a create that
    /// failed. A start whose provider no driver answers, or is not installed where the session
    /// runs, posts the session's `providerMissing` notice before it fails.
    pub(crate) async fn open(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), ProviderSessionError> {
        let hold = self.deps.transition_lock.acquire(session_id).await;
        // Read under the lock, so a close that ran first has written `session.closed`, and before
        // the opened entry, which that event's listener drops only later.
        self.refuse_ended(session_id).await?;
        if self.is_opened(session_id) {
            return Ok(());
        }
        match read_session_leg(&self.deps.pool, session_id).await? {
            None => {
                let opened = self.create(session_id, run_id).await?;
                self.record_opened(session_id, opened);
            }
            Some(leg) => {
                self.resume_leg(session_id, leg).await?;
                // The resumed leg sits on the run it was first opened for; this run gets its own.
                // A failed binding fails this run alone: the resumed process stays opened and
                // recorded, so the next admission binds to it and resumes none.
                self.bind_run(&hold, run_id).await?;
            }
        }
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

    /// Forgets a closed session's provider session, whose process its close ended, with what the
    /// posture service kept for it, and has the idle sleep forget it too.
    pub(crate) fn forget(&self, session_id: SessionId) {
        self.lock_opened().remove(&session_id);
        lock(&self.handed_continues).remove(&session_id);
        self.deps.execution_postures.forget_session(&session_id);
        self.deps.process_follower.forget_closed(session_id);
    }

    /// Whether this daemon opened `session_id`'s process: created, resumed or joined, and not
    /// deferred, closed or forgotten since.
    pub(crate) fn is_opened(&self, session_id: SessionId) -> bool {
        self.lock_opened().contains_key(&session_id)
    }

    // Records `session_id`'s process as opened in this daemon, and the idle sleep follows it awake.
    fn record_opened(&self, session_id: SessionId, opened: OpenedSession) {
        self.lock_opened().insert(session_id, opened);
        self.deps.process_follower.follow_awake(session_id);
    }

    /// Forgets the session's provider session once its process is gone and its driver answers,
    /// under the session's transition lock, that none comes back until the daemon opens it, so the
    /// next admission opens it again from the store; a process the driver brings back keeps it.
    /// Fails with [`ProviderSessionError::Provider`] when no driver answers the provider it opened
    /// on.
    pub(crate) async fn forget_gone_process(
        &self,
        session_id: SessionId,
    ) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        let state = self.process_state(session_id)?.map(|process| process.state);
        match state {
            // The session is not closed, so the idle sleep keeps its stored timed fires.
            Some(SessionProcessState::Down) => {
                self.lock_opened().remove(&session_id);
                self.deps
                    .execution_postures
                    .forget_moved_posture(&session_id);
            }
            Some(SessionProcessState::Live | SessionProcessState::Restarting) | None => {}
        }
        Ok(())
    }

    // `open_run_binding` under the session's `hold`, which the caller took.
    async fn bind_run(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<RuntimeBindingId, ProviderSessionError> {
        let session_id = *hold.key();
        if !self.is_opened(session_id) {
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
            .create(
                session_id,
                CreateRuntimeBindingInput {
                    id: mint_runtime_binding_id(),
                    run_id,
                    provider_name: current.provider_name,
                    contract_version: current.contract_version,
                    spawned_version: SpawnedVersionBindingCarriers {
                        cli_version: current.cli_version,
                        resolved_executable_path: PathBuf::from(current.resolved_executable_path),
                    },
                    resume_handle: current.resume_handle,
                    spawn_config: current.spawn_config,
                    // The provider's recovery data goes with the leg, so a run bound before any
                    // usage report keeps what the leg's provider stored, its fixed start among it.
                    runtime_metadata: current.runtime_metadata,
                },
            )
            .await?;
        Ok(binding.id)
    }

    // A new session's first process. Its binding's cursor opens before the provider runs, since
    // the provider delivers under the binding at once, and its row is written once the create
    // answers, with the build that process reported and the conversation it opened; a failed
    // create leaves neither. It runs on the account `run_id` was admitted against.
    async fn create(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<OpenedSession, ProviderSessionError> {
        let provider_account_id = self.read_admitted_account(session_id, run_id).await?;
        let opening = self
            .compose(
                session_id,
                provider_account_id,
                OpeningToolServers::Composed,
            )
            .await?;
        let execution_posture = posture_of(session_id, &opening)?;
        let ProviderSessionOpening {
            provider,
            git_folder,
            mut create_params,
            function_legs_for,
        } = opening;
        // A mode moved before the first process is the one it opens in.
        create_params.mode = self.read_mode(session_id).await?;
        let driver = match self.deps.providers.lookup(&provider) {
            Ok(driver) => driver,
            Err(refusal) => {
                return Err(self
                    .answer_failed_start(session_id, &provider, refusal.into())
                    .await);
            }
        };
        let contract_version = self
            .deps
            .providers
            .contract_version(&provider)?
            .ok_or_else(|| ProviderSessionError::NoContractVersion {
                provider: provider.clone(),
            })?;
        let spawn_config = spawn_config_of(&create_params);
        let binding_id = mint_runtime_binding_id();
        self.deps
            .binding_cursors
            .open_binding(
                session_id,
                binding_id.clone(),
                run_id,
                provider.clone(),
                create_params.provider_account_id.clone(),
            )
            .await?;
        let legs = function_legs_for(&binding_id);
        create_params.on_mcp_server_status = legs.on_mcp_server_status;
        let handle = match driver.create_session(create_params).await {
            Ok(handle) => handle,
            // A run whose session never opened keeps no binding.
            Err(create) => {
                self.deps.binding_cursors.forget_binding(&binding_id);
                return Err(self
                    .answer_failed_start(session_id, &provider, create.into())
                    .await);
            }
        };
        let recorded = self
            .deps
            .binding_cursors
            .record_opened_binding(CreateRuntimeBindingInput {
                id: binding_id,
                run_id,
                provider_name: provider.clone(),
                contract_version,
                spawned_version: handle.spawned_version,
                resume_handle: Some(handle.resume_handle),
                spawn_config,
                runtime_metadata: Map::new(),
            })
            .await;
        if let Err(unrecorded) = recorded {
            return Err(close_unrecorded(driver.as_ref(), session_id, unrecorded.into()).await);
        }
        Ok(OpenedSession {
            provider,
            execution_posture,
            git_folder,
        })
    }

    // The account `run_id` was admitted against.
    async fn read_admitted_account(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<ProviderAccountId, ProviderSessionError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(
                    RunAgentReader::new(reader).read_admitted_account(&session_id, &run_id)?,
                )
            })
            .await
    }

    async fn compose(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        tool_servers: OpeningToolServers,
    ) -> Result<ProviderSessionOpening, ProviderSessionError> {
        (self.deps.compose_opening)(session_id, provider_account_id, tool_servers)
            .await
            .map_err(|cause| ProviderSessionError::Compose { session_id, cause })
    }

    async fn read_mode(&self, session_id: SessionId) -> Result<SessionMode, ProviderSessionError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_session_mode(reader, &session_id)?)
            })
            .await
    }

    // Where the session's process stands, as the driver of the provider it opened on answers;
    // read under the caller's hold of the session. `None` for a session this daemon has not
    // opened, which is down: a driver runs or brings back only a process the daemon opened.
    fn process_state(
        &self,
        session_id: SessionId,
    ) -> Result<Option<OpenedProcess>, ProviderSessionError> {
        let Some(opened) = self.lock_opened().get(&session_id).cloned() else {
            return Ok(None);
        };
        let driver = self.deps.providers.lookup(&opened.provider)?;
        Ok(Some(OpenedProcess {
            state: driver.session_process_state(&session_id),
            opened,
            driver,
        }))
    }

    // The posture the session's process runs at at `level`, over the opened process's git folder,
    // else the session's as read now, which only a level whose posture names it reads. Fails with
    // `PostureRefused` where that folder is unavailable, and as its read fails otherwise.
    async fn level_posture(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> Result<ExecutionPosture, ProviderSessionError> {
        if let Some(posture) = compose_folderless_posture(level) {
            return Ok(posture);
        }
        let opened_folder = self
            .lock_opened()
            .get(&session_id)
            .map(|opened| opened.git_folder.clone());
        let git_folder =
            match opened_folder {
                Some(git_folder) => git_folder,
                None => (self.deps.read_git_folder)(session_id)
                    .await
                    .map_err(|failure| match failure {
                        GitFolderReadError::Unavailable(cause) => {
                            ProviderSessionError::PostureRefused {
                                session_id,
                                cause: ExecutionPostureRejection::UnavailableFolder(cause),
                            }
                        }
                        GitFolderReadError::Failed(cause) => {
                            ProviderSessionError::GitFolder { session_id, cause }
                        }
                    })?,
            };
        Ok(compose_execution_posture(level, git_folder))
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

    // The conversation `session_id`'s stored leg holds, on the leg's account and with its recovery
    // data, and the driver of its provider; `None` for a session with no leg or no conversation.
    // Fails as the leg's read fails, and with `Provider` when no driver answers its provider.
    async fn read_stored_conversation(
        &self,
        session_id: SessionId,
    ) -> Result<Option<StoredConversation>, ProviderSessionError> {
        let Some(leg) = read_session_leg(&self.deps.pool, session_id).await? else {
            return Ok(None);
        };
        let Some(conversation) = leg.resume_handle else {
            return Ok(None);
        };
        Ok(Some(StoredConversation {
            driver: self.deps.providers.lookup(&leg.provider_name)?,
            provider_account_id: leg.spawn_config.provider_account_id,
            conversation,
            runtime_metadata: leg.runtime_metadata,
        }))
    }
}

impl SessionLevelFollower for ProviderSessions {
    fn follow_reported_level(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.follow_reported_level(session_id)
                .await
                .map_err(|failure| Box::new(failure) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
    }
}

impl StoredSessionPosture for ProviderSessions {
    /// The stored level's posture, over the opened process's git folder or the session's as read
    /// now where it names one. A folder that is unavailable fails with the posture's own
    /// rejection, which names no move, so the gate counts it a posture the session cannot run.
    fn stored_posture<'a>(
        &'a self,
        session_id: SessionId,
        requested: &'a ExecutionPosture,
    ) -> BoxFuture<'a, Result<Option<ExecutionPosture>, Box<dyn Error + Send + Sync>>> {
        async move {
            let (level, _mode) = self.read_controls(session_id).await?;
            if level == requested.permission_level() {
                return Ok(None);
            }
            Ok(Some(self.level_posture(session_id, level).await?))
        }
        .map(|read: Result<_, ProviderSessionError>| {
            read.map_err(|failure| match failure {
                ProviderSessionError::PostureRefused { cause, .. } => {
                    Box::new(cause) as Box<dyn Error + Send + Sync>
                }
                failure @ (ProviderSessionError::Compose { .. }
                | ProviderSessionError::AdmittedAccount(_)
                | ProviderSessionError::NoPosture { .. }
                | ProviderSessionError::NoContractVersion { .. }
                | ProviderSessionError::Provider(_)
                | ProviderSessionError::Driver(_)
                | ProviderSessionError::ResumeRefused { .. }
                | ProviderSessionError::NotResumable(_)
                | ProviderSessionError::Closed { .. }
                | ProviderSessionError::BeingDeleted { .. }
                | ProviderSessionError::NotOpen { .. }
                | ProviderSessionError::HeldCallsOpen { .. }
                | ProviderSessionError::NoConversation { .. }
                | ProviderSessionError::Cursor(_)
                | ProviderSessionError::ResumedRuns { .. }
                | ProviderSessionError::OrphanedAnswers { .. }
                | ProviderSessionError::ContinueNotReleased { .. }
                | ProviderSessionError::AfterCarriedContinue { .. }
                | ProviderSessionError::Port(_)
                | ProviderSessionError::UnrecordedNotClosed { .. }
                | ProviderSessionError::ProviderMissingNotPosted { .. }
                | ProviderSessionError::Store(_)
                | ProviderSessionError::GitFolder { .. }
                | ProviderSessionError::LevelNotStored { .. }
                | ProviderSessionError::LevelNotMovedBack { .. }
                | ProviderSessionError::ModeNotStored { .. }
                | ProviderSessionError::ModeNotMovedBack { .. }
                | ProviderSessionError::Read(_)
                | ProviderSessionError::Pool(_)) => Box::new(failure),
            })
        })
        .boxed()
    }
}

impl SessionPostureSource for ProviderSessions {
    fn opened_execution_posture(&self, session_id: &SessionId) -> Option<ExecutionPosture> {
        self.lock_opened()
            .get(session_id)
            .map(|opened| opened.execution_posture.clone())
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
        tool_servers: params.tool_servers.clone(),
        output_schema: params.output_schema.clone(),
        provider_account_id: params.provider_account_id.clone(),
        output_speed: params.output_speed.clone(),
        is_account_pinned: params.account_pin == SessionAccountPin::Pinned,
    }
}

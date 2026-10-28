//! The session directory's answer to the provider side: where and as whom each of a session's
//! provider processes runs and the folder its runs work in, what its provider session opens with,
//! and the binding each resume a driver started on its own minted. The lead is read from the
//! session's log; a session opens and resumes at the permission level stored on it, at the posture
//! that level runs at in the session's repository.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::OptionalExtension;
use serde_json::Map;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::{
    MachineSettings, ProviderRowValues, ProviderSettingValues,
};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_provider::driver::ports::SessionRelaunchListener;
use sidekicks_provider::driver::session_control::{CreateSessionParams, DriverResumeResult};
use sidekicks_provider::driver::{
    ProviderAccountFolders, ProviderAccountReader, SessionSpawnContext, SessionSpawnContextResolver,
};
use sidekicks_provider::left_conversations::LeftConversation;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::runtime_binding::store::{
    RuntimeBindingRelaunch, RuntimeBindingStoreError,
};
use sidekicks_std::port_registration::{PortRegistration, PortRegistrationError};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::optional_text_column;
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use sidekicks_workspace::git::process::{
    GitError, GitRunner, NOT_A_REPOSITORY_EXIT_CODE, read_git_common_folder,
};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::{ProjectReadError, ProjectRecords};
use sidekicks_workspace::row_guards::{BOUND_ROOT_METADATA_PATH, CHECKOUT_ROOT_METADATA_PATH};
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};

use crate::console_state::{
    read_session_advisor_model, read_session_max_steps_per_turn, read_session_mode,
};
use crate::permission_level::read_session_permission_level;
use crate::run::agent::{SessionLead, read_session_lead};
use crate::run::binding_cursors::{RunBindingCursorError, RunBindingCursors};
use crate::run::stored_leg::read_session_leg;

/// The statements the port prepares on a pooled connection: the lead, the working folder, the run
/// folder, the level, the mode, the step bound, the advisor, and the session's run ids and their
/// bindings for its leg.
pub const SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY: usize = 9;

// The place the session works in and the folder its runs work in: its newest live workspace's
// prepared root, else, before its first run prepares one, the folder that workspace was bound to,
// or the checkout that holds it.
static RUN_FOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    let archived = <&'static str>::from(WorkspaceState::Archived);
    format!(
        "SELECT sessions.place,
       (SELECT COALESCE(workspace.fs_root,
                        json_extract(workspace.metadata, '{BOUND_ROOT_METADATA_PATH}'),
                        json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'))
          FROM workspaces AS workspace
         WHERE workspace.session_id = sessions.id AND workspace.state <> '{archived}'
         ORDER BY workspace.created_at DESC, workspace.id DESC
         LIMIT 1)
  FROM sessions
 WHERE sessions.id = ?"
    )
});

/// Why the port could not answer for a session.
#[derive(Debug, thiserror::Error)]
pub enum SessionDirectoryProviderPortError {
    /// The session has no workspace whose root is ready to run a process in.
    #[error("session {session_id} has no workspace ready to run in")]
    NoWorkingFolder {
        /// The session.
        session_id: SessionId,
    },
    /// The session has no live workspace, or none naming a folder.
    #[error("session {session_id} has no workspace to work in")]
    NoRunFolder {
        /// The session.
        session_id: SessionId,
    },
    /// The session's readable log names no lead.
    #[error("session {session_id} names no lead to open")]
    NoLead {
        /// The session.
        session_id: SessionId,
    },
    /// A relaunch was reported for a session with no binding holding a conversation to replace.
    #[error("session {session_id} has no binding with a conversation its relaunch replaced")]
    NoLeg {
        /// The session.
        session_id: SessionId,
    },
    /// The session's working folder could not be read, or the session is not this daemon's.
    #[error(transparent)]
    WorkingFolder(#[from] WorkingFolderReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the session's records could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// git did not answer the repository's git folder.
    #[error("the git folder of the session's repository could not be read")]
    Git(#[from] GitError),
    /// The repository's git folder is a path the wire's path rule refuses.
    #[error("the git folder of the session's repository is no path a posture can name")]
    GitFolderPath(#[source] TextError),
    /// The machine's settings file could not be read.
    #[error("the machine's settings could not be read")]
    MachineSettings(#[source] Box<dyn Error + Send + Sync>),
    /// The session's project's environment rows could not be read.
    #[error(transparent)]
    ProjectRows(#[from] ProjectReadError),
    /// The accounts port is not registered, so an account's folders cannot be read.
    #[error(transparent)]
    AccountsPort(#[from] PortRegistrationError),
    /// The account's folders could not be read.
    #[error("the folders of the session's account could not be read")]
    AccountFolders(#[source] Box<dyn Error + Send + Sync>),
    /// A relaunch's binding cursor was not opened or its row not recorded.
    #[error(transparent)]
    BindingCursor(#[from] RunBindingCursorError),
    /// The session's bindings could not be read.
    #[error(transparent)]
    Bindings(#[from] RuntimeBindingStoreError),
}

/// What a session's provider session opens with, composed from its lead as the session's log and
/// records stand now; the caller binds its function legs to the binding it mints.
pub struct SessionProviderOpening {
    /// The provider the lead runs on.
    pub provider: ProviderId,
    /// The git folder of the session's repository, which the posture of each level is built on.
    pub git_folder: FilesystemPath,
    /// The create's data legs, its posture the one of the level the session stands at.
    pub create_params: CreateSessionParams,
}

/// What [`SessionDirectoryProviderPort`] reads and records through.
pub struct SessionDirectoryProviderPortDeps {
    /// The read pool every read goes through, sized with
    /// [`SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY`].
    pub pool: Arc<DatabaseReadPool>,
    /// The sequence a damaged session's log reads stop before, which bounds the lead's read.
    pub read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// Opens and records the binding of each relaunch.
    pub binding_cursors: Arc<RunBindingCursors>,
    /// The git the repository's git folder is read with.
    pub git: GitRunner,
    /// The machine's settings: the `Every project` environment rows and each provider's row
    /// values.
    pub settings: Arc<dyn MachineSettingsReader>,
    /// The session's project's environment rows.
    pub project_records: Arc<ProjectRecords>,
    /// The folders of the account a process runs on, read through the port its owner registers.
    pub provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
}

/// The session directory's reads and records that the provider side calls: the spawn context of
/// each process, a session's opening, and each relaunch's binding.
pub struct SessionDirectoryProviderPort {
    deps: SessionDirectoryProviderPortDeps,
}

// The session's level's posture, its mode and every provider's row values, as they stand now,
// and the git folder the posture is built on.
struct StandingOpening {
    git_folder: FilesystemPath,
    execution_posture: ExecutionPosture,
    mode: SessionMode,
    provider_settings: ProviderSettingValues,
}

impl SessionDirectoryProviderPort {
    /// The port over `deps`.
    pub fn new(deps: SessionDirectoryProviderPortDeps) -> Self {
        Self { deps }
    }

    /// What `session_id`'s provider session opens with: its lead's provider, the model it runs on
    /// now and the account, output speed, options and larger window its binding names, at the
    /// posture of the level it stands at, in the mode it was last moved to, with the row values
    /// set in the app for that provider. Fails for a session with no lead or no workspace, and as
    /// the reads, git or the settings file fail.
    pub async fn compose_opening(
        &self,
        session_id: SessionId,
    ) -> Result<SessionProviderOpening, SessionDirectoryProviderPortError> {
        let lead = self
            .read_lead(session_id)
            .await?
            .ok_or(SessionDirectoryProviderPortError::NoLead { session_id })?;
        let standing = self.read_standing_opening(session_id).await?;
        let SessionLead {
            agent_id,
            binding,
            running_model,
        } = lead;
        let row_values = row_values_of(&standing.provider_settings, &binding.provider_name);
        Ok(SessionProviderOpening {
            git_folder: standing.git_folder,
            create_params: CreateSessionParams {
                session_id,
                agent_id,
                config: Map::new(),
                model: running_model,
                larger_window: binding.larger_window,
                execution_posture: Some(standing.execution_posture),
                mode: standing.mode,
                output_speed: binding.output_speed,
                options: binding
                    .options
                    .map(|options| options.as_slice().to_vec())
                    .unwrap_or_default(),
                row_values,
                // The session's tool servers and callback tools are bound by their own owners.
                callback_tools: None,
                subagent_policy: None,
                tool_servers: None,
                output_schema: None,
                provider_account_id: binding.provider_account_id,
                on_mcp_server_status: None,
            },
            provider: binding.provider_name,
        })
    }

    async fn read_lead(
        &self,
        session_id: SessionId,
    ) -> Result<Option<SessionLead>, SessionDirectoryProviderPortError> {
        let read_bound = session_read_bound(
            self.deps.read_damaged_from_sequence.as_ref(),
            &session_id,
            None,
        );
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, SessionDirectoryProviderPortError>(read_session_lead(
                    reader,
                    &session_id,
                    read_bound,
                )?)
            })
            .await
    }

    // The place the session works in and the folder its runs work in.
    async fn read_run_folder(
        &self,
        session_id: SessionId,
    ) -> Result<(Option<Place>, PathBuf), SessionDirectoryProviderPortError> {
        let (place, folder) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, SessionDirectoryProviderPortError>(
                    reader
                        .prepare_cached(&RUN_FOLDER_SQL)?
                        .query_row([session_id.text().as_str()], |row| {
                            Ok((
                                // The column holds the place's wire JSON.
                                optional_text_column(row, 0, |text| {
                                    serde_json::from_str::<Place>(&text)
                                })?,
                                row.get::<_, Option<String>>(1)?,
                            ))
                        })
                        .optional()?,
                )
            })
            .await?
            .unwrap_or_default();
        let folder = folder.ok_or(SessionDirectoryProviderPortError::NoRunFolder { session_id })?;
        Ok((place, PathBuf::from(folder)))
    }

    // What an opening and a resume take from the session's records and the settings file now: the
    // git folder of the repository its runs work in, the posture of its level there, its mode,
    // and every provider's row values.
    async fn read_standing_opening(
        &self,
        session_id: SessionId,
    ) -> Result<StandingOpening, SessionDirectoryProviderPortError> {
        let (place, run_folder) = self.read_run_folder(session_id).await?;
        let (level, mode) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, SessionDirectoryProviderPortError>((
                    read_session_permission_level(reader, &session_id)?,
                    read_session_mode(reader, &session_id)?,
                ))
            })
            .await?;
        let (git_folder, settings) = tokio::try_join!(
            async {
                read_git_common_folder(&self.deps.git, place.as_ref(), &run_folder, None)
                    .await
                    .map_err(SessionDirectoryProviderPortError::from)
            },
            self.read_settings(),
        )?;
        let git_folder = FilesystemPath::new(git_folder.to_string_lossy().into_owned())
            .map_err(SessionDirectoryProviderPortError::GitFolderPath)?;
        Ok(StandingOpening {
            execution_posture: compose_execution_posture(level, git_folder.clone()),
            git_folder,
            mode,
            provider_settings: settings.provider_settings,
        })
    }

    async fn read_settings(&self) -> Result<MachineSettings, SessionDirectoryProviderPortError> {
        self.deps
            .settings
            .read_machine_settings()
            .await
            .map_err(SessionDirectoryProviderPortError::MachineSettings)
    }

    // The common git folder of the repository `folder` sits in, `None` outside one.
    async fn read_git_common_folder_if_any(
        &self,
        place: Option<&Place>,
        folder: &Path,
    ) -> Result<Option<PathBuf>, SessionDirectoryProviderPortError> {
        match read_git_common_folder(&self.deps.git, place, folder, None).await {
            Ok(git_folder) => Ok(Some(git_folder)),
            Err(GitError::Exited {
                code: Some(NOT_A_REPOSITORY_EXIT_CODE),
                ..
            }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    // The folders of `provider_account_id`'s account, `None` on the person's own sign-in.
    async fn read_account_folders(
        &self,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<Option<ProviderAccountFolders>, SessionDirectoryProviderPortError> {
        let Some(provider_account_id) = provider_account_id else {
            return Ok(None);
        };
        self.deps
            .provider_accounts
            .require_port()?
            .resolve_account_folders(provider_account_id)
            .await
            .map_err(SessionDirectoryProviderPortError::AccountFolders)
    }

    async fn resolve_spawn_context_of(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<SessionSpawnContext, SessionDirectoryProviderPortError> {
        let (working_folder, step_bound, advisor_model) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, SessionDirectoryProviderPortError>((
                    read_working_folder(reader, &session_id)?,
                    read_session_max_steps_per_turn(reader, &session_id)?,
                    read_session_advisor_model(reader, &session_id)?,
                ))
            })
            .await?;
        let working_directory = working_folder
            .working_folder
            .ok_or(SessionDirectoryProviderPortError::NoWorkingFolder { session_id })?;
        let (git_common_folder, settings, project_rows, account_folders) = tokio::try_join!(
            self.read_git_common_folder_if_any(working_folder.place.as_ref(), &working_directory),
            self.read_settings(),
            async {
                self.deps
                    .project_records
                    .read_environment_rows_of_session(session_id)
                    .await
                    .map_err(SessionDirectoryProviderPortError::from)
            },
            self.read_account_folders(provider_account_id),
        )?;
        Ok(SessionSpawnContext {
            working_directory,
            git_common_folder,
            every_project_rows: settings.environment_rows,
            project_rows,
            account_folders,
            step_bound,
            advisor_model,
        })
    }

    async fn record_relaunch(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> Result<(), SessionDirectoryProviderPortError> {
        let opened = self.deps.binding_cursors.take_driver_relaunch(session_id);
        let (binding_id, resume_handle, spawned_version) = match result {
            DriverResumeResult::Failed {
                recovery_condition,
                provider_failure_detail,
            } => {
                tracing::warn!(
                    session_id = %session_id,
                    recovery_condition = ?recovery_condition,
                    detail = provider_failure_detail.as_str(),
                    "the provider could not resume the session on its own"
                );
                if let Some((opened_id, _)) = opened {
                    self.deps.binding_cursors.forget_binding(&opened_id);
                }
                return Ok(());
            }
            DriverResumeResult::Resumed {
                binding_id,
                resume_handle,
                spawned_version,
                ..
            } => (binding_id, resume_handle, spawned_version),
        };
        // The leg the opening continued, read again only for a relaunch that opened nothing.
        let (opened_id, predecessor) = match opened {
            Some((opened_id, predecessor)) => (Some(opened_id), predecessor),
            None => (
                None,
                read_session_leg(&self.deps.pool, session_id)
                    .await?
                    .ok_or(SessionDirectoryProviderPortError::NoLeg { session_id })?,
            ),
        };
        if opened_id.as_ref() != Some(&binding_id) {
            // The binding the opening opened is never recorded.
            if let Some(opened_id) = opened_id {
                self.deps.binding_cursors.forget_binding(&opened_id);
            }
            // A process already up on the leg's own binding, which another resume recorded, is
            // answered with that binding: nothing new is opened or recorded.
            if predecessor.id == binding_id {
                return Ok(());
            }
            self.deps
                .binding_cursors
                .open_relaunch(&predecessor, binding_id.clone())
                .await?;
        }
        // A provider that continued the conversation in a new one left the old one behind.
        let left_conversations = predecessor
            .resume_handle
            .as_ref()
            .filter(|handle| handle.as_str() != resume_handle.as_str())
            .map(|handle| LeftConversation {
                session_id,
                provider_account_id: predecessor.spawn_config.provider_account_id.clone(),
                conversation_id: handle.clone(),
            })
            .into_iter()
            .collect();
        self.deps
            .binding_cursors
            .record_relaunch(RuntimeBindingRelaunch {
                predecessor_id: predecessor.id,
                binding_id,
                resume_handle: resume_handle.as_str().to_owned(),
                spawned_version,
                left_conversations,
            })
            .await?;
        Ok(())
    }
}

impl SessionSpawnContextResolver for SessionDirectoryProviderPort {
    /// The session's newest ready workspace's root, its repository's common git folder (`None`
    /// outside one), the machine's and the project's environment rows, the account's folders, and
    /// the session's own step bound and advisor. Fails for a session with no workspace ready to
    /// run in, for an account named while the accounts port is unregistered, and as the reads,
    /// git, the settings file or the accounts port fail.
    fn resolve_spawn_context(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn Error + Send + Sync>>> {
        async move {
            self.resolve_spawn_context_of(session_id, provider_account_id)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    /// The session's newest live workspace's prepared root, else the folder it was bound to, else
    /// the checkout that holds it. Fails for a session with no live workspace naming one, and as
    /// the read fails.
    fn resolve_run_folder(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<PathBuf, Box<dyn Error + Send + Sync>>> {
        async move {
            let (_, folder) = self.read_run_folder(session_id).await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(folder)
        }
        .boxed()
    }
}

impl SessionRelaunchListener for SessionDirectoryProviderPort {
    /// Opens the binding's cursor where the session's leg's stands and keeps it, with that leg,
    /// for the relaunch's result. Fails as the cursor's open fails.
    fn open_relaunch_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.deps
                .binding_cursors
                .open_driver_relaunch(session_id, binding_id)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    /// A failed relaunch is logged and its opened cursor forgotten; a resumed one's binding is
    /// recorded on the leg its opening continued, else on the session's leg as it stands, the
    /// conversation that leg ran on recorded as left when the provider continued it in a new one.
    /// Fails for a session with no leg, and as the cursor's open or the row's write fails.
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.record_relaunch(session_id, result)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }
}

// The row values set in the app on `provider`'s rows, empty where none is set.
fn row_values_of(settings: &ProviderSettingValues, provider: &ProviderId) -> ProviderRowValues {
    settings.as_map().get(provider).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    //! The port's relaunch record and its run folder.

    use std::error::Error;
    use std::num::NonZeroUsize;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use sidekicks_contracts::machine::settings::MachineSettings;
    use sidekicks_contracts::project::ProjectId;
    use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
    use sidekicks_provider::driver::SessionSpawnContextResolver;
    use sidekicks_provider::driver::ports::SessionRelaunchListener;
    use sidekicks_provider::driver::session_control::DriverResumeResult;
    use sidekicks_provider::left_conversations::read_left_conversations;
    use sidekicks_provider::runtime_binding::store::{
        CreateRuntimeBindingInput, RuntimeBindingSpawnConfig, mint_runtime_binding_id,
    };
    use sidekicks_provider::runtime_binding::test_store::{
        binding_input, open_store, spawned_build,
    };
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_run_id, test_session_id,
    };
    use sidekicks_workspace::git::process::test_git_runner;
    use sidekicks_workspace::machine_settings::MachineSettingsReader;
    use sidekicks_workspace::project::records::{
        PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity,
        ProjectSessionFacts,
    };
    use sidekicks_workspace::test_rows::project_and_mount_rows;

    use super::{
        SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY, SessionDirectoryProviderPort,
        SessionDirectoryProviderPortDeps,
    };
    use crate::run::binding_cursors::{RUN_BINDING_CURSORS_STATEMENT_CAPACITY, RunBindingCursors};
    use crate::run::engine::test_fixture::insert_running_run;
    use crate::run::epochs::ExecutionEpochs;
    use crate::run::schema::schema_parts;
    use crate::run::stored_leg::read_session_leg;

    // A relaunch reads neither the projects nor the settings.
    struct Unread;

    impl ProjectSessionActivity for Unread {
        fn read_session_facts(
            &self,
            _reader: &Connection,
            _project_ids: Option<&[ProjectId]>,
        ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
            Ok(Vec::new())
        }
    }

    impl MachineSettingsReader for Unread {
        fn read_machine_settings(
            &self,
        ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
            async { Ok(MachineSettings::default()) }.boxed()
        }
    }

    // A port over a session whose leg runs on `conversation-1`.
    struct PortOverLeg {
        port: SessionDirectoryProviderPort,
        pool: Arc<DatabaseReadPool>,
        epochs: Arc<Mutex<ExecutionEpochs>>,
        leg_id: RuntimeBindingId,
    }

    async fn port_over_a_leg(database: &TestDatabase, session_id: SessionId) -> PortOverLeg {
        let store = open_store(database).await;
        let run_id = test_run_id();
        insert_running_run(database, session_id, run_id);
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_DIRECTORY_PROVIDER_PORT_STATEMENT_CAPACITY
                + RUN_BINDING_CURSORS_STATEMENT_CAPACITY
                + PROJECT_RECORDS_STATEMENT_CAPACITY,
        ));
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        )));
        let binding_cursors = Arc::new(RunBindingCursors::new(
            Arc::clone(&pool),
            Arc::new(store),
            Arc::clone(&epochs),
        ));
        let leg = CreateRuntimeBindingInput {
            run_id,
            ..binding_input(
                RuntimeBindingSpawnConfig::default(),
                spawned_build("1.0.0", "/opt/provider/bin"),
            )
        };
        let leg_id = leg.id.clone();
        binding_cursors
            .create(leg)
            .await
            .expect("the leg is recorded");
        let port = SessionDirectoryProviderPort::new(SessionDirectoryProviderPortDeps {
            pool: Arc::clone(&pool),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
            binding_cursors,
            git: test_git_runner(),
            settings: Arc::new(Unread),
            project_records: Arc::new(ProjectRecords::new(Arc::clone(&pool), Arc::new(Unread))),
            provider_accounts: Arc::new(PortRegistration::new("provider accounts")),
        });
        PortOverLeg {
            port,
            pool,
            epochs,
            leg_id,
        }
    }

    // A relaunch's `Resumed` on `binding_id`, running conversation `resume_handle`.
    fn resumed_on(binding_id: RuntimeBindingId, resume_handle: &str) -> DriverResumeResult {
        DriverResumeResult::Resumed {
            binding_id,
            session_position: SafeInt::new(1).expect("a position"),
            resume_handle: NonEmptyText::new(resume_handle.to_owned()).expect("a resume handle"),
            spawned_version: spawned_build("1.1.0", "/opt/provider/bin"),
        }
    }

    // The relaunch's cursor is open once the opening answers, before the resume's result, and its
    // binding is recorded as the session's leg. Killed by the opening that opens no cursor, by the
    // handle comparison inverted, which records the conversation the leg still runs on as left, or
    // none for one it left; and by a relaunch whose binding is not recorded.
    #[rstest]
    #[case::moved_to_a_new_conversation("conversation-2", Some("conversation-1"))]
    #[case::kept_its_conversation("conversation-1", None)]
    #[tokio::test]
    async fn a_relaunch_records_its_binding_and_the_conversation_it_left(
        #[case] resumed_handle: &str,
        #[case] left: Option<&str>,
    ) {
        let database = TestDatabase::new(schema_parts());
        let session_id = test_session_id();
        let PortOverLeg {
            port, pool, epochs, ..
        } = port_over_a_leg(&database, session_id).await;
        let binding_id = mint_runtime_binding_id();

        port.open_relaunch_binding(session_id, binding_id.clone())
            .await
            .expect("the relaunch's cursor opens");
        assert!(lock(&epochs).binding(&binding_id).is_ok());
        port.session_relaunched(session_id, resumed_on(binding_id.clone(), resumed_handle))
            .await
            .expect("the relaunch is recorded");

        let leg = read_session_leg(&pool, session_id)
            .await
            .expect("the leg reads")
            .expect("the session has a leg");
        assert_eq!(
            leg.id, binding_id,
            "the relaunch's binding is the session's leg"
        );
        let left_conversations = read_left_conversations(&database.reader(), &session_id)
            .expect("the left conversations read");
        assert_eq!(
            left_conversations
                .iter()
                .map(|record| record.conversation.conversation_id.as_str())
                .collect::<Vec<_>>(),
            left.into_iter().collect::<Vec<_>>(),
        );
    }

    // A relaunch that failed, or that the process already up on the leg answered, records nothing
    // and forgets the cursor its opening opened, the leg's kept. Killed by the leg check dropped
    // (the leg's binding, already open, is opened again and the relaunch fails, or it is recorded a
    // second time), and by the opened cursor kept.
    #[rstest]
    #[case::answered_on_the_leg(true)]
    #[case::failed(false)]
    #[tokio::test]
    async fn a_relaunch_that_records_nothing_forgets_its_opened_cursor(#[case] is_answered: bool) {
        let database = TestDatabase::new(schema_parts());
        let session_id = test_session_id();
        let PortOverLeg {
            port,
            pool,
            epochs,
            leg_id,
        } = port_over_a_leg(&database, session_id).await;
        let opened_id = mint_runtime_binding_id();

        port.open_relaunch_binding(session_id, opened_id.clone())
            .await
            .expect("the relaunch's cursor opens");
        let result = if is_answered {
            resumed_on(leg_id.clone(), "conversation-1")
        } else {
            DriverResumeResult::Failed {
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                provider_failure_detail: FreeFormText::new("the test's resume fails".to_owned())
                    .expect("a failure detail"),
            }
        };
        port.session_relaunched(session_id, result)
            .await
            .expect("the relaunch's result is taken");

        let leg = read_session_leg(&pool, session_id)
            .await
            .expect("the leg reads")
            .expect("the session has a leg");
        assert_eq!(leg.id, leg_id, "the leg stays the session's leg");
        assert!(
            read_left_conversations(&database.reader(), &session_id)
                .expect("the left conversations read")
                .is_empty(),
            "no conversation is left"
        );
        let epochs = lock(&epochs);
        assert!(
            epochs.binding(&opened_id).is_err(),
            "the opened cursor is forgotten"
        );
        assert!(
            epochs.binding(&leg_id).is_ok(),
            "the leg's cursor stays open"
        );
    }

    // The run folder is the session's newest live workspace's prepared root, else the folder it
    // was bound to, else the checkout holding it, an archived workspace passed over. Killed by a
    // `COALESCE` arm dropped and by the archived filter dropped.
    #[rstest]
    #[case::prepared(Some("/work/prepared"), json!({"boundRoot": "/work/bound"}), "/work/prepared")]
    #[case::bound(
        None,
        json!({"boundRoot": "/work/bound", "checkoutRoot": "/work/checkout"}),
        "/work/bound"
    )]
    #[case::checkout(None, json!({"checkoutRoot": "/work/checkout"}), "/work/checkout")]
    #[tokio::test]
    async fn the_run_folder_reads_the_newest_live_workspace(
        #[case] fs_root: Option<&str>,
        #[case] metadata: Value,
        #[case] expected: &str,
    ) {
        let database = TestDatabase::new(schema_parts());
        let session_id = test_session_id();
        let PortOverLeg { port, .. } = port_over_a_leg(&database, session_id).await;
        let connection = database.reader();
        insert_session_row(&connection, session_id.text().as_str(), None, None);
        for row in project_and_mount_rows("mount", None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        let insert_workspace =
            |id: &str, state: WorkspaceState, fs_root: Option<&str>, metadata: &Value, at: &str| {
                connection
                    .execute(
                        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
                     fs_root, state, metadata, created_at, updated_at) \
                     VALUES (?1, ?2, 'mount', ?3, ?4, ?5, ?6, ?7, ?7)",
                        params![
                            id,
                            session_id.text().as_str(),
                            <&'static str>::from(ExecutionMode::BoundRoot),
                            fs_root,
                            <&'static str>::from(state),
                            metadata.to_string(),
                            at
                        ],
                    )
                    .expect("the test stores a workspace");
            };
        insert_workspace(
            "live",
            WorkspaceState::Ready,
            fs_root,
            &metadata,
            "2026-10-14T09:30:00.000Z",
        );
        insert_workspace(
            "archived",
            WorkspaceState::Archived,
            Some("/work/archived"),
            &json!({}),
            "2026-10-15T09:30:00.000Z",
        );

        let folder = port
            .resolve_run_folder(session_id)
            .await
            .expect("the run folder reads");

        assert_eq!(folder, PathBuf::from(expected));
    }
}

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
    AccountFoldersError, ProviderAccountFolders, ProviderAccountReader, SessionSpawnContext,
    SessionSpawnContextResolver,
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
    GIT_FATAL_EXIT_CODE, GitError, GitRunner, read_git_common_folder,
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
    /// The session has no live workspace, or none naming a folder: the run folder's resolver
    /// answers this, while an opening answers the typed [`Self::GitFolderUnavailable`].
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
    /// The session's git folder is unavailable, so no process of it can open.
    #[error("session {session_id}'s git folder is unavailable")]
    GitFolderUnavailable {
        /// The session.
        session_id: SessionId,
        /// Why it is unavailable.
        #[source]
        why: GitFolderUnavailable,
    },
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
    AccountFolders(#[source] AccountFoldersError),
    /// A relaunch's binding cursor was not opened or its row not recorded.
    #[error(transparent)]
    BindingCursor(#[from] RunBindingCursorError),
    /// The session's bindings could not be read.
    #[error(transparent)]
    Bindings(#[from] RuntimeBindingStoreError),
}

/// Why a session's git folder is unavailable, each answered as a refusal rather than a fault.
#[derive(Debug, thiserror::Error)]
pub enum GitFolderUnavailable {
    /// The session names no folder to work in yet, as before its workspace is set up.
    #[error("the session names no folder to work in yet")]
    NoRunFolder,
    /// git refuses the folder the session names. Its exit 128 is git's exit for every fatal error:
    /// no repository there, the folder gone or unreadable, a pruned worktree record, an owner git
    /// does not trust, or a corrupt `.git`.
    #[error("git refuses the folder the session works in")]
    Refused(#[source] GitError),
}

/// A session's git folder as the port reads it: the folder, or why the session has none.
#[derive(Debug)]
pub enum SessionGitFolder {
    /// The common git folder of the repository the session runs in.
    Available(FilesystemPath),
    /// The session has no git folder to build on now.
    Unavailable(GitFolderUnavailable),
}

/// What a session's provider session opens with, composed from its lead as the session's log and
/// records stand now; the caller binds its function legs to the binding it mints.
pub struct SessionProviderOpening {
    /// The provider the lead runs on.
    pub provider: ProviderId,
    /// The git folder of the session's repository, which the posture of Sandboxed is built on.
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

    /// What `session_id`'s provider session opens with on `provider_account_id`'s account: its
    /// lead's provider, the model it runs on now and the output speed, options and larger window
    /// its binding names, at the posture of the level it stands at, in the mode it was last moved
    /// to, with the row values set in the app for that provider. Fails for a session with no lead
    /// or no workspace, and as the reads, git or the settings file fail.
    pub async fn compose_opening(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
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
                provider_account_id,
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

    /// The common git folder of the repository `session_id` runs in, which the posture of
    /// Sandboxed is built on, or why it is unavailable: no folder named yet, or one git refuses.
    /// Fails as the reads fail, or git fails any other way.
    pub async fn read_git_folder(
        &self,
        session_id: SessionId,
    ) -> Result<SessionGitFolder, SessionDirectoryProviderPortError> {
        let (place, run_folder) = match self.read_run_folder(session_id).await {
            Ok(read) => read,
            Err(SessionDirectoryProviderPortError::NoRunFolder { .. }) => {
                return Ok(SessionGitFolder::Unavailable(
                    GitFolderUnavailable::NoRunFolder,
                ));
            }
            Err(failure) => return Err(failure),
        };
        let git_folder = match self
            .read_git_common_folder_or_refusal(place.as_ref(), &run_folder)
            .await?
        {
            Ok(git_folder) => git_folder,
            Err(refusal) => {
                return Ok(SessionGitFolder::Unavailable(
                    GitFolderUnavailable::Refused(refusal),
                ));
            }
        };
        FilesystemPath::new(git_folder.to_string_lossy().into_owned())
            .map(SessionGitFolder::Available)
            .map_err(SessionDirectoryProviderPortError::GitFolderPath)
    }

    // What an opening and a resume take from the session's records and the settings file now: the
    // git folder of the repository its runs work in, the posture of its level there, its mode,
    // and every provider's row values.
    async fn read_standing_opening(
        &self,
        session_id: SessionId,
    ) -> Result<StandingOpening, SessionDirectoryProviderPortError> {
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
        let (git_folder, settings) =
            tokio::try_join!(self.read_git_folder(session_id), self.read_settings())?;
        let git_folder = match git_folder {
            SessionGitFolder::Available(git_folder) => git_folder,
            SessionGitFolder::Unavailable(why) => {
                return Err(SessionDirectoryProviderPortError::GitFolderUnavailable {
                    session_id,
                    why,
                });
            }
        };
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

    // The common git folder of the repository `folder` sits in, or git's error where it refuses
    // the folder with its fatal exit: outside a repository, or a folder it cannot or will not use.
    async fn read_git_common_folder_or_refusal(
        &self,
        place: Option<&Place>,
        folder: &Path,
    ) -> Result<Result<PathBuf, GitError>, SessionDirectoryProviderPortError> {
        match read_git_common_folder(&self.deps.git, place, folder, None).await {
            Ok(git_folder) => Ok(Ok(git_folder)),
            Err(
                refusal @ GitError::Exited {
                    code: Some(GIT_FATAL_EXIT_CODE),
                    ..
                },
            ) => Ok(Err(refusal)),
            Err(error) => Err(error.into()),
        }
    }

    // The folders of `provider_account_id`'s account.
    async fn read_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> Result<ProviderAccountFolders, SessionDirectoryProviderPortError> {
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
        provider_account_id: ProviderAccountId,
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
            async {
                self.read_git_common_folder_or_refusal(
                    working_folder.place.as_ref(),
                    &working_directory,
                )
                .await
                .map(Result::ok)
            },
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
                .open_relaunch(session_id, &predecessor, binding_id.clone())
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
    /// run in, while the accounts port is unregistered, and as the reads,
    /// git, the settings file or the accounts port fail.
    fn resolve_spawn_context(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
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
mod tests;

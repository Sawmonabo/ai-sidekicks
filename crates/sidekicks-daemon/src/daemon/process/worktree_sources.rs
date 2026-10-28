//! What a worktree's naming and setup read from the owners beside the workspace crate, as the
//! daemon's start composes it: the project records, the worktree rows, the machine's settings, the
//! session's title and the environment a project's commands start with.

use std::collections::HashSet;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::machine::settings::BranchNamePattern;
use sidekicks_contracts::project::ProjectSetup;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_platforms::PathRules;
use sidekicks_provider::spawn_environment::{
    ReservedEnvironmentNames, SessionEnvironment, build_project_command_environment,
};
use sidekicks_session::auto_title::read_session_title_words;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::git::worktree::naming::{
    WorktreeNamingError, WorktreeNamingSources, WorktreeProjectNaming,
};
use sidekicks_workspace::git::worktree::service::{WorktreeService, WorktreeServiceError};
use sidekicks_workspace::git::worktree::setup::{WorktreeSetupError, WorktreeSetupSources};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::{ProjectRecords, WorktreeProjectSetup};

/// What a worktree's naming or setup found missing among the records it reads.
#[derive(Debug, thiserror::Error)]
enum WorktreeSourceGap {
    /// The mount serves no project: a chat's managed mount, or one whose project was forgotten.
    #[error("repository mount {0} serves no project")]
    NoProjectOfMount(RepoMountId),
    /// The worktree belongs to no project.
    #[error("worktree {0} belongs to no project")]
    NoProjectOfWorktree(WorktreeId),
    /// The session has no row.
    #[error("session {0} does not exist")]
    NoSession(SessionId),
}

/// The worktree naming's and setup's reads, over the daemon's records, settings and environment.
pub(crate) struct WorktreeSources {
    /// The daemon's read pool, which a session's title is read through.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The project records: a mount's naming facts, a worktree's project setup and rows.
    pub(crate) records: Arc<ProjectRecords>,
    /// The worktree rows.
    pub(crate) worktrees: Arc<WorktreeService>,
    /// The machine's settings: its branch-name pattern and its `Every project` rows.
    pub(crate) settings: Arc<dyn MachineSettingsReader>,
    /// The login shell's environment captured at the start, which every command starts from.
    pub(crate) base_environment: Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(crate) reserved_names: Arc<ReservedEnvironmentNames>,
}

impl WorktreeSources {
    // The setup and rows of the project `worktree_id` belongs to; fails for a tree in none.
    async fn read_worktree_project(
        &self,
        worktree_id: WorktreeId,
    ) -> Result<WorktreeProjectSetup, WorktreeSetupError> {
        self.records
            .read_worktree_project(worktree_id)
            .await
            .map_err(|error| WorktreeSetupError::Read(Box::new(error)))?
            .ok_or_else(|| {
                WorktreeSetupError::Read(Box::new(WorktreeSourceGap::NoProjectOfWorktree(
                    worktree_id,
                )))
            })
    }
}

impl WorktreeNamingSources for WorktreeSources {
    fn read_project_naming<'a>(
        &'a self,
        repo_mount_id: &'a RepoMountId,
    ) -> BoxFuture<'a, Result<WorktreeProjectNaming, WorktreeNamingError>> {
        async move {
            self.records
                .read_naming(*repo_mount_id)
                .await
                .map_err(|error| WorktreeNamingError(Box::new(error)))?
                .ok_or_else(|| {
                    WorktreeNamingError(Box::new(WorktreeSourceGap::NoProjectOfMount(
                        *repo_mount_id,
                    )))
                })
        }
        .boxed()
    }

    fn read_machine_branch_pattern(
        &self,
    ) -> BoxFuture<'_, Result<BranchNamePattern, WorktreeNamingError>> {
        async move {
            let settings = self
                .settings
                .read_machine_settings()
                .await
                .map_err(WorktreeNamingError)?;
            Ok(settings.branch_name_pattern)
        }
        .boxed()
    }

    fn read_session_title_words<'a>(
        &'a self,
        session_id: &'a SessionId,
        fallback_message: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, WorktreeNamingError>> {
        async move {
            read_session_title_words(
                &self.reads,
                *session_id,
                fallback_message.map(str::to_owned),
            )
            .await
            .map_err(|error| WorktreeNamingError(Box::new(error)))?
            .ok_or_else(|| WorktreeNamingError(Box::new(WorktreeSourceGap::NoSession(*session_id))))
        }
        .boxed()
    }
}

impl WorktreeSetupSources for WorktreeSources {
    fn require_worktree<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<(), WorktreeSetupError>> {
        async move {
            match self.worktrees.require_worktree(worktree_id).await {
                Ok(_) => Ok(()),
                Err(WorktreeServiceError::Refused(refusal)) => {
                    Err(WorktreeSetupError::Refused(refusal))
                }
                Err(error) => Err(WorktreeSetupError::Read(Box::new(error))),
            }
        }
        .boxed()
    }

    fn read_retired<'a>(
        &'a self,
        worktree_ids: &'a [WorktreeId],
    ) -> BoxFuture<'a, Result<HashSet<WorktreeId>, WorktreeSetupError>> {
        async move {
            self.worktrees
                .read_retired(worktree_ids)
                .await
                .map_err(|error| WorktreeSetupError::Read(Box::new(error)))
        }
        .boxed()
    }

    fn read_project_setup<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<ProjectSetup, WorktreeSetupError>> {
        async move { Ok(self.read_worktree_project(*worktree_id).await?.setup) }.boxed()
    }

    fn read_command_environment<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, WorktreeSetupError>> {
        async move {
            let project = self.read_worktree_project(*worktree_id).await?;
            let settings = self
                .settings
                .read_machine_settings()
                .await
                .map_err(WorktreeSetupError::Read)?;
            Ok(build_project_command_environment(&SessionEnvironment {
                base: &self.base_environment,
                every_project_rows: &settings.environment_rows,
                project_rows: &project.environment_rows,
                reserved_names: &self.reserved_names,
                rules: PathRules::NATIVE,
            }))
        }
        .boxed()
    }
}

//! The project writer: attach (the project row and its mount in one write, or the project already
//! holding the folder's repository), the clone's record from its first press to its attach, the
//! edits on a project's own row, and the detach, which forgets the record in the mount's own write
//! and archives the project's sessions, which stay readable. Nothing on disk is touched.
//!
//! - Records are made one at a time under one lock, so two never take one slug; a caller holding
//!   its own lock (the clone start's) takes it before this one.
//! - Every committed change asks the live projects list to read the projects it touched again.
//! - A finished attach and a detach each write one service-log line; nothing about a project is a
//!   session event.

pub(crate) mod clone_record;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use rusqlite::types::Value;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::{
    BranchNamePattern, BranchNamePatternChange, EnvironmentRow,
};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{
    PROJECT_NAME_MAX_LEN, ProjectEditResponse, ProjectId, ProjectName, ProjectSetup, ProjectState,
};
use sidekicks_contracts::repo::folders::{
    RepoMountAttachRequest, RepoMountAttachResponse, RepoMountDetachResponse,
};
use sidekicks_contracts::repo::mount::{LifecycleActor, RepoMountId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, place_value, text_binding,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::git::branch_name_pattern::{BranchPatternProject, find_project_branch_pattern_refusal};
use crate::git::process::{GitError, GitRunner};
use crate::machine_settings::MachineSettingsReader;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::{ProjectReadError, ProjectRecords};
use crate::project::refusals::{refuse_branch_pattern, refuse_environment_rows};
use crate::project::slug::{slug_base_of, slug_candidate};
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::service::detach::DetachRepoMount;
use crate::repo::mount::service::{RepoMountService, RepoMountServiceError};
use crate::schema::CloneOutcome;

const INSERT_PROJECT_SQL: &str = "INSERT INTO projects (
    id, name, slug, folder_path, state, clone_url, clone_outcome, setup, environment_rows,
    branch_pattern, place, created_at, updated_at
  ) VALUES (
    @id, @name, @slug, @folder_path, @state, @clone_url, @clone_outcome, @setup, '[]', NULL,
    @place, @now, @now
  )";

const PROJECT_EXISTS_SQL: &str = "SELECT 1 FROM projects WHERE id = @id";

// Archive and its undo move only a project in the state they leave, so another state is a no-op.
const MOVE_PROJECT_STATE_SQL: &str =
    "UPDATE projects SET state = @to, updated_at = @now WHERE id = @id AND state = @from";

const RENAME_PROJECT_SQL: &str =
    "UPDATE projects SET name = @value, updated_at = @now WHERE id = @id";
const UPDATE_SETUP_SQL: &str =
    "UPDATE projects SET setup = @value, updated_at = @now WHERE id = @id";
const UPDATE_ENVIRONMENT_SQL: &str =
    "UPDATE projects SET environment_rows = @value, updated_at = @now WHERE id = @id";
const UPDATE_BRANCH_PATTERN_SQL: &str =
    "UPDATE projects SET branch_pattern = @value, updated_at = @now WHERE id = @id";

// The detach's own write forgets the record once its mount reads `detached`; while an agent runs
// the mount stays attached and this deletes nothing.
const FORGET_PROJECT_OF_DETACHED_MOUNT_SQL: &str = "DELETE FROM projects
  WHERE id = (SELECT project_id FROM repo_mounts
               WHERE id = @repo_mount_id AND state = 'detached')";

/// Archives the sessions of a project being forgotten; the session service implements it.
pub trait ForgottenProjectSessions: Send + Sync {
    /// Archives `session_id`, active or still provisioning. Fails as the session's archive fails.
    fn archive_of_forgotten_project(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What the project writer reads, writes and calls.
pub struct ProjectServiceDeps {
    /// The daemon database's writer, which every project change goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The project reads, shared with the live list and the clone.
    pub records: Arc<ProjectRecords>,
    /// Resolves and attaches a project's folder, and detaches it.
    pub mounts: Arc<RepoMountService>,
    /// Archives a forgotten project's sessions.
    pub sessions: Arc<dyn ForgottenProjectSessions>,
    /// The daemon's git, which checks a branch pattern.
    pub git: GitRunner,
    /// The machine's settings, whose pattern a project's cleared one falls back to.
    pub settings: Arc<dyn MachineSettingsReader>,
    /// The variables a registered provider's driver sets, which no environment row may name.
    pub driver_set_names: Vec<&'static str>,
    /// The daemon's worktrees folder, whose project folders a new slug must not reuse.
    pub worktrees_folder: PathBuf,
    /// The live projects list, asked to read again after each committed change.
    pub list_feed: Arc<ProjectListFeed>,
}

/// A folder attached as a project, or found already attached as one, with its mount's facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectAttachment {
    /// The project.
    pub project_id: ProjectId,
    /// Its attached mount, as the `repoMount.attach` reply carries it.
    pub mount: RepoMountAttachResponse,
}

/// One forgotten project's session that could not be archived.
#[derive(Debug, thiserror::Error)]
#[error("session {session_id} of a forgotten project could not be archived")]
pub struct ForgottenSessionNotArchived {
    /// The session.
    pub session_id: SessionId,
    /// Why its archive failed.
    #[source]
    pub source: Box<dyn Error + Send + Sync>,
}

/// Why a project call failed: a refusal the wire carries, or a failure of the store, git, the
/// settings file or the session archives a committed detach owed.
#[derive(Debug, thiserror::Error)]
pub enum ProjectServiceError {
    /// The call was refused; nothing was written.
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// An environment row or a branch pattern was refused; nothing was written.
    #[error(transparent)]
    InputRefused(#[from] DomainError),
    /// The mount's attach, read or detach failed or refused.
    #[error(transparent)]
    Mount(#[from] RepoMountServiceError),
    /// The project rows could not be read.
    #[error(transparent)]
    Read(#[from] ProjectReadError),
    /// The write was not kept.
    #[error("the project write was not kept")]
    Write(#[from] WriteError),
    /// Git could not check a branch pattern.
    #[error("git could not check the branch pattern")]
    Git(#[from] GitError),
    /// The machine's settings file could not be read.
    #[error("the machine's settings could not be read")]
    MachineSettings(#[source] Box<dyn Error + Send + Sync>),
    /// The worktrees folder could not be read while a free slug was sought.
    #[error("the worktrees folder could not be read for a free project slug")]
    SlugFolder(#[source] io::Error),
    /// A mount's stored root does not read as a wire path.
    #[error("a mount's root is not a path the reply can carry")]
    MountRoot(#[from] TextError),
    /// The detach committed and the project is forgotten, but some of its sessions were not
    /// archived; every other session was tried.
    #[error("project {project_id} was forgotten, but some of its sessions were not archived")]
    SessionsNotArchived {
        /// The forgotten project.
        project_id: ProjectId,
        /// Each session whose archive failed.
        #[source]
        source: SettleFailures<ForgottenSessionNotArchived>,
    },
}

impl From<ProjectServiceError> for HandlerError {
    /// A refusal is answered with its code; every other failure is a fault.
    fn from(error: ProjectServiceError) -> Self {
        match error {
            ProjectServiceError::Refused(refusal)
            | ProjectServiceError::Mount(RepoMountServiceError::Refused(refusal)) => {
                Self::Refused(refusal.into())
            }
            ProjectServiceError::InputRefused(refusal) => Self::Refused(refusal),
            other @ (ProjectServiceError::Mount(_)
            | ProjectServiceError::Read(_)
            | ProjectServiceError::Write(_)
            | ProjectServiceError::Git(_)
            | ProjectServiceError::MachineSettings(_)
            | ProjectServiceError::SlugFolder(_)
            | ProjectServiceError::MountRoot(_)
            | ProjectServiceError::SessionsNotArchived { .. }) => Self::Internal(Box::new(other)),
        }
    }
}

// A new project's row: a folder's starts `active`, a clone's `cloning` with its address.
struct NewProjectRow<'a> {
    project_id: ProjectId,
    name: &'a ProjectName,
    folder_path: &'a str,
    place: Option<&'a Place>,
    clone_url: Option<&'a str>,
}

/// Owns the `projects` rows: attach, the clone's record, the project edits and the detach.
pub struct ProjectService {
    writer: Arc<DatabaseWriter>,
    records: Arc<ProjectRecords>,
    mounts: Arc<RepoMountService>,
    sessions: Arc<dyn ForgottenProjectSessions>,
    git: GitRunner,
    settings: Arc<dyn MachineSettingsReader>,
    driver_set_names: Vec<&'static str>,
    worktrees_folder: PathBuf,
    list_feed: Arc<ProjectListFeed>,
    // Held while a record is made, so two never take one slug.
    record_lock: KeyedLock<()>,
}

impl ProjectService {
    /// The project writer over `deps`.
    pub fn new(deps: ProjectServiceDeps) -> Self {
        let ProjectServiceDeps {
            writer,
            records,
            mounts,
            sessions,
            git,
            settings,
            driver_set_names,
            worktrees_folder,
            list_feed,
        } = deps;
        Self {
            writer,
            records,
            mounts,
            sessions,
            git,
            settings,
            driver_set_names,
            worktrees_folder,
            list_feed,
            record_lock: KeyedLock::new(),
        }
    }

    /// Attaches the folder at `request`'s path as a new project named for the folder, its row and
    /// mount in one write, or answers the project that already holds the folder's repository with
    /// nothing written. Refuses as the mount's attach refuses: a WSL place, a path that resolves
    /// to no repository, and `repoMount.alreadyAttached` when a chat's own workspace holds it.
    pub async fn attach_or_find(
        &self,
        request: &RepoMountAttachRequest,
    ) -> Result<ProjectAttachment, ProjectServiceError> {
        let hold = self.record_lock.acquire(()).await;
        let target = match self.mounts.resolve_attach_target(request).await {
            Ok(target) => target,
            Err(error) => return self.found_or_fail(error).await,
        };
        let name = project_name_of(Path::new(target.canonical_root.as_str()));
        let project_id = new_project_id();
        let insert = self
            .insert_project_statement(
                &hold,
                NewProjectRow {
                    project_id,
                    name: &name,
                    folder_path: target.canonical_root.as_str(),
                    place: target.place.as_ref(),
                    clone_url: None,
                },
            )
            .await?;
        let mount = match self
            .mounts
            .insert_attached_mount(&target, project_id, vec![insert])
            .await
        {
            Ok(mount) => mount,
            // Attached since it was resolved: the project holding it now is the answer.
            Err(error) => return self.found_or_fail(error).await,
        };
        drop(hold);
        self.record_attached(project_id, mount.repo_mount_id);
        Ok(ProjectAttachment { project_id, mount })
    }

    /// Sets the project's display name; the folder and every worktree path stay where they are.
    /// Refuses `project.notFound`.
    pub async fn rename(
        &self,
        project_id: ProjectId,
        name: &ProjectName,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        self.edit_column(
            project_id,
            RENAME_PROJECT_SQL,
            Value::Text(name.as_str().to_owned()),
        )
        .await
    }

    /// Moves an active project into the archived group; any other state is left as it is and
    /// answered. Refuses `project.notFound`.
    pub async fn archive(
        &self,
        project_id: ProjectId,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        self.move_state(project_id, ProjectState::Active, ProjectState::Archived)
            .await
    }

    /// Moves an archived project back into the list; any other state is left as it is and
    /// answered. Refuses `project.notFound`.
    pub async fn reactivate(
        &self,
        project_id: ProjectId,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        self.move_state(project_id, ProjectState::Archived, ProjectState::Active)
            .await
    }

    /// Replaces the project's setup: files to copy, commands in order, time limit. Refuses
    /// `project.notFound`.
    pub async fn update_setup(
        &self,
        project_id: ProjectId,
        setup: &ProjectSetup,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        self.edit_column(project_id, UPDATE_SETUP_SQL, Value::Text(json_text(setup)))
            .await
    }

    /// Replaces the project's own environment rows. Refuses `project.environment.nameRefused`
    /// naming the first row the name rule or a provider's driver refuses, with nothing written, and
    /// `project.notFound`.
    pub async fn update_environment(
        &self,
        project_id: ProjectId,
        environment_rows: &[EnvironmentRow],
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        refuse_environment_rows(environment_rows, &self.driver_set_names)?;
        self.edit_column(
            project_id,
            UPDATE_ENVIRONMENT_SQL,
            Value::Text(json_text(&environment_rows)),
        )
        .await
    }

    /// Sets the project's own branch pattern, or with `None` returns it to the machine's, after
    /// checking the pattern it will name branches with against git's rule and its repository's
    /// branches. Refuses `project.branchPattern.refused` with nothing written, and
    /// `project.notFound`; fails when git or the settings file could not be read.
    pub async fn update_branch_pattern(
        &self,
        project_id: ProjectId,
        pattern: Option<BranchNamePatternChange>,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        let row = self
            .records
            .read_row(project_id)
            .await?
            .ok_or(RepoRefusal::ProjectNotFound { project_id })?;
        let checked = pattern.map(BranchNamePattern::new).transpose();
        refuse_branch_pattern(checked.as_ref().err().cloned())?;
        let own_pattern = checked.ok().flatten();
        let pattern_in_effect = match &own_pattern {
            Some(own_pattern) => own_pattern.clone(),
            None => {
                self.settings
                    .read_machine_settings()
                    .await
                    .map_err(ProjectServiceError::MachineSettings)?
                    .branch_name_pattern
            }
        };
        let project = BranchPatternProject {
            id: project_id,
            folder: row.folder_path,
            place: row.place,
            state: row.state,
            has_own_pattern: own_pattern.is_some(),
        };
        refuse_branch_pattern(
            find_project_branch_pattern_refusal(&self.git, &pattern_in_effect, &project).await?,
        )?;
        let value = own_pattern.as_ref().map_or(Value::Null, |own_pattern| {
            Value::Text(own_pattern.as_str().to_owned())
        });
        self.edit_column(project_id, UPDATE_BRANCH_PATTERN_SQL, value)
            .await
    }

    /// The project's `Delete`: detaches its mount and forgets its record in one write, then
    /// archives its active sessions and those still provisioning. Refuses as the mount's detach
    /// refuses (`repoMount.detachConflict` while an agent runs anywhere in the project,
    /// `repoMount.managed`, `repoMount.notFound`). Fails with
    /// [`ProjectServiceError::SessionsNotArchived`] after every session was tried.
    pub async fn detach(
        &self,
        repo_mount_id: RepoMountId,
        actor: Option<LifecycleActor>,
        correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    ) -> Result<RepoMountDetachResponse, ProjectServiceError> {
        let subjects = self.records.read_detach_subjects(repo_mount_id).await?;
        let outcome = self
            .mounts
            .detach(
                DetachRepoMount {
                    repo_mount_id,
                    actor,
                    correlation_id,
                },
                vec![WriteStatement {
                    sql: Cow::Borrowed(FORGET_PROJECT_OF_DETACHED_MOUNT_SQL),
                    bindings: StatementBindings::Named(vec![text_binding(
                        "@repo_mount_id",
                        repo_mount_id.text().as_str(),
                    )]),
                    expected_row_count: None,
                }],
            )
            .await?;
        // The project is forgotten only when its row is gone; a detached mount forgets none.
        let forgotten = match subjects {
            Some(subjects) => self
                .records
                .read_row(subjects.project_id)
                .await?
                .is_none()
                .then_some(subjects),
            None => None,
        };
        let mut response = RepoMountDetachResponse {
            repo_mount_id: outcome.repo_mount_id,
            state: outcome.state,
            archived_workspace_ids: outcome.archived_workspace_ids,
            archived_session_ids: Vec::new(),
            forgotten_project_id: None,
        };
        let Some(forgotten) = forgotten else {
            return Ok(response);
        };
        let project_id = forgotten.project_id;
        tracing::info!(
            %project_id,
            %repo_mount_id,
            archived_workspaces = response.archived_workspace_ids.len(),
            "repo.detached"
        );
        self.list_feed.refresh(&[project_id]);
        // Each session is tried in turn; the failures are answered together once all were.
        let mut archives = Vec::with_capacity(forgotten.archivable_session_ids.len());
        for session_id in forgotten.archivable_session_ids {
            archives.push(
                self.sessions
                    .archive_of_forgotten_project(session_id)
                    .await
                    .map(|()| session_id)
                    .map_err(|source| ForgottenSessionNotArchived { session_id, source }),
            );
        }
        response.archived_session_ids =
            settle_all(archives, "archiving a forgotten project's sessions").map_err(|source| {
                ProjectServiceError::SessionsNotArchived { project_id, source }
            })?;
        response.forgotten_project_id = Some(project_id);
        Ok(response)
    }

    // An attach refused because the repository is attached already answers the project holding
    // it; a chat's own workspace holds no project, and any other failure is the caller's.
    async fn found_or_fail(
        &self,
        error: RepoMountServiceError,
    ) -> Result<ProjectAttachment, ProjectServiceError> {
        let RepoMountServiceError::Refused(RepoRefusal::AlreadyAttached {
            conflicting_repo_mount_id,
            conflicting_project_id: Some(project_id),
        }) = error
        else {
            return Err(error.into());
        };
        let row = self.mounts.read_row(conflicting_repo_mount_id).await?;
        Ok(ProjectAttachment {
            project_id,
            mount: RepoMountAttachResponse {
                repo_mount_id: row.id,
                state: row.state,
                vcs_type: row.vcs_type,
                canonical_root: FilesystemPath::new(
                    row.canonical_root.to_string_lossy().into_owned(),
                )?,
                place: row.place,
            },
        })
    }

    // The row a new project starts as, with the first slug its name leaves free.
    async fn insert_project_statement(
        &self,
        hold: &KeyHold<'_, ()>,
        row: NewProjectRow<'_>,
    ) -> Result<WriteStatement, ProjectServiceError> {
        let (state, clone_outcome) = match row.clone_url {
            Some(_) => (
                ProjectState::Cloning,
                Some(<&'static str>::from(CloneOutcome::Running)),
            ),
            None => (ProjectState::Active, None),
        };
        let slug = self
            .free_slug(hold, &slug_base_of(row.name.as_str()))
            .await?;
        let setup = ProjectSetup {
            files_to_copy: Vec::new(),
            commands: Vec::new(),
            time_limit_seconds: None,
        };
        Ok(WriteStatement {
            sql: Cow::Borrowed(INSERT_PROJECT_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", row.project_id.text().as_str()),
                text_binding("@name", row.name.as_str()),
                text_binding("@slug", &slug),
                text_binding("@folder_path", row.folder_path),
                text_binding("@state", <&'static str>::from(state)),
                nullable_text_binding("@clone_url", row.clone_url),
                nullable_text_binding("@clone_outcome", clone_outcome),
                text_binding("@setup", &json_text(&setup)),
                (Cow::Borrowed("@place"), place_value(row.place)),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: None,
        })
    }

    // Free means no project holds it and nothing sits at it in the worktrees folder, where a
    // forgotten project's worktrees may still be. Called under the record lock, which `_hold`
    // proves.
    async fn free_slug(
        &self,
        _hold: &KeyHold<'_, ()>,
        base: &str,
    ) -> Result<String, ProjectServiceError> {
        let mut ordinal = 1;
        loop {
            let candidate = slug_candidate(base, ordinal);
            if !self.records.is_slug_taken(candidate.clone()).await? {
                match tokio::fs::symlink_metadata(self.worktrees_folder.join(&candidate)).await {
                    Err(error) if is_missing_entry(&error) => return Ok(candidate),
                    Err(error) => return Err(ProjectServiceError::SlugFolder(error)),
                    Ok(_) => {}
                }
            }
            ordinal += 1;
        }
    }

    fn record_attached(&self, project_id: ProjectId, repo_mount_id: RepoMountId) {
        tracing::info!(%project_id, %repo_mount_id, "repo.attached");
        self.list_feed.refresh(&[project_id]);
    }

    // One column of the project's row, the existence check in the same write.
    async fn edit_column(
        &self,
        project_id: ProjectId,
        sql: &'static str,
        value: Value,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        self.write_project_change(
            project_id,
            vec![WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", project_id.text().as_str()),
                    (Cow::Borrowed("@value"), value),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: Some(1),
            }],
        )
        .await
    }

    async fn move_state(
        &self,
        project_id: ProjectId,
        from: ProjectState,
        to: ProjectState,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        let id = text_binding("@id", project_id.text().as_str());
        self.write_project_change(
            project_id,
            vec![
                WriteStatement {
                    sql: Cow::Borrowed(PROJECT_EXISTS_SQL),
                    bindings: StatementBindings::Named(vec![id.clone()]),
                    expected_row_count: Some(1),
                },
                WriteStatement {
                    sql: Cow::Borrowed(MOVE_PROJECT_STATE_SQL),
                    bindings: StatementBindings::Named(vec![
                        id,
                        text_binding("@from", <&'static str>::from(from)),
                        text_binding("@to", <&'static str>::from(to)),
                        text_binding("@now", WireInstant::now().as_str()),
                    ]),
                    expected_row_count: None,
                },
            ],
        )
        .await
    }

    // The write whose first statement holds only while the project exists, then the project as
    // the list now draws it. Refuses `project.notFound` with nothing written otherwise.
    async fn write_project_change(
        &self,
        project_id: ProjectId,
        statements: Vec<WriteStatement>,
    ) -> Result<ProjectEditResponse, ProjectServiceError> {
        if let Err(error) = self.writer.write(statements).await {
            return Err(match error.refused_statement_index() {
                Some(0) => RepoRefusal::ProjectNotFound { project_id }.into(),
                Some(_) | None => error.into(),
            });
        }
        self.list_feed.refresh(&[project_id]);
        let project = self
            .records
            .read_entry(project_id)
            .await?
            .ok_or(RepoRefusal::ProjectNotFound { project_id })?;
        Ok(ProjectEditResponse { project })
    }
}

// A project's name: its folder's own name, cut to the name's bound; a folder with no name of its
// own (a filesystem root) takes its slug's.
fn project_name_of(canonical_root: &Path) -> ProjectName {
    let folder_name = canonical_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    ProjectName::new(cut_to_code_points(&folder_name, PROJECT_NAME_MAX_LEN).to_owned())
        .unwrap_or_else(|_blank| {
            ProjectName::new(slug_base_of(&folder_name))
                .expect("a slug is never blank, holds no NUL and fits a project name")
        })
}

fn new_project_id() -> ProjectId {
    ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id")
}

// A value a project column keeps as JSON.
fn json_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a project column's value serializes to JSON")
}

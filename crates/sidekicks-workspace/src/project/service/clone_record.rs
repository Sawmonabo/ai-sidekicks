//! A clone's project record, from its first press to its attach: made `cloning` and running,
//! pointed at a new address and folder when run again, told where the daemon staged git's folder,
//! ended short, or attached as its mount with the record turning `active` in the same write.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{ProjectId, ProjectName, ProjectState};
use sidekicks_contracts::repo::folders::RepoMountAttachRequest;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::EntryIdentity;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use super::{
    NewProjectRow, ProjectAttachment, ProjectService, ProjectServiceError, new_project_id,
};
use crate::clone::destination::address_without_credentials;
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::service::RepoMountServiceError;
use crate::schema::CloneOutcome;

// A finished clone's record turns active in the write that inserts its mount.
static ACTIVATE_CLONED_PROJECT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects
    SET state = '{}', clone_url = NULL, clone_outcome = NULL, clone_failure = NULL,
        clone_staging_folder = NULL, clone_staging_identity = NULL, folder_path = @folder_path,
        updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(ProjectState::Active),
        <&'static str>::from(ProjectState::Cloning),
    )
});

// A clone run again: running, with the address and folder it runs with, no folder made yet.
static RETARGET_CLONE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects
    SET clone_url = @clone_url, folder_path = @folder_path, clone_outcome = '{}',
        clone_failure = NULL, clone_staging_folder = NULL, clone_staging_identity = NULL,
        updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(CloneOutcome::Running),
        <&'static str>::from(ProjectState::Cloning),
    )
});

// Written once the daemon has named the folder git clones into, before it makes it, then again
// with the folder's identity once made, before git starts, so a restart removes that folder and
// nothing else.
static RECORD_CLONE_STAGED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects
    SET clone_staging_folder = @clone_staging_folder,
        clone_staging_identity = @clone_staging_identity, updated_at = @now
  WHERE id = @id AND state = '{}' AND clone_outcome = '{}'",
        <&'static str>::from(ProjectState::Cloning),
        <&'static str>::from(CloneOutcome::Running),
    )
});

// Only a running clone ends, so a clone canceled or failed already keeps its outcome; its staged
// folder is dealt with by then, so the record lets it go.
static RECORD_CLONE_END_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects
    SET clone_outcome = @clone_outcome, clone_failure = @clone_failure,
        clone_staging_folder = NULL, clone_staging_identity = NULL, updated_at = @now
  WHERE id = @id AND state = '{}' AND clone_outcome = '{}'",
        <&'static str>::from(ProjectState::Cloning),
        <&'static str>::from(CloneOutcome::Running),
    )
});

// The clones a stop cut short, recorded interrupted at the service's start; each keeps its staged
// folder until the recovery has removed it.
static RECORD_CLONES_INTERRUPTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects SET clone_outcome = '{}', updated_at = @now
  WHERE state = '{}' AND clone_outcome = '{}'
    AND id IN (SELECT value FROM json_each(@project_ids))",
        <&'static str>::from(CloneOutcome::Interrupted),
        <&'static str>::from(ProjectState::Cloning),
        <&'static str>::from(CloneOutcome::Running),
    )
});

// A cut-short clone's staged folder removed by the start's recovery, or recorded failed with why it
// could not be.
static RECORD_STAGED_CLONE_REMOVED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE projects
    SET clone_outcome = CASE WHEN @clone_failure IS NULL THEN clone_outcome ELSE '{}' END,
        clone_failure = @clone_failure, clone_staging_folder = NULL,
        clone_staging_identity = NULL, updated_at = @now
  WHERE id = @id AND state = '{}' AND clone_outcome = '{}'",
        <&'static str>::from(CloneOutcome::Failed),
        <&'static str>::from(ProjectState::Cloning),
        <&'static str>::from(CloneOutcome::Interrupted),
    )
});

/// What a clone's record starts with.
#[derive(Clone, Debug)]
pub(crate) struct CloningProject {
    /// The address the person typed; it is stored with any user and password taken out.
    pub(crate) clone_url: String,
    /// The folder the finished clone is renamed to.
    pub(crate) folder_path: PathBuf,
    /// The repository's name, read from the address.
    pub(crate) name: ProjectName,
    /// Where the folder is; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
}

/// The address and folder an ended clone runs again with.
#[derive(Clone, Debug)]
pub(crate) struct CloneTarget {
    /// The address the person typed; it is stored with any user and password taken out.
    pub(crate) clone_url: String,
    /// The folder the finished clone is renamed to.
    pub(crate) folder_path: PathBuf,
}

/// How a running clone ended short of its attach.
#[derive(Clone, Debug)]
pub(crate) enum CloneEnd {
    /// Git failed, with its last error line.
    Failed {
        /// The line the card shows.
        line: String,
    },
    /// The person canceled it.
    Canceled,
    /// The daemon stopped while it ran.
    Interrupted,
}

impl ProjectService {
    /// Makes the record of a clone at its first press, `cloning` and running, with the start's key
    /// record `key_record` makes for the new id in the same write, and answers the id. The slug is
    /// fixed now. Fails with the write's failure.
    pub(crate) async fn create_cloning_project(
        &self,
        project: CloningProject,
        key_record: impl FnOnce(&ProjectId) -> WriteStatement + Send,
    ) -> Result<ProjectId, ProjectServiceError> {
        let hold = self.record_lock.acquire(()).await;
        let project_id = new_project_id();
        let clone_url = address_without_credentials(&project.clone_url);
        let folder_path = project.folder_path.to_string_lossy();
        let insert = self
            .insert_project_statement(
                &hold,
                NewProjectRow {
                    project_id,
                    name: &project.name,
                    folder_path: &folder_path,
                    place: project.place.as_ref(),
                    clone_url: Some(&clone_url),
                },
            )
            .await?;
        self.writer
            .write(vec![insert, key_record(&project_id)])
            .await?;
        drop(hold);
        self.list_feed.refresh(&[project_id]);
        Ok(project_id)
    }

    /// Points an ended clone at the address and folder it runs again with, marking it running,
    /// with the start's `key_record` in the same write. Refuses `project.notFound` unless the
    /// project is still `cloning`; fails with the write's failure.
    pub(crate) async fn retarget_clone(
        &self,
        project_id: ProjectId,
        target: CloneTarget,
        key_record: WriteStatement,
    ) -> Result<(), ProjectServiceError> {
        let retarget = WriteStatement {
            sql: Cow::Borrowed(RETARGET_CLONE_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", project_id.text().as_str()),
                text_binding(
                    "@clone_url",
                    &address_without_credentials(&target.clone_url),
                ),
                text_binding("@folder_path", &target.folder_path.to_string_lossy()),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        if let Err(error) = self.writer.write(vec![retarget, key_record]).await {
            return Err(match error.refused_statement_index() {
                Some(0) => RepoRefusal::ProjectNotFound { project_id }.into(),
                Some(_) | None => error.into(),
            });
        }
        self.list_feed.refresh(&[project_id]);
        Ok(())
    }

    /// Records the folder the daemon names for a running clone's git, before it is made and again
    /// with its `identity` once made, so a restart removes that folder and nothing else. Fails with
    /// the write's refusal unless the clone is still running.
    pub(crate) async fn record_clone_staged(
        &self,
        project_id: ProjectId,
        folder: &Path,
        identity: Option<&EntryIdentity>,
    ) -> Result<(), ProjectServiceError> {
        let identity = identity.map(ToString::to_string);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_CLONE_STAGED_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", project_id.text().as_str()),
                    text_binding("@clone_staging_folder", &folder.to_string_lossy()),
                    nullable_text_binding("@clone_staging_identity", identity.as_deref()),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        Ok(())
    }

    /// Records the clones `project_ids` a stop cut short interrupted, in one write, each keeping
    /// its staged folder for the recovery to remove; one no longer running is left as it is. Fails
    /// with the write's failure.
    pub(crate) async fn record_clones_interrupted(
        &self,
        project_ids: &[ProjectId],
    ) -> Result<(), ProjectServiceError> {
        let listed = serde_json::to_string(project_ids).expect("a list of ids serializes to JSON");
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_CLONES_INTERRUPTED_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@project_ids", &listed),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: None,
            }])
            .await?;
        self.list_feed.refresh(project_ids);
        Ok(())
    }

    /// Records an interrupted clone's staged folder removed, letting it go, or the clone failed
    /// with `failure`, why it could not be removed. Fails with the write's failure.
    pub(crate) async fn record_staged_clone_removed(
        &self,
        project_id: ProjectId,
        failure: Option<String>,
    ) -> Result<(), ProjectServiceError> {
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_STAGED_CLONE_REMOVED_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", project_id.text().as_str()),
                    nullable_text_binding("@clone_failure", failure.as_deref()),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: None,
            }])
            .await?;
        self.list_feed.refresh(&[project_id]);
        Ok(())
    }

    /// Records how a running clone ended short of its attach; a clone not running (attached, or
    /// ended already) is left as it is. Fails with the write's failure.
    pub(crate) async fn record_clone_end(
        &self,
        project_id: ProjectId,
        end: CloneEnd,
    ) -> Result<(), ProjectServiceError> {
        let (outcome, failure) = match end {
            CloneEnd::Failed { line } => (CloneOutcome::Failed, Some(line)),
            CloneEnd::Canceled => (CloneOutcome::Canceled, None),
            CloneEnd::Interrupted => (CloneOutcome::Interrupted, None),
        };
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_CLONE_END_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", project_id.text().as_str()),
                    text_binding("@clone_outcome", <&'static str>::from(outcome)),
                    nullable_text_binding("@clone_failure", failure.as_deref()),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: None,
            }])
            .await?;
        self.list_feed.refresh(&[project_id]);
        Ok(())
    }

    /// Attaches a finished clone's folder as its project's mount, the record turning `active` in
    /// the same write, exactly as a folder is attached. Refuses what the attach refuses, and
    /// `project.notFound` when the project is no longer cloning.
    pub(crate) async fn attach_cloned_project(
        &self,
        project_id: ProjectId,
        folder: &Path,
    ) -> Result<ProjectAttachment, ProjectServiceError> {
        let hold = self.record_lock.acquire(()).await;
        let request = RepoMountAttachRequest {
            local_path: FilesystemPath::new(folder.to_string_lossy().into_owned())?,
            place: None,
        };
        let resolved = self.mounts.resolve_folder(&request).await?;
        let target = self.mounts.attach_target_of(&resolved).await?;
        let activate = WriteStatement {
            sql: Cow::Borrowed(ACTIVATE_CLONED_PROJECT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", project_id.text().as_str()),
                text_binding("@folder_path", target.canonical_root.as_str()),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        let mount = match self
            .mounts
            .insert_attached_mount(&target, project_id, vec![activate])
            .await
        {
            Ok(mount) => mount,
            Err(RepoMountServiceError::Write(error))
                if error.refused_statement_index() == Some(0) =>
            {
                return Err(RepoRefusal::ProjectNotFound { project_id }.into());
            }
            Err(error) => return Err(error.into()),
        };
        drop(hold);
        self.record_attached(project_id, mount.repo_mount_id);
        Ok(ProjectAttachment { project_id, mount })
    }
}

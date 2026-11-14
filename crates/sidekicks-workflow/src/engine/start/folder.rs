//! The folder a run works in: a project session's run bound to that session's workspace, a named
//! project's run in a workspace of its own, the session's own folder, or a folder the start makes
//! for the run alone.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::data_folder::workflow_run_folder;
use sidekicks_workspace::run_setup_gates::execution_root::context::RunContextBinding;

use super::{CheckedStart, WorkflowRunStartError, WorkflowRunStarter};

/// The folder a run works in: the session's, or its own, which the start made and removes when it
/// ends without a run.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(super) enum RunFolder {
    Session(PathBuf),
    Own(PathBuf),
}

impl RunFolder {
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(super) fn path(&self) -> &Path {
        match self {
            Self::Session(path) | Self::Own(path) => path,
        }
    }
}

/// What a start prepared once its checks passed: the run's id, its start, its folder and, for a
/// project session's run, its binding in that session's workspace, or for a named project's run,
/// in its own.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(super) struct PreparedStart {
    /// The run.
    pub(super) workflow_run_id: WorkflowRunId,
    /// Its start.
    pub(super) started_at: WireInstant,
    /// The folder it works in.
    pub(super) folder: RunFolder,
    /// Its binding in a workspace, where it works in a project's repository.
    pub(super) binding: Option<RunContextBinding>,
}

impl WorkflowRunStarter {
    // Takes the run's start, binds a project session's run to that session's workspace and a named
    // project's run in a workspace of its own, whose root the run works in, and makes the run's
    // own folder where neither binds and the session has none.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(super) async fn prepare(
        &self,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
        checked: &CheckedStart,
    ) -> Result<PreparedStart, WorkflowRunStartError> {
        let started_at = WireInstant::now();
        let binding = match (&checked.project_root, checked.session.shape) {
            (Some(root), _) => Some(
                self.binder
                    .bind_project_run(session_id, workflow_run_id, root)
                    .await
                    .map_err(WorkflowRunStartError::Binding)?,
            ),
            // The workflow's name stands for a chat's first message in a new tree's name.
            (None, SessionShape::Project) => Some(
                self.binder
                    .bind_session_run(
                        session_id,
                        workflow_run_id.text().as_str(),
                        checked.workflow_name.as_str(),
                    )
                    .await
                    .map_err(WorkflowRunStartError::Binding)?,
            ),
            (None, SessionShape::Chat) => None,
        };
        let folder = if let Some(binding) = &binding {
            RunFolder::Session(binding.execution_root().to_path_buf())
        } else if let Some(folder) = &checked.session.working_folder {
            RunFolder::Session(folder.clone())
        } else {
            let folder =
                workflow_run_folder(&self.data_folder, &checked.definition_id, &workflow_run_id);
            make_own_folder(&folder)
                .await
                .map_err(WorkflowRunStartError::Folder)?;
            RunFolder::Own(folder)
        };
        Ok(PreparedStart {
            workflow_run_id,
            started_at,
            folder,
            binding,
        })
    }
}

// Makes `folder` new and empty: its parents as needed, then the folder itself, which must not be
// there yet, so a removal never takes a folder another start made. A run's delete removes the
// workflow's runs folder once it empties, so a parent gone between the two steps is made again;
// that single retry is the bound, and a parent gone a second time fails the start.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
async fn make_own_folder(folder: &Path) -> io::Result<()> {
    let parent = folder
        .parent()
        .expect("a run's folder sits in its workflow's runs folder");
    tokio::fs::create_dir_all(parent).await?;
    match tokio::fs::create_dir(folder).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(parent).await?;
            tokio::fs::create_dir(folder).await
        }
        made => made,
    }
}

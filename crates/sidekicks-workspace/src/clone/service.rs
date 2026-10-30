//! The clone service: where a clone goes, its start under the client's key, its card, the answer
//! to git's question, its cancel and the large-files pull, and at the service's start the clones a
//! stop cut short, recorded interrupted at once and their folders removed after.
//!
//! - Starts run one at a time under the start lock, which is always taken before the project
//!   writer's own, so two clones never take one destination; the start's removals hold it too.
//! - A start under a key on record answers that start's project when it asks the same, and is
//!   refused when it asks something else; nothing is checked or written for it again.
//! - A start whose address names an attached project's repository, or that runs again a clone
//!   still running, clones nothing and answers that project, its key recorded for it.

#[cfg(test)]
mod tests;

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::{StreamExt as _, stream};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::project::{PROJECT_NAME_MAX_LEN, ProjectId, ProjectName};
use sidekicks_contracts::repo::clone::{
    AskpassAnswer, CloneLine, CloneQuestionId, ProjectCloneFolderReadResponse,
    ProjectCloneFolderSource, ProjectCloneRefusedDetails, ProjectCloneStartRequest,
    ProjectCloneStartResponse, ProjectCloneStatus,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::processor_bound::processor_count;
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use tracing::warn;

use crate::clone::askpass::broker::{AskpassBroker, AskpassBrokerError};
use crate::clone::card::{CloneCards, status_of_outcome};
use crate::clone::destination::{
    DestinationState, StagedClone, StagedFolder, read_destination_state, repository_key_of,
    repository_name_of,
};
use crate::clone::large_files::{LargeFilesReadError, is_large_files_installed, keeps_large_files};
use crate::clone::requests::{CloneRequestFields, KeyRecord, read_key_record};
use crate::clone::run::{CloneJob, CloneRuns, CloneRunsDeps, CutShortFolder};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{
    CONFIG_UNSET_EXIT_CODE, GitCall, GitError, GitRunner, background_read, strip_line_end,
};
use crate::machine_settings::MachineSettingsReader;
use crate::project::records::{AttachedProjectRoot, ProjectReadError, ProjectRecords};
use crate::project::service::clone_record::{CloneTarget, CloningProject};
use crate::project::service::{ProjectService, ProjectServiceError};
use crate::repo::errors::{RepoRefusal, refuse_distribution, refuse_relative_clone_folder};
use crate::repo::root_resolver::{refusal_of_filesystem_failure, require_unicode_path};

// Git's own line for an address it can name no folder from, which the refusal carries.
const NO_DIRECTORY_NAME_LINE: &str = "fatal: No directory name could be guessed.";

/// Hears that a clone attached, to finish the sessions made while it ran.
pub trait CloneAttachedListener: Send + Sync {
    /// Finishes the sessions that waited on the project's clone. Fails with why they could not be
    /// finished, which the clone's card shows; the attached clone stays either way.
    fn clone_attached(
        &self,
        project_id: ProjectId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What the clone service reads, writes and runs.
pub struct CloneServiceDeps {
    /// The project writer that keeps the clone's record and attaches the finished clone.
    pub projects: Arc<ProjectService>,
    /// The project reads, shared with the project writer.
    pub records: Arc<ProjectRecords>,
    /// The read pool the start's key records are read through.
    pub reads: Arc<DatabaseReadPool>,
    /// The writer a start answered with no create records its key through.
    pub writer: Arc<DatabaseWriter>,
    /// Carries git's questions to the card and the answers back; the service closes it at its
    /// stop.
    pub askpass: AskpassBroker,
    /// The machine's settings, which name the folder set for clones.
    pub settings: Arc<dyn MachineSettingsReader>,
    /// The home folder of the account the service runs as, the last place a clone goes.
    pub home_folder: PathBuf,
    /// The daemon's git.
    pub git: GitRunner,
    /// The sessions that waited on a clone, told once it attaches.
    pub clone_attached: Arc<PortRegistration<Arc<dyn CloneAttachedListener>>>,
}

/// Why a clone call failed or the service could not start.
#[derive(Debug, thiserror::Error)]
pub enum CloneServiceError {
    /// The call was refused; nothing was written.
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// The project writer refused or failed.
    #[error(transparent)]
    Project(#[from] ProjectServiceError),
    /// The project rows or the start's key record could not be read.
    #[error(transparent)]
    Read(#[from] ProjectReadError),
    /// The machine's settings file could not be read.
    #[error("the machine's settings could not be read")]
    MachineSettings(#[source] Box<dyn Error + Send + Sync>),
    /// Git could not answer whether Git LFS is installed.
    #[error("git could not tell whether Git LFS is installed")]
    Git(#[from] GitError),
    /// A cloned project's repositories could not be read for their large files.
    #[error("a cloned project's large-file settings could not be read")]
    LargeFiles(#[from] LargeFilesReadError),
    /// A folder the clone goes to, or the address's repository, could not be read.
    #[error("the clone's folder or address could not be read")]
    Folder(#[from] io::Error),
    /// A folder or a name does not read as wire text.
    #[error("a clone folder or name is not text the reply can carry")]
    Text(#[from] TextError),
    /// The key record of a start answered with no create could not be written.
    #[error("the clone start's key record could not be written")]
    Write(#[from] WriteError),
}

impl CloneServiceError {
    /// The refusal every clone call answers while the service is not running, carrying the text of
    /// its failed start, or none when it was never started.
    pub fn unavailable(message: String) -> Self {
        Self::Refused(RepoRefusal::CloneUnavailable { message })
    }
}

impl From<CloneServiceError> for HandlerError {
    /// A refusal is answered with its code; every other failure is a fault.
    fn from(error: CloneServiceError) -> Self {
        match error {
            CloneServiceError::Refused(refusal) => Self::Refused(refusal.into()),
            CloneServiceError::Project(error) => error.into(),
            other @ (CloneServiceError::Read(_)
            | CloneServiceError::MachineSettings(_)
            | CloneServiceError::Git(_)
            | CloneServiceError::LargeFiles(_)
            | CloneServiceError::Folder(_)
            | CloneServiceError::Text(_)
            | CloneServiceError::Write(_)) => Self::Internal(Box::new(other)),
        }
    }
}

/// Clones repositories into projects and keeps each clone's card.
pub struct CloneService {
    projects: Arc<ProjectService>,
    records: Arc<ProjectRecords>,
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    settings: Arc<dyn MachineSettingsReader>,
    home_folder: PathBuf,
    git: GitRunner,
    cards: Arc<CloneCards>,
    runs: Arc<CloneRuns>,
    // Each project whose folder a stop left is held until that folder is removed.
    removals: Arc<KeyedLock<ProjectId>>,
    starts: Arc<KeyedLock<()>>,
}

impl CloneService {
    /// Starts the service: each clone recorded running was cut short by the last stop, so all of
    /// them are recorded interrupted in one write, and the folders the daemon named for their git
    /// are removed on a task of the service's own, while their paths still hold what it made, each
    /// under the start lock and its project held until its folder is gone, so a rerun waits for
    /// it; a folder that cannot be removed records its clone failed with the reason. Fails when
    /// the cut-short clones cannot be read or their ends cannot be recorded; the broker is then
    /// dropped, which stops it.
    pub async fn start(deps: CloneServiceDeps) -> Result<Arc<Self>, CloneServiceError> {
        let cards = Arc::new(CloneCards::default());
        let runs = Arc::new(CloneRuns::new(CloneRunsDeps {
            projects: Arc::clone(&deps.projects),
            cards: Arc::clone(&cards),
            git: deps.git.clone(),
            askpass: deps.askpass,
            clone_attached: deps.clone_attached,
        }));
        let cut_short = deps.records.read_cut_short_clones().await?;
        let running: Vec<ProjectId> = cut_short
            .iter()
            .filter(|clone| clone.is_running)
            .map(|clone| clone.project_id)
            .collect();
        if !running.is_empty() {
            deps.projects.record_clones_interrupted(&running).await?;
        }
        let folders: Vec<CutShortFolder> = cut_short
            .into_iter()
            .filter_map(|clone| {
                let (path, identity) = clone.staged?;
                Some(CutShortFolder {
                    project_id: clone.project_id,
                    staged: match identity {
                        Some(identity) => StagedFolder::Made(StagedClone { path, identity }),
                        None => StagedFolder::Named(path),
                    },
                    destination: clone.folder_path,
                })
            })
            .collect();
        let removals = Arc::new(KeyedLock::new());
        let starts = Arc::new(KeyedLock::new());
        if !folders.is_empty() {
            runs.remove_cut_short_folders(folders, Arc::clone(&removals), Arc::clone(&starts))
                .await;
        }
        Ok(Arc::new(Self {
            projects: deps.projects,
            records: deps.records,
            reads: deps.reads,
            writer: deps.writer,
            settings: deps.settings,
            home_folder: deps.home_folder,
            git: deps.git,
            cards,
            runs,
            removals,
            starts,
        }))
    }

    /// Where a clone goes when the person names no folder: the folder set for clones, else the
    /// folder holding the most recently attached project, else the home folder. Refuses
    /// `repoMount.distributionNotFound` for a folder set in a WSL distribution; fails when the
    /// settings or the projects cannot be read.
    pub async fn read_clone_folder(
        &self,
    ) -> Result<ProjectCloneFolderReadResponse, CloneServiceError> {
        let (folder, source) = self.resolve_clone_folder().await?;
        Ok(ProjectCloneFolderReadResponse {
            folder: FilesystemPath::new(folder.to_string_lossy().into_owned())?,
            // No folder is in a WSL distribution on this system.
            place: None,
            source,
        })
    }

    /// Starts a clone of `request.url` and answers its project at once: a new one marked
    /// `cloning`, or `request.projectId` run again after a failed or canceled clone. Refuses
    /// `project.clone.idempotencyConflict` for a key on record whose start asked otherwise,
    /// `repoMount.distributionNotFound` for a WSL place, the request's or the folder set for
    /// clones, `request.paramsInvalid` for a relative parent folder,
    /// `repoMount.rootResolutionFailed` for a parent folder whose path is not Unicode or cannot be
    /// read, `project.clone.refused` when the address leaves no folder name or the destination is
    /// taken, and `project.notFound` for a project no longer cloning; nothing is written for any
    /// of them.
    pub async fn start_clone(
        &self,
        request: ProjectCloneStartRequest,
    ) -> Result<ProjectCloneStartResponse, CloneServiceError> {
        // A rerun waits for the removal of the folder a stop left it, before the start lock, which
        // that removal takes too.
        let _removed = match request.project_id {
            Some(project_id) => Some(self.removals.acquire(project_id).await),
            None => None,
        };
        let _starting = self.starts.acquire(()).await;
        let fields = CloneRequestFields::of(&request);
        let key = &request.client_idempotency_key;
        match read_key_record(&self.reads, key, fields.clone()).await? {
            KeyRecord::Answers(project_id) => return Ok(ProjectCloneStartResponse { project_id }),
            KeyRecord::Conflicts(project_id) => {
                return Err(RepoRefusal::CloneIdempotencyConflict { project_id }.into());
            }
            KeyRecord::New => {}
        }
        refuse_distribution(request.place.as_ref())?;
        if let Some(parent_folder) = &request.parent_folder {
            refuse_relative_clone_folder(parent_folder.as_str())?;
        }
        let parent_folder = match &request.parent_folder {
            Some(parent_folder) => PathBuf::from(parent_folder.as_str()),
            None => self.resolve_clone_folder().await?.0,
        };
        refuse_parent_folder_not_unicode(&parent_folder).await?;
        let url = request.url.as_str();
        if let Some(project_id) = self.find_attached_project_of(url).await? {
            return self.answer_with_key(&fields, key, project_id).await;
        }
        let Some(name) = repository_name_of(url) else {
            let line =
                CloneLine::new(NO_DIRECTORY_NAME_LINE.to_owned()).expect("git's line has words");
            return Err(RepoRefusal::CloneRefused {
                details: ProjectCloneRefusedDetails::NoDirectoryName { line },
            }
            .into());
        };
        if let Some(project_id) = request.project_id
            && self.cards.is_running(project_id)
        {
            return self.answer_with_key(&fields, key, project_id).await;
        }
        let destination = parent_folder.join(&name);
        let destination_key = canonical_folder_path(&destination).await?;
        if self.cards.is_filled_by_running_clone(&destination_key)
            || read_destination_state(&destination).await? == DestinationState::Taken
        {
            return Err(RepoRefusal::CloneRefused {
                details: ProjectCloneRefusedDetails::DestinationNotEmpty {},
            }
            .into());
        }
        let project_id = match request.project_id {
            None => {
                let project = CloningProject {
                    clone_url: url.to_owned(),
                    folder_path: destination.clone(),
                    name: ProjectName::new(
                        cut_to_code_points(&name, PROJECT_NAME_MAX_LEN).to_owned(),
                    )?,
                    place: None,
                };
                self.projects
                    .create_cloning_project(project, |project_id| {
                        fields.record_statement(key, *project_id)
                    })
                    .await?
            }
            Some(project_id) => {
                let target = CloneTarget {
                    clone_url: url.to_owned(),
                    folder_path: destination.clone(),
                };
                self.projects
                    .retarget_clone(project_id, target, fields.record_statement(key, project_id))
                    .await?;
                project_id
            }
        };
        self.runs.start_clone(CloneJob {
            project_id,
            url: url.to_owned(),
            destination,
            destination_key,
        });
        Ok(ProjectCloneStartResponse { project_id })
    }

    /// Opens the project's clone card for `outlet`: its status now, and every update after, at
    /// most four a second; answers the detach that lets the reader go. Refuses `project.notFound`
    /// with nothing opened when no such project exists; fails when its record or its large-file
    /// settings cannot be read.
    pub async fn follow_card(
        &self,
        project_id: ProjectId,
        outlet: LatestValueOutlet<ProjectCloneStatus>,
    ) -> Result<Box<dyn FnOnce() + Send>, CloneServiceError> {
        let status = self.read_card_status(project_id).await?;
        // Another reader or a run may have opened the card while the record was read; its status
        // is the newer. A run that ended while the record was read has its end recorded by now.
        let outlet_id = match self.cards.attach(project_id, status, outlet) {
            Ok(outlet_id) => outlet_id,
            Err(outlet) => {
                let status = self.read_card_status(project_id).await?;
                self.cards.attach_at(project_id, status, outlet)
            }
        };
        let cards = Arc::clone(&self.cards);
        Ok(Box::new(move || cards.detach(project_id, outlet_id)))
    }

    /// Hands `answer` to the git question `question_id` waits on; a question no longer waiting
    /// takes nothing. Refuses `project.notFound` when no such project exists.
    pub async fn answer(
        &self,
        project_id: ProjectId,
        question_id: CloneQuestionId,
        answer: AskpassAnswer,
    ) -> Result<(), CloneServiceError> {
        if self.cards.answer(project_id, question_id, answer) {
            return Ok(());
        }
        self.require_project(project_id).await
    }

    /// Stops the project's clone, removes what it made and records it canceled, or stops its
    /// large-files pull and leaves the clone; answers once git has ended and the card holds the
    /// end. Nothing running takes nothing. Refuses `project.notFound` when no such project exists.
    pub async fn cancel(&self, project_id: ProjectId) -> Result<(), CloneServiceError> {
        match self.cards.cancel(project_id) {
            Some(ended) => {
                ended.cancelled().await;
                Ok(())
            }
            None => self.require_project(project_id).await,
        }
    }

    /// Fetches an attached project's large files, `git lfs install --local` then `git lfs pull` in
    /// each of its repositories, the card following it; without Git LFS the card reads that large
    /// files are missing, and while a clone or pull runs nothing starts. Refuses
    /// `project.notFound` unless the project is attached; fails when git cannot say whether Git
    /// LFS is installed.
    pub async fn pull_large_files(&self, project_id: ProjectId) -> Result<(), CloneServiceError> {
        let root = self
            .records
            .read_project_root(project_id)
            .await?
            .ok_or(RepoRefusal::ProjectNotFound { project_id })?;
        let is_installed = is_large_files_installed(&self.git, root.place.as_ref()).await?;
        if !is_installed {
            self.cards.publish_idle(
                project_id,
                ProjectCloneStatus::LargeFilesMissing { project_id },
            );
            return Ok(());
        }
        self.runs
            .start_large_files_pull(project_id, root.canonical_root, root.place);
        Ok(())
    }

    /// Stops every running git with the stop's grace and waits within `bound` for each run to
    /// record its end and for the start's folder removals, leaving any still running at the bound
    /// to finish on its own, logged; then ends every card and closes the askpass broker. A clone
    /// stopped so is recorded as one a restart cut short. Fails when the broker's listening task
    /// panicked.
    pub async fn close(&self, bound: Duration) -> Result<(), AskpassBrokerError> {
        self.runs.close(bound).await
    }

    // The folder set for clones, else the parent of the most recently attached project's folder,
    // else the home folder, with which of them it is; a folder set in a WSL distribution is
    // refused, since this daemon reaches none.
    async fn resolve_clone_folder(
        &self,
    ) -> Result<(PathBuf, ProjectCloneFolderSource), CloneServiceError> {
        let settings = self
            .settings
            .read_machine_settings()
            .await
            .map_err(CloneServiceError::MachineSettings)?;
        if let Some(folder) = settings.clone_folder {
            refuse_distribution(folder.place.as_ref())?;
            return Ok((
                PathBuf::from(folder.path.as_str()),
                ProjectCloneFolderSource::Setting,
            ));
        }
        let last_attached = self.records.read_attached_roots().await?.into_iter().next();
        if let Some(parent) = last_attached
            .as_ref()
            .and_then(|root| root.canonical_root.parent())
        {
            return Ok((parent.to_path_buf(), ProjectCloneFolderSource::LastProject));
        }
        Ok((self.home_folder.clone(), ProjectCloneFolderSource::Home))
    }

    // The status a card opens with when none is open: read from the project's record.
    async fn read_card_status(
        &self,
        project_id: ProjectId,
    ) -> Result<ProjectCloneStatus, CloneServiceError> {
        let row = self
            .records
            .read_row(project_id)
            .await?
            .ok_or(RepoRefusal::ProjectNotFound { project_id })?;
        // Only a project still cloning holds an outcome.
        if let Some(clone) = row.clone {
            return Ok(status_of_outcome(
                project_id,
                clone.outcome,
                clone.failure.as_deref(),
            ));
        }
        let place = row.place.as_ref();
        let keeps = match keeps_large_files(&self.git, place, &row.folder_path).await {
            Ok(keeps) => keeps,
            // A project whose folder is gone keeps nothing the card could fetch.
            Err(LargeFilesReadError::File(error)) if is_missing_entry(&error) => false,
            Err(error) => return Err(error.into()),
        };
        if keeps && !is_large_files_installed(&self.git, place).await? {
            return Ok(ProjectCloneStatus::LargeFilesMissing { project_id });
        }
        Ok(ProjectCloneStatus::Done { project_id })
    }

    // Answers `project_id` to a start that creates nothing, keeping its key's record for it, so a
    // resend answers it again and another request under the key is refused.
    async fn answer_with_key(
        &self,
        fields: &CloneRequestFields,
        key: &ClientUuid,
        project_id: ProjectId,
    ) -> Result<ProjectCloneStartResponse, CloneServiceError> {
        self.writer
            .write(vec![fields.record_statement(key, project_id)])
            .await?;
        Ok(ProjectCloneStartResponse { project_id })
    }

    // Answers when the project exists; refuses `project.notFound` when it does not.
    async fn require_project(&self, project_id: ProjectId) -> Result<(), CloneServiceError> {
        match self.records.read_row(project_id).await? {
            Some(_) => Ok(()),
            None => Err(RepoRefusal::ProjectNotFound { project_id }.into()),
        }
    }

    // The attached project whose repository `url` names, read from each project's `origin`, at
    // most one git per processor at a time; a project whose origin cannot be read is logged and
    // passed over, so one broken project never stops a clone. Fails only when the address's own
    // repository cannot be read.
    async fn find_attached_project_of(
        &self,
        url: &str,
    ) -> Result<Option<ProjectId>, CloneServiceError> {
        let key = repository_key_of(url)?;
        let roots = self.records.read_attached_roots().await?;
        let mut origins = stream::iter(roots)
            .map(|root| async move {
                let origin = self.read_origin_key(&root).await;
                (root.project_id, origin)
            })
            .buffered(processor_count());
        while let Some((project_id, origin)) = origins.next().await {
            match origin {
                Ok(Some(origin)) if origin == key => return Ok(Some(project_id)),
                Ok(_) => {}
                Err(error) => warn!(
                    project_id = %project_id,
                    error = &error as &(dyn Error + 'static),
                    "a project was passed over by a clone's start: its origin could not be read"
                ),
            }
        }
        Ok(None)
    }

    // The repository the project's `origin` names, or `None` when it has none.
    async fn read_origin_key(
        &self,
        root: &AttachedProjectRoot,
    ) -> Result<Option<String>, OriginReadError> {
        let call = GitCall::read(background_read(
            &root.canonical_root,
            &["config", "--get", "remote.origin.url"],
        ));
        let output = match self.git.run(root.place.as_ref(), call).await {
            Ok(output) => output,
            Err(error) if error.exit_code() == Some(CONFIG_UNSET_EXIT_CODE) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let origin = String::from_utf8_lossy(&strip_line_end(output.stdout)).into_owned();
        Ok(Some(repository_key_of(&origin)?))
    }
}

// Why an attached project's origin could not be read.
#[derive(Debug, thiserror::Error)]
enum OriginReadError {
    #[error("git could not read the origin")]
    Git(#[from] GitError),
    #[error("the origin's repository could not be read")]
    Key(#[from] io::Error),
}

// Refuses `notUnicode` for a parent folder whose resolved path is not valid Unicode, where it
// exists so far, and the system's reason for one that cannot be read, before anything is made.
async fn refuse_parent_folder_not_unicode(parent_folder: &Path) -> Result<(), RepoRefusal> {
    let resolved = resolve_real_location(parent_folder)
        .await
        .map_err(|error| refusal_of_filesystem_failure(&error))?;
    require_unicode_path(&resolved)?;
    Ok(())
}

//! The git runs a clone card follows: the clone into a folder the daemon made beside the
//! destination, moved into place and attached, then the sessions that waited on it; and a
//! large-files pull in a cloned project. Each run carries git's progress and questions to the card,
//! and a clone ended short leaves nothing but its record: the folder it made is removed while that
//! path still holds it.

use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::{CloneLine, ProjectCloneFailedStep, ProjectCloneStatus};
use sidekicks_platforms::ChildExit;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::warn;

use crate::clone::askpass::broker::{AskpassBroker, AskpassBrokerError, AskpassOwnerIdError};
use crate::clone::card::{ActivityStep, CloneActivity, CloneCards, clone_line, status_of_outcome};
use crate::clone::destination::{
    DestinationState, StagedClone, StagedCloneError, StagedFolder, address_without_credentials,
    make_staged_clone, move_staged_clone_into_place, name_staged_clone, read_destination_state,
    remove_staged_folder,
};
use crate::clone::large_files::{
    LARGE_FILES_CLONE_OPTIONS, LargeFilesReadError, clone_repositories, is_large_files_installed,
    keeps_large_files,
};
use crate::clone::progress::GitProgressReader;
use crate::clone::service::CloneAttachedListener;
use crate::clone::streamed_git::{StreamedGitError, run_streamed_git};
use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::project::service::clone_record::CloneEnd;
use crate::project::service::{ProjectService, ProjectServiceError};
use crate::schema::CloneOutcome;

// Git waits a second before it writes progress unless told not to; the card shows it at once.
const PROGRESS_DELAY_VARIABLE: &str = "GIT_PROGRESS_DELAY";

// The card's line when the folder filled between the start's look and the clone's move.
const DESTINATION_FILLED_LINE: &str = "The folder to clone into is no longer empty";

// The card's line for a run asked to start while the service stops.
const SERVICE_STOPPING_LINE: &str = "The clone service is stopping";

/// What the clone runs read, write and run.
pub(crate) struct CloneRunsDeps {
    /// The project writer that keeps the clone's record and attaches the finished clone.
    pub(crate) projects: Arc<ProjectService>,
    /// The cards the runs report to.
    pub(crate) cards: Arc<CloneCards>,
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// Carries git's questions to the card and the answers back.
    pub(crate) askpass: AskpassBroker,
    /// The sessions that waited on a clone, told once it attaches.
    pub(crate) clone_attached: Arc<PortRegistration<Arc<dyn CloneAttachedListener>>>,
}

/// A clone the last stop cut short whose staged folder the start's recovery removes.
pub(crate) struct CutShortFolder {
    /// The cloning project, recorded interrupted.
    pub(crate) project_id: ProjectId,
    /// The folder as its record names it.
    pub(crate) staged: StagedFolder,
    /// The destination, where a made folder stands once renamed.
    pub(crate) destination: PathBuf,
}

/// A clone to run: its project, the address as typed, and the destination it is moved to.
pub(crate) struct CloneJob {
    /// The cloning project.
    pub(crate) project_id: ProjectId,
    /// The address, handed to git as typed.
    pub(crate) url: String,
    /// The folder the finished clone is moved to.
    pub(crate) destination: PathBuf,
    /// The destination as folders compare, which no other clone may fill while this one runs.
    pub(crate) destination_key: PathBuf,
}

/// Runs the clones and pulls, each on a task of its own, until the service's stop.
pub(crate) struct CloneRuns {
    projects: Arc<ProjectService>,
    cards: Arc<CloneCards>,
    git: GitRunner,
    // Taken at the stop, once every run has ended, to be closed.
    askpass: Mutex<Option<AskpassBroker>>,
    clone_attached: Arc<PortRegistration<Arc<dyn CloneAttachedListener>>>,
    // Cancelled at the service's stop, which ends every git with the stop's grace.
    shutdown: CancellationToken,
    tasks: TaskTracker,
}

// Why a run ended short of its success: the person's cancel, the service's stop, git's own failure
// line, a destination that filled, or a step around git that failed.
#[derive(Debug, thiserror::Error)]
enum CloneRunError {
    #[error("the person canceled it")]
    Canceled,
    #[error("the service stopped while git ran")]
    Interrupted,
    #[error("{}", .0.as_str())]
    GitFailed(CloneLine),
    #[error("{}", DESTINATION_FILLED_LINE)]
    DestinationFilled,
    #[error("{}", SERVICE_STOPPING_LINE)]
    ServiceStopping,
    #[error("git could not be run")]
    Git(#[from] GitError),
    #[error("git could not be followed to its end")]
    StreamedGit(#[from] StreamedGitError),
    #[error("the clone's repositories could not be read")]
    LargeFiles(#[from] LargeFilesReadError),
    #[error("the clone's destination could not be read or moved into")]
    Destination(#[from] io::Error),
    #[error("the clone's folder could not be made")]
    Staged(#[from] StagedCloneError),
    #[error("the clone's record could not be kept")]
    Project(#[from] ProjectServiceError),
    #[error("git's questions could not be routed to the card")]
    AskpassOwner(#[from] AskpassOwnerIdError),
}

impl CloneRunError {
    // The line a failure reads as, logging a failure around git with its causes.
    fn failure_line(self, project_id: ProjectId) -> CloneLine {
        let text = match self {
            Self::GitFailed(line) => return line,
            Self::Canceled
            | Self::Interrupted
            | Self::DestinationFilled
            | Self::ServiceStopping => self.to_string(),
            Self::Git(_)
            | Self::StreamedGit(_)
            | Self::LargeFiles(_)
            | Self::Destination(_)
            | Self::Staged(_)
            | Self::Project(_)
            | Self::AskpassOwner(_) => {
                warn!(
                    project_id = %project_id,
                    error = &self as &(dyn Error + 'static),
                    "a clone or large-files pull failed around git"
                );
                describe_error(&self)
            }
        };
        clone_line(&text).expect("an error's message has words")
    }
}

impl CloneRuns {
    /// The runs over `deps`, none started.
    pub(crate) fn new(deps: CloneRunsDeps) -> Self {
        Self {
            projects: deps.projects,
            cards: deps.cards,
            git: deps.git,
            askpass: Mutex::new(Some(deps.askpass)),
            clone_attached: deps.clone_attached,
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }
    }

    /// Starts `clone` on a task of its own, its card cloning; a clone or pull already running on
    /// the card keeps it, and nothing starts.
    pub(crate) fn start_clone(self: &Arc<Self>, clone: CloneJob) {
        let activity = CloneActivity::new(ActivityStep::Clone);
        let (cancel, ended) = (activity.cancel().clone(), activity.ended().clone());
        if !self.cards.begin(
            clone.project_id,
            activity,
            Some(clone.destination_key.clone()),
        ) {
            return;
        }
        let runs = Arc::clone(self);
        self.tasks.spawn(async move {
            let _ended = ended.drop_guard();
            let status = runs.run_clone(&clone, &cancel).await;
            runs.cards.end(clone.project_id, status);
        });
    }

    /// Starts a large-files pull in the project's folder `root` at `place` on a task of its own;
    /// a clone or pull already running on the card keeps it, and nothing starts.
    pub(crate) fn start_large_files_pull(
        self: &Arc<Self>,
        project_id: ProjectId,
        root: PathBuf,
        place: Option<Place>,
    ) {
        let activity = CloneActivity::new(ActivityStep::LargeFiles);
        let (cancel, ended) = (activity.cancel().clone(), activity.ended().clone());
        if !self.cards.begin(project_id, activity, None) {
            return;
        }
        let runs = Arc::clone(self);
        self.tasks.spawn(async move {
            let _ended = ended.drop_guard();
            let status = match runs
                .pull_large_files(project_id, &root, place.as_ref(), &cancel)
                .await
            {
                Ok(()) => ProjectCloneStatus::Done { project_id },
                Err(CloneRunError::Canceled) => ProjectCloneStatus::Canceled { project_id },
                Err(error) => ProjectCloneStatus::Failed {
                    project_id,
                    step: ProjectCloneFailedStep::LargeFiles,
                    failure_line: Some(error.failure_line(project_id)),
                },
            };
            runs.cards.end(project_id, status);
        });
    }

    /// Removes the folder the daemon named for a clone's git while that path still holds what it
    /// made there, then records how the clone ended; a folder that cannot be removed records the
    /// clone failed with the reason instead. Answers the end recorded; fails when the record is
    /// not kept.
    pub(crate) async fn end_short(
        &self,
        project_id: ProjectId,
        staged: Option<&StagedFolder>,
        end: CloneEnd,
    ) -> Result<CloneEnd, ProjectServiceError> {
        let mut recorded = end;
        if let Some(staged) = staged
            && let Err(error) = remove_staged_folder(staged).await
        {
            recorded = CloneEnd::Failed {
                line: removal_failure_line(&error),
            };
        }
        self.projects
            .record_clone_end(project_id, recorded.clone())
            .await?;
        Ok(recorded)
    }

    /// Removes the staged folders of the clones the last stop cut short, recorded interrupted
    /// already, on a task of its own the close waits on, so the daemon's start waits for none of
    /// them. The task holds `starts`, the start lock, through each folder's removal and lets it go
    /// between folders, so a start waits out the removal under way but never the whole pass;
    /// answers once it holds it for the first. Each folder goes while its path still holds what
    /// the daemon made, a made one at the destination too once renamed there; its record lets it
    /// go, or records the clone failed with why it could not.
    pub(crate) async fn remove_cut_short_folders(
        self: &Arc<Self>,
        clones: Vec<CutShortFolder>,
        starts: Arc<KeyedLock<()>>,
    ) {
        let (held, holding) = oneshot::channel();
        let runs = Arc::clone(self);
        self.tasks.spawn(async move {
            let mut held = Some(held);
            for clone in clones {
                let _starting = starts.acquire(()).await;
                if let Some(held) = held.take()
                    && held.send(()).is_err()
                {
                    tracing::debug!("the clone service's start stopped waiting for its recovery");
                }
                runs.remove_cut_short_folder(clone).await;
            }
        });
        // A task stopped before it held the lock leaves the start nothing to wait for.
        if holding.await.is_err() {
            warn!("the removal of the folders a stop left ended before it began");
        }
    }

    /// Stops every run with the stop's grace and waits within `bound` for each to end and record
    /// its end, the removals of the folders a stop left among them; a task still running at the
    /// bound is logged and left to finish on its own. Then ends every card and closes the askpass
    /// broker. Fails when the broker's listening task panicked.
    pub(crate) async fn close(&self, bound: Duration) -> Result<(), AskpassBrokerError> {
        self.shutdown.cancel();
        self.tasks.close();
        if tokio::time::timeout(bound, self.tasks.wait())
            .await
            .is_err()
        {
            warn!(
                running = self.tasks.len(),
                "clone tasks still ran when the stop's bound ran out; they are left to finish"
            );
        }
        self.cards.close();
        let broker = lock(&self.askpass).take();
        match broker {
            Some(broker) => broker.close().await,
            None => Ok(()),
        }
    }

    // Removes one cut-short clone's staged folder, at its recorded path and, once made, at the
    // destination it may have been renamed to, then records it gone or the clone failed with why.
    async fn remove_cut_short_folder(&self, clone: CutShortFolder) {
        let mut removed = remove_staged_folder(&clone.staged).await;
        if let (Ok(()), StagedFolder::Made(made)) = (&removed, &clone.staged) {
            let placed = StagedFolder::Made(StagedClone {
                path: clone.destination,
                identity: made.identity,
            });
            removed = remove_staged_folder(&placed).await;
        }
        let failure = removed.err().map(|error| removal_failure_line(&error));
        if let Err(error) = self
            .projects
            .record_staged_clone_removed(clone.project_id, failure)
            .await
        {
            warn!(
                project_id = %clone.project_id,
                error = &error as &(dyn Error + 'static),
                "the removal of a cut-short clone's folder could not be recorded"
            );
        }
    }

    // The clone to its end: placed, attached and the waiting sessions told; or ended short, its
    // folder removed and its end recorded.
    async fn run_clone(&self, clone: &CloneJob, cancel: &CancellationToken) -> ProjectCloneStatus {
        let project_id = clone.project_id;
        let mut staged = None;
        let placed = self.clone_into_place(clone, cancel, &mut staged).await;
        let end = match placed {
            Ok(is_missing_large_files) => {
                return self
                    .tell_clone_attached(project_id, is_missing_large_files)
                    .await;
            }
            Err(CloneRunError::Canceled) => CloneEnd::Canceled,
            Err(CloneRunError::Interrupted) => CloneEnd::Interrupted,
            Err(error) => {
                // git prints the address it was given in some of its lines; the address is kept
                // only without its credentials.
                let line = without_typed_address(error.failure_line(project_id), &clone.url);
                CloneEnd::Failed {
                    line: line.into_string(),
                }
            }
        };
        match self.end_short(project_id, staged.as_ref(), end).await {
            Ok(recorded) => status_of_end(project_id, &recorded),
            Err(error) => ProjectCloneStatus::Failed {
                project_id,
                step: ProjectCloneFailedStep::Clone,
                failure_line: Some(CloneRunError::Project(error).failure_line(project_id)),
            },
        }
    }

    // Clones into a folder named and made beside the destination, then moves it into place and
    // attaches it; answers whether the clone keeps large files Git LFS is not there to fetch. The
    // folder is left in `staged` from its naming on, at the destination once moved, for an end
    // short to remove.
    async fn clone_into_place(
        &self,
        clone: &CloneJob,
        cancel: &CancellationToken,
        staged: &mut Option<StagedFolder>,
    ) -> Result<bool, CloneRunError> {
        let has_large_files = is_large_files_installed(&self.git, None).await?;
        // The folder may have filled since the start looked; what is there now is not the clone's.
        if read_destination_state(&clone.destination).await? == DestinationState::Taken {
            return Err(CloneRunError::DestinationFilled);
        }
        // Recorded before it is made, so no stop leaves a folder its record does not name.
        let named = name_staged_clone(&clone.destination)?;
        self.projects
            .record_clone_staged(clone.project_id, &named, None)
            .await?;
        *staged = Some(StagedFolder::Named(named.clone()));
        let made = make_staged_clone(&named).await?;
        self.projects
            .record_clone_staged(clone.project_id, &made.path, Some(&made.identity))
            .await?;
        *staged = Some(StagedFolder::Made(made.clone()));
        let mut arguments: Vec<OsString> = Vec::new();
        if has_large_files {
            arguments.extend(LARGE_FILES_CLONE_OPTIONS.iter().map(OsString::from));
        }
        arguments.extend(
            ["clone", "--recurse-submodules", "--progress", "--"]
                .into_iter()
                .map(OsString::from),
        );
        arguments.push(OsString::from(&clone.url));
        arguments.push(made.path.clone().into_os_string());
        let call = progress_at_once(GitCall::write(arguments));
        let ran = self
            .run_git_followed(clone.project_id, None, call, cancel)
            .await;
        if cancel.is_cancelled() {
            return Err(CloneRunError::Canceled);
        }
        match ran {
            Ok(()) => {}
            // A clone the service's stop ended reads as one a restart cut short, with no line.
            Err(CloneRunError::GitFailed(_)) if self.shutdown.is_cancelled() => {
                return Err(CloneRunError::Interrupted);
            }
            Err(error) => return Err(error),
        }
        if has_large_files {
            for repository in clone_repositories(&self.git, None, &made.path).await? {
                self.git
                    .run(
                        None,
                        follow_call(&repository, &["lfs", "install", "--local"]),
                    )
                    .await?;
            }
        }
        let is_missing_large_files =
            !has_large_files && keeps_large_files(&self.git, None, &made.path).await?;
        let placed = move_staged_clone_into_place(&made, &clone.destination)
            .await?
            .ok_or(CloneRunError::DestinationFilled)?;
        *staged = Some(StagedFolder::Made(placed));
        // The last step that can fail: once attached, the folder is the project's and stays.
        self.projects
            .attach_cloned_project(clone.project_id, &clone.destination)
            .await?;
        Ok(is_missing_large_files)
    }

    // Tells the sessions that waited on the clone that it attached. The attached clone stays
    // either way; a listener that fails or is not registered is the card's failure.
    async fn tell_clone_attached(
        &self,
        project_id: ProjectId,
        is_missing_large_files: bool,
    ) -> ProjectCloneStatus {
        let told = match self.clone_attached.require_port() {
            Ok(listener) => listener.clone_attached(project_id).await,
            Err(error) => Err(error.into()),
        };
        if let Err(error) = told {
            warn!(
                project_id = %project_id,
                error = error.as_ref() as &(dyn Error + 'static),
                "the sessions that waited on a clone could not be finished"
            );
            return ProjectCloneStatus::Failed {
                project_id,
                step: ProjectCloneFailedStep::Sessions,
                failure_line: clone_line(&describe_error(error.as_ref())),
            };
        }
        if is_missing_large_files {
            ProjectCloneStatus::LargeFilesMissing { project_id }
        } else {
            ProjectCloneStatus::Done { project_id }
        }
    }

    // `git lfs install --local`, then `git lfs pull`, in each of the project's repositories.
    async fn pull_large_files(
        &self,
        project_id: ProjectId,
        root: &Path,
        place: Option<&Place>,
        cancel: &CancellationToken,
    ) -> Result<(), CloneRunError> {
        for repository in clone_repositories(&self.git, place, root).await? {
            self.git
                .run(
                    place,
                    follow_call(&repository, &["lfs", "install", "--local"]),
                )
                .await?;
            let ran = self
                .run_git_followed(
                    project_id,
                    place,
                    follow_call(&repository, &["lfs", "pull"]),
                    cancel,
                )
                .await;
            if cancel.is_cancelled() {
                return Err(CloneRunError::Canceled);
            }
            ran?;
        }
        Ok(())
    }

    // Runs `call` streamed with its progress and questions on the project's card; fails with
    // git's own failure line when git exits with a failure.
    async fn run_git_followed(
        &self,
        project_id: ProjectId,
        place: Option<&Place>,
        call: GitCall,
        cancel: &CancellationToken,
    ) -> Result<(), CloneRunError> {
        let owner = {
            let askpass = lock(&self.askpass);
            let Some(broker) = askpass.as_ref() else {
                return Err(CloneRunError::ServiceStopping);
            };
            let cards = Arc::clone(&self.cards);
            broker.register(move |question| {
                let cards = Arc::clone(&cards);
                async move { cards.ask(project_id, question).await }
            })?
        };
        let call = owner
            .environment()
            .into_iter()
            .fold(call, |call, (name, value)| {
                call.with_environment(name, value)
            });
        let mut reader = GitProgressReader::new(|progress| {
            self.cards.set_progress(project_id, progress);
        });
        let exit = run_streamed_git(&self.git, place, call, cancel, &self.shutdown, |chunk| {
            reader.read(chunk)
        })
        .await;
        // Released once git has ended, which refuses any question still open.
        drop(owner);
        let exit = exit?;
        if exit.has_succeeded {
            return Ok(());
        }
        let line = reader
            .failure_line()
            .or_else(|| clone_line(&describe_exit(&exit.exit)))
            .expect("an exit's description has words");
        Err(CloneRunError::GitFailed(line))
    }
}

// The failure line of a clone whose staged folder could not be removed.
fn removal_failure_line(error: &StagedCloneError) -> String {
    clone_line(&format!(
        "What the clone left could not be removed: {}",
        describe_error(error)
    ))
    .expect("the line has words")
    .into_string()
}

// A git call of a clone or pull run in `repository`, its progress written at once.
fn follow_call(repository: &Path, arguments: &[&str]) -> GitCall {
    progress_at_once(GitCall::write(in_folder(repository, arguments)))
}

// `call` with git's progress written from its start rather than after git's default delay.
fn progress_at_once(call: GitCall) -> GitCall {
    call.with_environment(PROGRESS_DELAY_VARIABLE, "0")
}

// `line` with the address as typed replaced by the address without its credentials.
fn without_typed_address(line: CloneLine, url: &str) -> CloneLine {
    let kept = address_without_credentials(url);
    if kept == url || !line.as_str().contains(url) {
        return line;
    }
    clone_line(&line.as_str().replace(url, &kept)).unwrap_or(line)
}

// How git ended when it wrote no line: its signal, else its exit code.
fn describe_exit(exit: &ChildExit) -> String {
    match &exit.signal_name {
        Some(signal) => format!("git was ended by {signal}"),
        None => format!("git exited with code {}", exit.exit_code),
    }
}

// The card a clone's recorded end reads as.
fn status_of_end(project_id: ProjectId, end: &CloneEnd) -> ProjectCloneStatus {
    match end {
        CloneEnd::Failed { line } => {
            status_of_outcome(project_id, CloneOutcome::Failed, Some(line))
        }
        CloneEnd::Canceled => status_of_outcome(project_id, CloneOutcome::Canceled, None),
        CloneEnd::Interrupted => status_of_outcome(project_id, CloneOutcome::Interrupted, None),
    }
}

//! The setup card of a new tree: the tree made, the project's own setup steps run in it, then the
//! warm step. The project's steps are the person's own list, files copied from the repository's
//! checkout and command lines run in order through the person's shell, each given up on after the
//! project's time limit; they run with the repository's own git config and raise no approval. The
//! warm step is one `git status` in the new tree, which refreshes its index and starts git's own
//! file watch where the repository turns it on, then the tree's watches held until the run ends,
//! by when a live session holds its own.
//!
//! - The card is kept for each tree until the tree is removed, so a client that leaves the session
//!   and comes back reads it as it stood; a failed step stands until a retry runs it and the steps
//!   after it, the project's steps read again and those that already succeeded kept.
//! - A running command is kept on its card, so a removal ends it before its tree moves and the
//!   daemon's stop ends every one; a card dropped once its tree is retired ends its command too,
//!   and a dropped card runs no further step. No step starts in a tree while its removal is under
//!   way, and a retry there is refused as one of a retired tree.

mod closing_folders;
mod steps;

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, join_all};
use notify::{RecommendedWatcher, Watcher};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectSetup;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_contracts::worktree::setup::{
    WorktreeSetupStage, WorktreeSetupState, WorktreeSetupStatus, WorktreeSetupStepState,
};
use sidekicks_platforms::{Spawner, command_shell};
use sidekicks_std::elapsed::elapsed_ms_since;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;

use self::closing_folders::tree_key_of;
pub use self::steps::SetupCommandEndError;
use self::steps::{
    CardStep, RunningCommand, SetupCommand, StepAction, StepOutcome, copy_setup_file,
    keep_succeeded_steps, output_text, project_steps_of, run_command, step_error,
};
use crate::git::process::{GitCall, GitRunner, SHUTDOWN_STOP_GRACE, in_folder};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::path_holds::PathHolds;
use crate::git::worktree::watch::{WatchHold, WatchTarget, WorkingFolderWatcher};

/// How long a command ended because its tree is being removed has after it is asked to stop
/// before every process it started is ended: the grace terminal programs give a process they close.
const REMOVAL_END_GRACE: Duration = Duration::from_secs(5);

/// What a command's step says when its tree was removed while it ran.
const REMOVED_END_REASON: &str = "Ended because its worktree was removed";

/// What a step says when the daemon stopped before or while it ran.
const STOPPED_END_REASON: &str = "Ended because the background service stopped";

/// What a command's step says when the shell its line runs through cannot be read.
const SHELL_UNREAD_REASON: &str = "The account's login shell could not be read";

/// Where a new tree is and the repository it was made from.
#[derive(Clone, Debug)]
pub(crate) struct MadeWorktree {
    /// The tree.
    pub(crate) worktree_id: WorktreeId,
    /// Its folder.
    pub(crate) tree_path: PathBuf,
    /// The repository's own checkout, which the files to copy are read from.
    pub(crate) repository_root: PathBuf,
    /// The mount the tree belongs to.
    pub(crate) repo_mount_id: RepoMountId,
    /// Where the repository is, for its git calls; absent on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// What the tree's checkout hook printed when it failed, shown on the make-tree step; `None`
    /// when it passed.
    pub(crate) hook_output: Option<String>,
}

/// Why a setup call failed.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeSetupError {
    /// The tree is unknown, or has no card where one is needed (`worktree.notFound`).
    #[error(transparent)]
    Refused(#[from] WorktreeRefusal),
    /// A retry of a card whose tree was never made, which a new preparation does instead.
    #[error("The tree was never made, so its setup cannot be retried; prepare it again")]
    TreeNeverMade,
    /// The worktree's rows or its project's setup could not be read.
    #[error("the setup's records could not be read")]
    Read(#[source] Box<dyn Error + Send + Sync>),
    /// The folder whose commands were to be ended could not be resolved.
    #[error("the folder whose setup commands were to be ended could not be resolved")]
    Folder(#[source] io::Error),
    /// Commands that were to be ended could not be.
    #[error(transparent)]
    CommandsNotEnded(SettleFailures<SetupCommandEndError>),
    /// The run of the steps ended without finishing, the runtime stopping under it.
    #[error("the setup's run ended before it finished")]
    RunEnded(#[source] JoinError),
}

/// Where the setup reads what other owners keep: the worktree's rows, its project's setup steps
/// and the environment its commands start with.
pub trait WorktreeSetupSources: Send + Sync {
    /// Answers once `worktree_id` names a worktree. Fails with `Refused` holding
    /// `WorktreeRefusal::NotFound` for one with no row, else with `Read`.
    fn require_worktree<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<(), WorktreeSetupError>>;

    /// Which of `worktree_ids` have their retirement recorded. Fails with `Read`.
    fn read_retired<'a>(
        &'a self,
        worktree_ids: &'a [WorktreeId],
    ) -> BoxFuture<'a, Result<HashSet<WorktreeId>, WorktreeSetupError>>;

    /// The setup steps of the project `worktree_id` belongs to, as the projects page stores them.
    /// Fails with `Read`.
    fn read_project_setup<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<ProjectSetup, WorktreeSetupError>>;

    /// The whole environment a command in `worktree_id`'s tree starts with, its project's own rows
    /// included. Fails with `Read`.
    fn read_command_environment<'a>(
        &'a self,
        worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, WorktreeSetupError>>;
}

/// What the setup runner reads, runs and holds; `W` is the system's file watch.
pub struct WorktreeSetupRunnerDeps<W = RecommendedWatcher> {
    /// The daemon's git, running the warm step with the repository's own config.
    pub git: GitRunner,
    /// The thread every command is started from.
    pub spawner: Spawner,
    /// The working-folder watch the warm step holds the tree on.
    pub watcher: Arc<WorkingFolderWatcher<W>>,
    /// The worktree's rows, its project's steps and its commands' environment.
    pub sources: Arc<dyn WorktreeSetupSources>,
}

/// Called with a tree's whole card each time it changes.
pub(crate) type WorktreeSetupListener = Arc<dyn Fn(WorktreeSetupStatus) + Send + Sync>;

/// The setup card of every tree being set up since the daemon started, its runs and its retries.
pub struct WorktreeSetupRunner<W = RecommendedWatcher> {
    shared: Arc<RunnerShared<W>>,
}

/// Sends each change of one tree's card to its listener until it drops.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the setup card's subscribe handler")
)]
pub(crate) struct WorktreeSetupSubscription {
    // `None` for a tree with no card, which nothing changes.
    attached: Option<AttachedListener>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the setup card's subscribe handler")
)]
struct AttachedListener {
    state: Weak<Mutex<RunnerState>>,
    worktree_id: WorktreeId,
    card_id: u64,
    listener_id: u64,
}

struct RunnerShared<W> {
    deps: WorktreeSetupRunnerDeps<W>,
    state: Arc<Mutex<RunnerState>>,
    // The shell every command line runs through, read at the first command that reads it.
    command_shell: OnceLock<PathBuf>,
}

#[derive(Default)]
struct RunnerState {
    cards: HashMap<WorktreeId, Card>,
    // The commands of dropped cards still being ended, so the stop reaches them too.
    ending: HashMap<u64, Arc<RunningCommand>>,
    // The folders being moved or deleted, in which no step starts, each held under this state's
    // lock so a mark and the commands read with it agree.
    closing_folders: Arc<PathHolds>,
    next_id: u64,
    is_stopped: bool,
}

// What a retry runs: the failed warm step, at its index, alone, or the project's steps read again
// first, as that read answered once it ran.
enum RetryStart<Read> {
    Warm { failed: usize },
    ReadAgain(Read),
}

// One tree's card. Its id tells it from a later card of the same tree, so a run of a dropped card
// changes nothing.
struct Card {
    id: u64,
    made: Option<MadeWorktree>,
    state: WorktreeSetupState,
    steps: Vec<CardStep>,
    // The project steps that succeeded before a re-read failed, kept off the card until the next
    // read that succeeds matches them, so a retry never runs them again.
    succeeded_unshown: Vec<CardStep>,
    began_at: Instant,
    listeners: HashMap<u64, WorktreeSetupListener>,
    is_running: bool,
    running_command: Option<Arc<RunningCommand>>,
    // The step running now, which closes once it ends, so a folder close waits for a copy or a
    // warm step already in flight.
    step_in_flight: Option<tokio::sync::watch::Receiver<()>>,
    watch_hold: Option<WatchHold>,
}

impl Card {
    fn status(&self, worktree_id: WorktreeId) -> WorktreeSetupStatus {
        WorktreeSetupStatus {
            worktree_id,
            state: self.state,
            steps: self.steps.iter().map(|entry| entry.step.clone()).collect(),
        }
    }

    fn emit(&self, worktree_id: WorktreeId) {
        let status = self.status(worktree_id);
        for listener in self.listeners.values() {
            listener(status.clone());
        }
    }
}

impl RunnerState {
    // Whether the tree whose key is `tree_key` lies in a folder being moved or deleted; `false`
    // for a card whose tree was never made.
    fn is_closing(&self, tree_key: Option<&Path>) -> bool {
        tree_key.is_some_and(|tree_key| self.closing_folders.is_held_within(tree_key))
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    // The tree's card while it is still the card `card_id`.
    fn held_card(&mut self, worktree_id: &WorktreeId, card_id: u64) -> Option<&mut Card> {
        self.cards
            .get_mut(worktree_id)
            .filter(|card| card.id == card_id)
    }

    fn require_card(&mut self, worktree_id: &WorktreeId) -> Result<&mut Card, WorktreeSetupError> {
        self.cards
            .get_mut(worktree_id)
            .ok_or_else(|| not_found(*worktree_id))
    }
}

impl<W: Watcher + Send + 'static> WorktreeSetupRunner<W> {
    /// A runner with no card.
    pub fn new(deps: WorktreeSetupRunnerDeps<W>) -> Self {
        Self {
            shared: Arc::new(RunnerShared {
                deps,
                state: Arc::new(Mutex::new(RunnerState::default())),
                command_shell: OnceLock::new(),
            }),
        }
    }

    /// Opens the card of a tree about to be made, its first step running; a card the tree had is
    /// replaced.
    pub(crate) fn begin(&self, worktree_id: WorktreeId) {
        let mut state = self.shared.lock();
        let id = state.next_id();
        state.cards.insert(
            worktree_id,
            Card {
                id,
                made: None,
                state: WorktreeSetupState::Running,
                steps: vec![CardStep::make_tree()],
                succeeded_unshown: Vec::new(),
                began_at: Instant::now(),
                listeners: HashMap::new(),
                is_running: false,
                running_command: None,
                step_in_flight: None,
                watch_hold: None,
            },
        );
    }

    /// Marks the tree's making failed with git's `error`; the card stands failed. Fails with
    /// `worktree.notFound` when no card was begun for the tree.
    pub(crate) fn tree_failed(
        &self,
        worktree_id: WorktreeId,
        error: &str,
    ) -> Result<(), WorktreeSetupError> {
        let mut state = self.shared.lock();
        let card = state.require_card(&worktree_id)?;
        let elapsed_ms = elapsed_ms_since(card.began_at);
        if let Some(make_tree) = card.steps.first_mut() {
            make_tree.step.state = WorktreeSetupStepState::Failed;
            make_tree.step.elapsed_ms = Some(elapsed_ms);
            make_tree.step.error = Some(step_error(error));
        }
        card.state = WorktreeSetupState::Failed;
        card.emit(worktree_id);
        Ok(())
    }

    /// Marks the tree made and runs the project's steps and the warm step; answers the card as it
    /// ends, succeeded or stopped at its failed step, a failed read of the project's steps among
    /// them, which a retry reads again. Fails with `worktree.notFound` when no card was begun for
    /// the tree.
    pub(crate) async fn tree_made(
        &self,
        made: MadeWorktree,
    ) -> Result<WorktreeSetupStatus, WorktreeSetupError> {
        let worktree_id = made.worktree_id;
        let card_id = {
            let mut state = self.shared.lock();
            let card = state.require_card(&worktree_id)?;
            let elapsed_ms = elapsed_ms_since(card.began_at);
            if let Some(make_tree) = card.steps.first_mut() {
                make_tree.step.state = WorktreeSetupStepState::Succeeded;
                make_tree.step.elapsed_ms = Some(elapsed_ms);
                make_tree.step.output = made.hook_output.as_deref().map(output_text);
            }
            card.made = Some(made.clone());
            card.emit(worktree_id);
            card.id
        };
        let project_steps = self.read_project_steps(&worktree_id).await;
        let run = {
            let mut state = self.shared.lock();
            let Some(card) = state.held_card(&worktree_id, card_id) else {
                return Err(not_found(worktree_id));
            };
            match project_steps {
                Ok(project_steps) => {
                    card.steps.extend(project_steps);
                    card.steps.push(CardStep::warm());
                }
                Err(error) => {
                    card.steps
                        .push(CardStep::project_steps_unread(&describe_error(&error)));
                    card.state = WorktreeSetupState::Failed;
                    card.emit(worktree_id);
                    return Ok(card.status(worktree_id));
                }
            }
            self.shared.start_run(&mut state, worktree_id, made, 1)
        };
        run.await.map_err(WorktreeSetupError::RunEnded)
    }

    /// Calls `on_change` with the tree's card now and on each change until the subscription drops.
    /// A tree with no card, whose setup did not run since the daemon started, is called back once
    /// with `notRun` and no steps. Fails with `worktree.notFound` for a tree with no row, and with
    /// `Read` when its row cannot be read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the setup card's subscribe handler")
    )]
    pub(crate) async fn subscribe(
        &self,
        worktree_id: WorktreeId,
        on_change: WorktreeSetupListener,
    ) -> Result<WorktreeSetupSubscription, WorktreeSetupError> {
        {
            let mut state = self.shared.lock();
            let listener_id = state.next_id();
            if let Some(card) = state.cards.get_mut(&worktree_id) {
                on_change(card.status(worktree_id));
                card.listeners.insert(listener_id, on_change);
                return Ok(WorktreeSetupSubscription {
                    attached: Some(AttachedListener {
                        state: Arc::downgrade(&self.shared.state),
                        worktree_id,
                        card_id: card.id,
                        listener_id,
                    }),
                });
            }
        }
        self.shared
            .deps
            .sources
            .require_worktree(&worktree_id)
            .await?;
        on_change(WorktreeSetupStatus {
            worktree_id,
            state: WorktreeSetupState::NotRun,
            steps: Vec::new(),
        });
        Ok(WorktreeSetupSubscription { attached: None })
    }

    /// Runs the failed step again with the project's steps as now saved, then the steps after it,
    /// and answers the card as it ends. The steps are matched by what they do, not their place, so
    /// an edited list resumes at its first step that has not succeeded; a failed warm step runs
    /// again alone. A card that is running or did not fail is answered as it stands, and one whose
    /// project's steps cannot be read again is answered failed at its read, its succeeded steps
    /// kept for the next read that succeeds. Fails with
    /// `worktree.notFound` when the tree has no card, and `TreeNeverMade` when its tree was never
    /// made.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the setup card's retry handler")
    )]
    pub(crate) async fn retry(
        &self,
        worktree_id: WorktreeId,
    ) -> Result<WorktreeSetupStatus, WorktreeSetupError> {
        let tree_path = self
            .shared
            .lock()
            .require_card(&worktree_id)?
            .made
            .as_ref()
            .map(|made| made.tree_path.clone());
        let tree_key = match tree_path {
            Some(tree_path) => Some(tree_key_of(&tree_path).await),
            None => None,
        };
        let (retry, card_id, made) = {
            let mut state = self.shared.lock();
            let card = state.require_card(&worktree_id)?;
            let failed = card
                .steps
                .iter()
                .position(|entry| entry.step.state == WorktreeSetupStepState::Failed);
            let (Some(failed), false, WorktreeSetupState::Failed) =
                (failed, card.is_running, card.state)
            else {
                return Ok(card.status(worktree_id));
            };
            let Some(made) = card.made.clone() else {
                return Err(WorktreeSetupError::TreeNeverMade);
            };
            let retry = match card.steps[failed].action {
                StepAction::MakeTree => return Err(WorktreeSetupError::TreeNeverMade),
                // The project's steps all succeeded, so they are not read again.
                StepAction::Warm => RetryStart::Warm { failed },
                StepAction::ReadProjectSteps
                | StepAction::Copy { .. }
                | StepAction::Command { .. } => RetryStart::ReadAgain(()),
            };
            (retry, card.id, made)
        };
        // The person may have fixed the step since, so the project's steps are read again.
        let retry = match retry {
            RetryStart::Warm { failed } => RetryStart::Warm { failed },
            RetryStart::ReadAgain(()) => {
                RetryStart::ReadAgain(self.read_project_steps(&worktree_id).await)
            }
        };
        let run = 'run: {
            let mut state = self.shared.lock();
            let is_closing = state.is_closing(tree_key.as_deref());
            let Some(card) = state.held_card(&worktree_id, card_id) else {
                return Err(not_found(worktree_id));
            };
            // A tree whose removal is under way is as good as retired; every retry's run starts
            // only past this check.
            if is_closing {
                return Err(not_found(worktree_id));
            }
            if card.is_running || card.state != WorktreeSetupState::Failed {
                return Ok(card.status(worktree_id));
            }
            let read_again = match retry {
                RetryStart::Warm { failed } => {
                    break 'run self.shared.start_run(&mut state, worktree_id, made, failed);
                }
                RetryStart::ReadAgain(Ok(read_again)) => read_again,
                RetryStart::ReadAgain(Err(error)) => {
                    // The card stands failed at its read, as when the first read fails; the steps
                    // that succeeded wait off the card for the next read.
                    let succeeded = card.steps.drain(1..).filter(|entry| {
                        entry.step.stage == WorktreeSetupStage::ProjectSteps
                            && entry.step.state == WorktreeSetupStepState::Succeeded
                    });
                    card.succeeded_unshown.extend(succeeded);
                    card.steps
                        .push(CardStep::project_steps_unread(&describe_error(&error)));
                    card.emit(worktree_id);
                    return Ok(card.status(worktree_id));
                }
            };
            let current: Vec<CardStep> = card
                .succeeded_unshown
                .drain(..)
                .chain(card.steps.iter().cloned())
                .collect();
            let (kept, kept_count) = keep_succeeded_steps(&current, read_again);
            let make_tree = card.steps[0].clone();
            card.steps = std::iter::once(make_tree)
                .chain(kept)
                .chain(std::iter::once(CardStep::warm()))
                .collect();
            self.shared
                .start_run(&mut state, worktree_id, made, 1 + kept_count)
        };
        run.await.map_err(WorktreeSetupError::RunEnded)
    }

    /// Ends every running setup command, each asked to stop and ended within the stop's grace or
    /// `bound`, what is left of the daemon's stop, whichever is shorter, and starts no step after;
    /// run when the daemon stops. Fails with `CommandsNotEnded` naming each command that could not
    /// be ended.
    pub async fn stop(&self, bound: Duration) -> Result<(), WorktreeSetupError> {
        let running: Vec<Arc<RunningCommand>> = {
            let mut state = self.shared.lock();
            state.is_stopped = true;
            state
                .cards
                .values()
                .filter_map(|card| card.running_command.clone())
                .chain(state.ending.values().cloned())
                .collect()
        };
        end_all(&running, STOPPED_END_REASON, SHUTDOWN_STOP_GRACE.min(bound)).await
    }

    /// Drops the tree's card, lets go of the watches its warm step holds and ends its running
    /// command with the removal's grace; run when the tree is removed or was never recorded. A
    /// command that cannot be ended is logged.
    pub(crate) fn forget(&self, worktree_id: &WorktreeId) {
        let mut state = self.shared.lock();
        let Some(card) = state.cards.remove(worktree_id) else {
            return;
        };
        let Some(running) = card.running_command.clone() else {
            return;
        };
        let ending_id = state.next_id();
        state.ending.insert(ending_id, Arc::clone(&running));
        drop(state);
        drop(card);
        let state = Arc::clone(&self.shared.state);
        tokio::spawn(async move {
            if let Err(error) = running.end(REMOVED_END_REASON, REMOVAL_END_GRACE).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "A removed worktree's setup command could not be ended"
                );
            }
            lock(&state).ending.remove(&ending_id);
        });
    }

    /// Forgets the card of every tree whose retirement is recorded; every path that retires a tree
    /// calls it once the retirement is written. A failed read of the rows is logged.
    pub(crate) async fn forget_retired(&self) {
        let worktree_ids: Vec<WorktreeId> = self.shared.lock().cards.keys().copied().collect();
        if worktree_ids.is_empty() {
            return;
        }
        match self.shared.deps.sources.read_retired(&worktree_ids).await {
            Ok(retired) => {
                for worktree_id in &retired {
                    self.forget(worktree_id);
                }
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "The setup cards of retired worktrees could not be dropped"
            ),
        }
    }

    async fn read_project_steps(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<Vec<CardStep>, WorktreeSetupError> {
        let setup = self
            .shared
            .deps
            .sources
            .read_project_setup(worktree_id)
            .await?;
        project_steps_of(&setup).map_err(|error| WorktreeSetupError::Read(Box::new(error)))
    }
}

impl<W: Watcher + Send + 'static> RunnerShared<W> {
    // The shell a command line runs through, read once it is first needed and kept; a read that
    // fails is tried again at the next command.
    fn command_shell(&self) -> io::Result<&Path> {
        if let Some(shell) = self.command_shell.get() {
            return Ok(shell);
        }
        let shell = command_shell()?;
        Ok(self.command_shell.get_or_init(|| shell))
    }

    fn lock(&self) -> MutexGuard<'_, RunnerState> {
        lock(&self.state)
    }

    // Starts running the card's steps from `first_index`, each later step pending; the run ends
    // with the card succeeded or failed at a step, and lets go of the tree's watches.
    fn start_run(
        self: &Arc<Self>,
        state: &mut RunnerState,
        worktree_id: WorktreeId,
        made: MadeWorktree,
        first_index: usize,
    ) -> JoinHandle<WorktreeSetupStatus> {
        let card = state
            .cards
            .get_mut(&worktree_id)
            .expect("a run starts on a card the caller holds");
        card.is_running = true;
        card.state = WorktreeSetupState::Running;
        for entry in card.steps.iter_mut().skip(first_index) {
            *entry = entry.clone().into_pending();
        }
        card.emit(worktree_id);
        let card_id = card.id;
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            let status = shared
                .run_steps(worktree_id, card_id, &made, first_index)
                .await;
            let watch_hold = shared
                .lock()
                .held_card(&worktree_id, card_id)
                .and_then(|card| {
                    card.is_running = false;
                    card.watch_hold.take()
                });
            drop(watch_hold);
            status
        })
    }

    async fn run_steps(
        &self,
        worktree_id: WorktreeId,
        card_id: u64,
        made: &MadeWorktree,
        first_index: usize,
    ) -> WorktreeSetupStatus {
        let tree_key = tree_key_of(&made.tree_path).await;
        let mut index = first_index;
        loop {
            let (action, step_done) = {
                let mut state = self.lock();
                let is_stopped = state.is_stopped;
                let is_closing = state.closing_folders.is_held_within(&tree_key);
                let Some(card) = state.held_card(&worktree_id, card_id) else {
                    // A dropped card runs no further step, so nothing starts in a tree being
                    // removed.
                    return dropped_status(worktree_id);
                };
                let Some(entry) = card.steps.get_mut(index) else {
                    card.state = WorktreeSetupState::Succeeded;
                    card.emit(worktree_id);
                    return card.status(worktree_id);
                };
                entry.step.state = WorktreeSetupStepState::Running;
                let action = entry.action.clone();
                card.emit(worktree_id);
                if is_stopped {
                    (Err(STOPPED_END_REASON), None)
                } else if is_closing {
                    (Err(REMOVED_END_REASON), None)
                } else {
                    // Kept on the card under the lock the closing mark is read under, so a close
                    // either is seen here or sees the step.
                    let (step_done, step_running) = tokio::sync::watch::channel(());
                    card.step_in_flight = Some(step_running);
                    (Ok(action), Some(step_done))
                }
            };
            let started_at = Instant::now();
            let outcome = match action {
                Ok(action) => {
                    self.run_step(worktree_id, card_id, made, &tree_key, action)
                        .await
                }
                Err(reason) => StepOutcome::failed(reason),
            };
            drop(step_done);
            let mut state = self.lock();
            let Some(card) = state.held_card(&worktree_id, card_id) else {
                return dropped_status(worktree_id);
            };
            card.step_in_flight = None;
            let entry = &mut card.steps[index];
            entry.step.elapsed_ms = Some(elapsed_ms_since(started_at));
            if let Some(error) = outcome.error {
                entry.step.state = WorktreeSetupStepState::Failed;
                entry.step.error = Some(step_error(&error));
                entry.step.output = outcome.output;
                card.state = WorktreeSetupState::Failed;
                card.emit(worktree_id);
                return card.status(worktree_id);
            }
            entry.step.state = WorktreeSetupStepState::Succeeded;
            card.emit(worktree_id);
            index += 1;
        }
    }

    async fn run_step(
        &self,
        worktree_id: WorktreeId,
        card_id: u64,
        made: &MadeWorktree,
        tree_key: &Path,
        action: StepAction,
    ) -> StepOutcome {
        match action {
            // The creation made the tree before the card's later steps run, and a retry puts the
            // steps it reads in place of a failed read, so neither runs here.
            StepAction::MakeTree | StepAction::ReadProjectSteps => StepOutcome::succeeded(),
            StepAction::Copy { path } => {
                copy_setup_file(&made.repository_root, &made.tree_path, &path).await
            }
            StepAction::Command { line, time_limit } => {
                self.run_command_step(
                    worktree_id,
                    card_id,
                    made,
                    line.as_str(),
                    time_limit,
                    tree_key,
                )
                .await
            }
            StepAction::Warm => self.warm(worktree_id, card_id, made).await,
        }
    }

    async fn run_command_step(
        &self,
        worktree_id: WorktreeId,
        card_id: u64,
        made: &MadeWorktree,
        line: &str,
        time_limit: Option<Duration>,
        tree_key: &Path,
    ) -> StepOutcome {
        let environment = match self
            .deps
            .sources
            .read_command_environment(&worktree_id)
            .await
        {
            Ok(environment) => environment,
            Err(error) => return StepOutcome::failed(describe_error(&error)),
        };
        let shell = match self.command_shell() {
            Ok(shell) => shell,
            Err(error) => return StepOutcome::failed(format!("{SHELL_UNREAD_REASON}: {error}")),
        };
        // Kept on the card before it starts, so the stop and a removal reach it from its start.
        let running = {
            let mut state = self.lock();
            if state.is_stopped {
                return StepOutcome::failed(STOPPED_END_REASON);
            }
            if state.closing_folders.is_held_within(tree_key) {
                return StepOutcome::failed(REMOVED_END_REASON);
            }
            let Some(card) = state.held_card(&worktree_id, card_id) else {
                return StepOutcome::failed(REMOVED_END_REASON);
            };
            Arc::clone(card.running_command.insert(Arc::new(RunningCommand::new())))
        };
        let outcome = run_command(
            SetupCommand {
                spawner: &self.deps.spawner,
                shell,
                line,
                tree: &made.tree_path,
                environment,
                time_limit,
            },
            &running,
        )
        .await;
        if let Some(card) = self.lock().held_card(&worktree_id, card_id)
            && card
                .running_command
                .as_ref()
                .is_some_and(|held| Arc::ptr_eq(held, &running))
        {
            card.running_command = None;
        }
        outcome
    }

    // One `git status` in the tree, then the tree's watches held until the run ends; a card
    // dropped meanwhile lets go of them at once.
    async fn warm(
        &self,
        worktree_id: WorktreeId,
        card_id: u64,
        made: &MadeWorktree,
    ) -> StepOutcome {
        let status = GitCall::write(in_folder(&made.tree_path, &["status", "--porcelain"]));
        if let Err(error) = self.deps.git.run(made.place.as_ref(), status).await {
            return StepOutcome::failed(describe_error(&error));
        }
        let is_held = self
            .lock()
            .held_card(&worktree_id, card_id)
            .is_some_and(|card| card.watch_hold.is_none());
        if !is_held {
            return StepOutcome::succeeded();
        }
        let target = WatchTarget {
            folder: made.tree_path.clone(),
            repo_mount_id: made.repo_mount_id,
            place: made.place.clone(),
        };
        let hold = match self.deps.watcher.hold(&target).await {
            Ok(hold) => hold,
            Err(error) => return StepOutcome::failed(describe_error(&error)),
        };
        let unheld = match self.lock().held_card(&worktree_id, card_id) {
            Some(card) => card.watch_hold.replace(hold),
            None => Some(hold),
        };
        drop(unheld);
        StepOutcome::succeeded()
    }
}

impl Drop for WorktreeSetupSubscription {
    fn drop(&mut self) {
        let Some(attached) = &self.attached else {
            return;
        };
        let Some(state) = attached.state.upgrade() else {
            return;
        };
        if let Some(card) = lock(&state).held_card(&attached.worktree_id, attached.card_id) {
            card.listeners.remove(&attached.listener_id);
        }
    }
}

fn not_found(worktree_id: WorktreeId) -> WorktreeSetupError {
    WorktreeSetupError::Refused(WorktreeRefusal::NotFound { worktree_id })
}

// What a run of a dropped card answers: the tree has no card to show.
fn dropped_status(worktree_id: WorktreeId) -> WorktreeSetupStatus {
    WorktreeSetupStatus {
        worktree_id,
        state: WorktreeSetupState::NotRun,
        steps: Vec::new(),
    }
}

// Ends each of `commands` with `reason` and `grace` at once; fails naming each that could not be.
async fn end_all(
    commands: &[Arc<RunningCommand>],
    reason: &'static str,
    grace: Duration,
) -> Result<(), WorktreeSetupError> {
    let ended = join_all(commands.iter().map(|command| command.end(reason, grace))).await;
    settle_all(ended, "ending the setup commands")
        .map(|_| ())
        .map_err(WorktreeSetupError::CommandsNotEnded)
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_runner;
#[cfg(test)]
mod tests;

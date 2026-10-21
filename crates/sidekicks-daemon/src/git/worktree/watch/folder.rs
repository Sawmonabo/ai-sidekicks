//! One watched folder's task: it starts the folder's watches, picks the tree's mode (a watch, or
//! the slow tick where the machine's watch limit has no room), reads every notice, tick and raise
//! one at a time, sends one change per burst, and writes a changed branch back.

use std::collections::HashSet;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::Watcher;
use sidekicks_contracts::repo::git_reads::{WorkingTreeChange, WorkingTreeChangeMode};
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::{Notify, watch};

use super::branch_write_back::BranchWriteBack;
use super::ignored_paths::{
    IGNORE_FILE_NAME, IgnoredPaths, TreeCoverage, count_git_folder_watches, count_kept_folders,
    git_folder_filter, is_git_head, is_git_pointer, read_ignored_paths,
};
use super::slow_tick::{StatusEntry, read_status_digest};
use super::{FolderKey, FolderSignals, FolderStartError, StartOutcome, WatchTarget, WatcherShared};
use crate::daemon::scheduler::ScheduledJobHandle;
use crate::file_watch::{FileWatch, FileWatchError, FileWatchNotice};
use crate::git::process::{GitError, read_git_common_folder};
use crate::git::worktree::reads::read_tree_git_folder;
use crate::missing_entry::is_missing_entry;

/// Runs the folder `folder` of `target` until `signals.close` is canceled: starts its watches,
/// answers `started` once they run and the branch was first checked, then reads them.
pub(super) async fn run_folder<W: Watcher + Send + 'static>(
    shared: Arc<WatcherShared>,
    folder: FolderKey,
    target: WatchTarget,
    signals: Arc<FolderSignals>,
    started: watch::Sender<Option<StartOutcome>>,
) {
    let close = signals.close.clone();
    let mut watched = WatchedFolder::<W> {
        shared,
        folder,
        target,
        signals,
        coverage: None,
        tree_watch: None,
        git_watch: None,
        git_folders: Vec::new(),
        tick: None,
        mode: WorkingTreeChangeMode::Watch,
        branch: BranchWriteBack::default(),
        is_raise_pending: false,
        ignored_read: None,
        is_ignored_read_due: false,
    };
    let outcome = tokio::select! {
        biased;
        () = close.cancelled() => return,
        outcome = watched.start() => outcome,
    };
    let has_started = outcome.is_ok();
    started.send_replace(Some(outcome.map_err(Arc::new)));
    if has_started {
        tokio::select! {
            biased;
            () = close.cancelled() => {}
            () = watched.watch() => {}
        }
    }
    watched.stop_tick();
}

// A read of what git ignores, under way.
type IgnoredRead = BoxFuture<'static, Result<HashSet<Vec<u8>>, GitError>>;

// One folder's watches and what its task keeps.
struct WatchedFolder<W> {
    shared: Arc<WatcherShared>,
    folder: FolderKey,
    target: WatchTarget,
    signals: Arc<FolderSignals>,
    // What the tree's watch covers, set once the start read what git ignores.
    coverage: Option<(IgnoredPaths, TreeCoverage)>,
    tree_watch: Option<FileWatch<W>>,
    git_watch: Option<FileWatch<W>>,
    // The folders the git-folder watch covers: the tree's own git folder, then the repository's
    // common one where it is another folder.
    git_folders: Vec<PathBuf>,
    tick: Option<SlowTick>,
    mode: WorkingTreeChangeMode,
    branch: BranchWriteBack,
    // A change waits to be sent once no notice is ready.
    is_raise_pending: bool,
    // Reads of what git ignores run one at a time; one more is due when a change asked meanwhile.
    ignored_read: Option<IgnoredRead>,
    is_ignored_read_due: bool,
}

// The slow tick: the scheduler's job, which only wakes the task, and the last reading compared.
struct SlowTick {
    job: Option<ScheduledJobHandle>,
    due: Arc<Notify>,
    // `None` until the first tick, which sets it and raises nothing.
    last_digest: Option<Vec<StatusEntry>>,
}

// What woke the task.
enum FolderEvent {
    Tree(Option<FileWatchNotice>),
    GitFolder(Option<FileWatchNotice>),
    Raise,
    Tick,
    IgnoredRead(Result<HashSet<Vec<u8>>, GitError>),
    Flush,
}

// What the count of the tree's watches allowed.
enum WatchTake {
    Taken,
    OverCeiling,
    Closed,
}

impl<W: Watcher + Send + 'static> WatchedFolder<W> {
    // Reads the git folders and what git ignores, watches the git folders, then the tree or the
    // slow tick, then checks the branch once, since it may have changed while nothing watched.
    async fn start(&mut self) -> Result<(), FolderStartError> {
        let git = &self.shared.deps.git;
        let place = self.target.place.as_ref();
        let key = self.folder.key.clone();
        let git_folder = read_tree_git_folder(git, place, &key)
            .await
            .map_err(FolderStartError::GitFolder)?;
        let common_folder = read_git_common_folder(git, place, &key, None)
            .await
            .map_err(FolderStartError::GitFolder)?;
        // The tree's own git folder first, since a changed path is read against the first root
        // holding it and a linked tree's record sits inside the common folder.
        let mut git_folders = vec![git_folder];
        if !git_folders.contains(&common_folder) {
            git_folders.push(common_folder);
        }
        let ignored = IgnoredPaths::default();
        ignored.replace(
            read_ignored_paths(git, place, &key)
                .await
                .map_err(FolderStartError::IgnoredPaths)?,
        );
        let is_linked_tree = match tokio::fs::symlink_metadata(key.join(".git")).await {
            Ok(metadata) => metadata.is_file(),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's .git could not be read, so it is left out of the tree's \
                     watch"
                );
                false
            }
        };
        let (git_watch, git_feed) = FileWatch::<W>::start(git_folders.clone(), git_folder_filter())
            .await
            .map_err(FolderStartError::GitFolderWatch)?;
        self.git_folders = git_folders;
        #[cfg(test)]
        self.with_entry(|entry| entry.feeds.git_folder = Some(git_feed));
        #[cfg(not(test))]
        drop(git_feed);
        self.git_watch = Some(git_watch);
        self.coverage = Some((ignored.clone(), TreeCoverage::new(ignored, is_linked_tree)));
        self.start_tree_watch().await;
        self.branch
            .check(&self.shared, &self.folder.key, &self.target)
            .await;
        Ok(())
    }

    // Reads the watches, ticks and raises one at a time until the folder is closed; a change is
    // sent only once no notice is ready, so a burst reaches each subscriber once.
    async fn watch(&mut self) {
        loop {
            let event = tokio::select! {
                biased;
                notice = next_notice(&mut self.tree_watch) => FolderEvent::Tree(notice),
                notice = next_notice(&mut self.git_watch) => FolderEvent::GitFolder(notice),
                () = self.signals.raise.notified() => FolderEvent::Raise,
                () = tick_due(self.tick.as_ref()) => FolderEvent::Tick,
                read = ignored_read_done(&mut self.ignored_read) => FolderEvent::IgnoredRead(read),
                () = std::future::ready(()), if self.is_raise_pending => FolderEvent::Flush,
            };
            match event {
                FolderEvent::Tree(notice) => self.take_tree_notice(notice).await,
                FolderEvent::GitFolder(notice) => self.take_git_folder_notice(notice).await,
                FolderEvent::Raise => self.is_raise_pending = true,
                FolderEvent::Tick => self.take_tick().await,
                FolderEvent::IgnoredRead(read) => self.take_ignored_read(read).await,
                FolderEvent::Flush => self.send_change(),
            }
        }
    }

    async fn take_tree_notice(&mut self, notice: Option<FileWatchNotice>) {
        match notice {
            Some(FileWatchNotice::Changed(paths)) => self.take_tree_changes(paths).await,
            Some(FileWatchNotice::Incomplete) => {
                tracing::warn!(
                    "the machine's watch limit cut a working folder's watch short, so it is \
                     checked on a slow tick until it is next started"
                );
                self.fall_back_to_slow_tick();
                self.is_raise_pending = true;
            }
            Some(FileWatchNotice::Failed(error)) => {
                self.announce_repository_change();
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's watch failed, so it is checked on a slow tick"
                );
                self.fall_back_to_slow_tick();
            }
            None => self.tree_watch = None,
        }
    }

    // A linked tree's `.git` pointer says the repository may have moved; a `.gitignore` or a new
    // folder may change what git ignores; every other path is a change to the tree.
    async fn take_tree_changes(&mut self, paths: Vec<PathBuf>) {
        let Some(root) = self
            .tree_watch
            .as_ref()
            .and_then(|watch| watch.roots().first().cloned())
        else {
            return;
        };
        let mut is_ignore_read_due = false;
        let mut changed = Vec::with_capacity(paths.len());
        for path in paths {
            let Ok(relative_path) = path.strip_prefix(&root) else {
                continue;
            };
            if is_git_pointer(relative_path) {
                self.announce_repository_change();
                continue;
            }
            is_ignore_read_due |= relative_path.file_name() == Some(IGNORE_FILE_NAME.as_ref());
            changed.push(path);
        }
        if changed.is_empty() {
            return;
        }
        self.is_raise_pending = true;
        if !is_ignore_read_due {
            is_ignore_read_due = has_a_folder(changed).await;
        }
        if is_ignore_read_due {
            self.read_ignored_again();
        }
    }

    // A HEAD change checks the branch before the change goes out; an index or ref change is a
    // change.
    async fn take_git_folder_notice(&mut self, notice: Option<FileWatchNotice>) {
        match notice {
            Some(FileWatchNotice::Changed(paths)) => {
                if paths.iter().any(|path| is_git_head(path)) {
                    self.branch
                        .check(&self.shared, &self.folder.key, &self.target)
                        .await;
                }
                self.is_raise_pending |= !paths.is_empty();
            }
            Some(FileWatchNotice::Incomplete) => tracing::warn!(
                "the machine's watch limit refused a working folder's git folder watch; it is \
                 watched again once there is room"
            ),
            Some(FileWatchNotice::Failed(error)) => {
                self.announce_repository_change();
                if !matches!(error, FileWatchError::RootRemoved { .. }) {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a working folder's git folder stopped being watched, so a branch changed \
                         there is not written back until the folder is watched again"
                    );
                }
                self.git_watch = None;
            }
            None => self.git_watch = None,
        }
    }

    // A tick compares what git status lists, with each path's length and time, against the last;
    // the first sets the baseline only, and a failed read keeps it.
    async fn take_tick(&mut self) {
        let digest = read_status_digest(
            &self.shared.deps.git,
            self.target.place.as_ref(),
            &self.folder.key,
        )
        .await;
        let Some(tick) = self.tick.as_mut() else {
            return;
        };
        match digest {
            Ok(digest) => {
                let has_changed = tick
                    .last_digest
                    .as_ref()
                    .is_some_and(|last| *last != digest);
                tick.last_digest = Some(digest);
                self.is_raise_pending |= has_changed;
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a working folder on the slow tick could not be read; the next tick reads it again"
            ),
        }
    }

    // A changed set restarts a running tree watch, which on a machine that watches one folder at a
    // time arms only what its walk keeps, and raises once for what the restart may miss.
    async fn take_ignored_read(&mut self, read: Result<HashSet<Vec<u8>>, GitError>) {
        match read {
            Ok(paths) => {
                let is_changed = self
                    .coverage
                    .as_ref()
                    .is_some_and(|(ignored, _)| ignored.replace(paths));
                if is_changed && self.tree_watch.is_some() {
                    self.stop_tree_watch();
                    self.start_tree_watch().await;
                    self.is_raise_pending = true;
                }
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "what git ignores in a working folder could not be read again, so changes there \
                 still count"
            ),
        }
        if self.is_ignored_read_due {
            self.is_ignored_read_due = false;
            self.read_ignored_again();
        }
    }

    fn read_ignored_again(&mut self) {
        if self.ignored_read.is_some() {
            self.is_ignored_read_due = true;
            return;
        }
        let git = self.shared.deps.git.clone();
        let place = self.target.place.clone();
        let folder = self.folder.key.clone();
        self.ignored_read =
            Some(async move { read_ignored_paths(&git, place.as_ref(), &folder).await }.boxed());
    }

    // Watches the tree when its folders fit what is left of the machine's watch limit, else ticks.
    async fn start_tree_watch(&mut self) {
        let Some((_, coverage)) = self.coverage.clone() else {
            return;
        };
        let read_ceiling = self.shared.deps.read_watch_ceiling;
        let root = self.folder.key.clone();
        let counting = coverage.clone();
        let git_folders = self.git_folders.clone();
        let counted = tokio::task::spawn_blocking(move || {
            read_ceiling().map(|ceiling| {
                ceiling.map(|ceiling| {
                    (
                        ceiling,
                        count_kept_folders(&root, move |path| counting.keeps(path))
                            + count_git_folder_watches(&git_folders),
                    )
                })
            })
        })
        .await;
        let take = match counted {
            Ok(Ok(None)) => WatchTake::Taken,
            Ok(Ok(Some((ceiling, count)))) => self.take_watches(count, ceiling),
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the machine's watch limit could not be read, so a working folder is checked \
                     on a slow tick"
                );
                WatchTake::OverCeiling
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's watches could not be counted, so it is checked on a slow \
                     tick"
                );
                WatchTake::OverCeiling
            }
        };
        match take {
            WatchTake::Taken => {}
            WatchTake::OverCeiling => {
                self.start_slow_tick();
                return;
            }
            WatchTake::Closed => return,
        }
        match FileWatch::<W>::start(vec![self.folder.key.clone()], coverage.filter()).await {
            Ok((tree_watch, tree_feed)) => {
                #[cfg(test)]
                {
                    self.with_entry(|entry| entry.feeds.tree = Some(tree_feed));
                    self.shared.lock_state().tree_watch_starts += 1;
                }
                #[cfg(not(test))]
                drop(tree_feed);
                self.tree_watch = Some(tree_watch);
                self.mode = WorkingTreeChangeMode::Watch;
            }
            Err(error) => {
                self.give_back_watches();
                if matches!(
                    error,
                    FileWatchError::RootUnresolved { .. } | FileWatchError::RootRemoved { .. }
                ) {
                    self.announce_repository_change();
                }
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder could not be watched, so it is checked on a slow tick"
                );
                self.start_slow_tick();
            }
        }
    }

    // Checks the count against the ceiling and takes it in one step under the watcher's lock, so
    // two folders starting together never both take what is left.
    fn take_watches(&self, count: u64, ceiling: u64) -> WatchTake {
        let mut state = self.shared.lock_state();
        let held = state.held_watches;
        let Some(entry) = state
            .folders
            .get_mut(&self.folder.key)
            .filter(|entry| entry.id == self.folder.id)
        else {
            return WatchTake::Closed;
        };
        if held.saturating_add(count) > ceiling {
            return WatchTake::OverCeiling;
        }
        entry.tree_watch_count = count;
        state.held_watches = held + count;
        WatchTake::Taken
    }

    // Gives the tree watch's count back, when the folder is still open; a closed one gave it back.
    fn give_back_watches(&self) {
        let mut state = self.shared.lock_state();
        let Some(entry) = state
            .folders
            .get_mut(&self.folder.key)
            .filter(|entry| entry.id == self.folder.id)
        else {
            return;
        };
        let count = std::mem::take(&mut entry.tree_watch_count);
        state.held_watches -= count;
    }

    fn stop_tree_watch(&mut self) {
        self.tree_watch = None;
        self.give_back_watches();
    }

    // Drops the tree watch and its count for the rest of the folder's life, and ticks instead.
    fn fall_back_to_slow_tick(&mut self) {
        self.stop_tree_watch();
        self.start_slow_tick();
    }

    fn start_slow_tick(&mut self) {
        self.mode = WorkingTreeChangeMode::SlowTick;
        if self.tick.is_some() {
            return;
        }
        let due = Arc::new(Notify::new());
        let waking = Arc::clone(&due);
        let interval: Duration = self.shared.deps.slow_tick_interval;
        // The job only wakes the task, so a slow `git status` holds no other job.
        let job = self.shared.deps.scheduler.schedule_repeating(
            "working folder slow tick",
            interval,
            interval,
            move |_stop| {
                waking.notify_one();
                async { Ok(()) }.boxed()
            },
        );
        let job = match job {
            Ok(job) => Some(job),
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a working folder's slow tick could not be scheduled, so its changes are not \
                     told"
                );
                None
            }
        };
        self.tick = Some(SlowTick {
            job,
            due,
            last_digest: None,
        });
    }

    fn stop_tick(&mut self) {
        if let Some(job) = self.tick.take().and_then(|tick| tick.job) {
            job.cancel();
        }
    }

    // Sends one change to each subscriber on the folder.
    fn send_change(&mut self) {
        self.is_raise_pending = false;
        let listeners: Vec<_> = self
            .shared
            .lock_state()
            .subscriptions
            .values()
            .filter(|subscription| subscription.folder.as_ref() == Some(&self.folder))
            .map(|subscription| (subscription.session_id, Arc::clone(&subscription.on_change)))
            .collect();
        let changed_at = WireInstant::now();
        for (session_id, on_change) in listeners {
            on_change(WorkingTreeChange {
                session_id,
                changed_at: changed_at.clone(),
                mode: self.mode,
            });
        }
    }

    fn announce_repository_change(&self) {
        // No receiver is listening when nothing reprobes yet.
        if self
            .shared
            .repository_changes
            .send(self.folder.key.clone())
            .is_err()
        {
            tracing::debug!("a working folder's repository changed with no receiver listening");
        }
    }

    #[cfg(test)]
    fn with_entry(&self, change: impl FnOnce(&mut super::FolderEntry)) {
        if let Some(entry) = self
            .shared
            .lock_state()
            .folders
            .get_mut(&self.folder.key)
            .filter(|entry| entry.id == self.folder.id)
        {
            change(entry);
        }
    }
}

async fn next_notice<W: Watcher + Send + 'static>(
    watch: &mut Option<FileWatch<W>>,
) -> Option<FileWatchNotice> {
    match watch {
        Some(watch) => watch.next_notice().await,
        None => std::future::pending().await,
    }
}

async fn tick_due(tick: Option<&SlowTick>) {
    match tick {
        Some(tick) => tick.due.notified().await,
        None => std::future::pending().await,
    }
}

async fn ignored_read_done(read: &mut Option<IgnoredRead>) -> Result<HashSet<Vec<u8>>, GitError> {
    match read {
        Some(pending) => {
            let outcome = pending.await;
            *read = None;
            outcome
        }
        None => std::future::pending().await,
    }
}

// Whether any changed path is a folder now, read off the task in one batch; a path that names
// nothing is no folder, and one that cannot be read is logged and taken as none.
async fn has_a_folder(paths: Vec<PathBuf>) -> bool {
    let read = tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .any(|path| match std::fs::symlink_metadata(path) {
                Ok(metadata) => metadata.is_dir(),
                Err(error) if is_missing_entry(&error) => false,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a new entry in a working folder could not be read"
                    );
                    false
                }
            })
    })
    .await;
    match read {
        Ok(has_a_folder) => has_a_folder,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a working folder's changed entries could not be read, so what git ignores is not \
                 read again"
            );
            false
        }
    }
}

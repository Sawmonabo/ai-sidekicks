//! The background fetch that keeps each branch's ahead and behind figures true while a session on
//! the project is live.
//!
//! - It fetches every remote of the repository that `git fetch --all` would, one at a time, since
//!   an older git passes `--no-write-fetch-head` to none of the fetches `--all` starts, and nothing
//!   more: it never pulls, never prunes a remote-tracking branch or tag, and leaves `FETCH_HEAD`
//!   alone, so the person's own next `git pull` reads what they fetched themselves. A remote the
//!   person set `skipFetchAll` or `skipDefaultUpdate` on is skipped; every remote after the first
//!   downloads no bundle list again, and every remote but the last skips git's automatic
//!   maintenance and commit-graph write, as git's own fetch of several remotes does, so each runs
//!   once a fetch.
//! - It runs as the person, with their git config, hooks and credentials, and with no terminal,
//!   credential window or askpass program to prompt through: `GIT_ASKPASS` is set empty, which
//!   keeps git from running `core.askPass` or `SSH_ASKPASS`, the credential manager is told never
//!   to open a window, and ssh never to run an askpass program. A fetch that would need a password
//!   fails and the figures keep the instant they were last true, kept on the mount's row.
//! - The scheduler only says when a repository is due; the fetches run one at a time in a lane of
//!   their own, so a remote that does not answer holds no other job. Each repository is due at once
//!   when first held and again an interval after each of its fetches ends, and one time bound
//!   covers a whole fetch however many remotes it asks.
//! - The stop ends a fetch under way, which then records nothing.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::scheduler::{JobCondition, ScheduledJobHandle, Scheduler};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::stored_column::optional_text_column;
use crate::database::writer::DatabaseWriter;
use crate::git::process::{
    CONFIG_UNSET_EXIT_CODE, GIT_COMMAND_TIMEOUT, GitCall, GitError, GitRunner, background_read,
    in_folder,
};
use crate::workspace::clone::progress::GitProgressReader;
use crate::workspace::clone::streamed_git::run_streamed_git;

/// How long after one fetch of a repository ends the next begins: often enough that the figures a
/// person reads are minutes old at most, rarely enough that a remote is asked a few times an hour.
const BACKGROUND_FETCH_INTERVAL: Duration = Duration::from_secs(180);

// No credential helper window and no askpass program on a timer; the runner already turns off
// git's own terminal prompt. An empty `GIT_ASKPASS` stops git's fall back to `core.askPass` and
// `SSH_ASKPASS`.
const NO_PROMPT_ENVIRONMENT: [(&str, &str); 3] = [
    ("GIT_ASKPASS", ""),
    ("GCM_INTERACTIVE", "never"),
    ("SSH_ASKPASS_REQUIRE", "never"),
];

// The settings that keep a remote out of `git fetch --all`, read as booleans in one listing.
const SKIPPED_REMOTE_SETTINGS: &str = "^remote\\..*\\.(skipfetchall|skipdefaultupdate)$";

// The figures' instant while the latest fetch failed: the last success, else the attach.
const COUNTS_AS_OF_SQL: &str = "SELECT CASE WHEN fetch_failed_at IS NULL THEN NULL
                ELSE COALESCE(fetched_at, attached_at) END
  FROM repo_mounts WHERE id = ?";

const RECORD_FETCHED_SQL: &str =
    "UPDATE repo_mounts SET fetched_at = @now, fetch_failed_at = NULL WHERE id = @repoMountId";

const RECORD_FETCH_FAILED_SQL: &str =
    "UPDATE repo_mounts SET fetch_failed_at = @now WHERE id = @repoMountId";

/// The repository a held fetch keeps fresh.
#[derive(Clone, Debug)]
pub(crate) struct FetchedRepository {
    /// The mount whose row keeps when its fetches last succeeded and failed.
    pub(crate) repo_mount_id: RepoMountId,
    /// The repository's own checkout, where the fetch runs.
    pub(crate) repository_root: PathBuf,
    /// Where the repository is: `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
}

/// What the background fetch runs with.
pub(crate) struct BackgroundFetchDeps {
    /// The daemon's git, for the remotes listing and each fetch.
    pub(crate) git: GitRunner,
    /// Where each fetch's success or failure is recorded on its mount's row.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// Says when each repository is next due; the fetch itself runs outside its slot.
    pub(crate) scheduler: Arc<Scheduler>,
}

/// Fetches each held repository at once and then an interval after each fetch ends, one fetch at a
/// time in its own lane. Made inside the daemon's runtime, where its lane runs.
pub(crate) struct BackgroundFetch {
    shared: Arc<FetchShared>,
    lane: Mutex<Option<JoinHandle<()>>>,
}

// What the fetch, its holds, its scheduled jobs and its lane share.
struct FetchShared {
    deps: BackgroundFetchDeps,
    state: Mutex<FetchState>,
    // Told when a repository joins the due queue.
    due_added: Notify,
    // Canceled at the stop, which ends the fetch under way.
    stop: CancellationToken,
    #[cfg(test)]
    counts: tokio::sync::watch::Sender<FetchCounts>,
}

/// How many fetches have begun and ended, for a test to wait on.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FetchCounts {
    /// Fetches begun.
    pub(crate) begun: u64,
    /// Fetches that ended and recorded.
    pub(crate) ended: u64,
}

#[derive(Default)]
struct FetchState {
    held_by_mount: HashMap<RepoMountId, HeldRepository>,
    // The repositories due a fetch, in order, each at most once.
    due: VecDeque<RepoMountId>,
    next_id: u64,
}

// One held repository.
struct HeldRepository {
    // Tells this hold set from a later one on the same mount.
    id: u64,
    repository: FetchedRepository,
    hold_count: usize,
    // Its next fetch, while it waits for one.
    next_fetch: Option<ScheduledJobHandle>,
}

/// Keeps one repository fetched until it drops; holds on one mount share their fetches.
pub(crate) struct FetchHold {
    shared: Weak<FetchShared>,
    repo_mount_id: RepoMountId,
    id: u64,
}

impl Drop for FetchHold {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.release(&self.repo_mount_id, self.id);
        }
    }
}

// How one fetch of a repository ended.
enum FetchOutcome {
    // Every remote fetched.
    Fetched,
    // A remote's fetch failed, or git could not be run; the failure is logged.
    Failed,
    // The stop ended it, so it records nothing.
    Stopped,
}

impl BackgroundFetch {
    /// A fetch running with `deps`, fetching nothing until a hold. Called inside the daemon's
    /// runtime, where its lane is spawned.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(deps: BackgroundFetchDeps) -> Self {
        let shared = Arc::new(FetchShared {
            deps,
            state: Mutex::new(FetchState::default()),
            due_added: Notify::new(),
            stop: CancellationToken::new(),
            #[cfg(test)]
            counts: tokio::sync::watch::Sender::new(FetchCounts::default()),
        });
        let lane = tokio::spawn(Arc::clone(&shared).run_lane());
        Self {
            shared,
            lane: Mutex::new(Some(lane)),
        }
    }

    /// Keeps `repository` fetched until the returned hold drops: at once for the first hold on its
    /// mount, then an interval after each fetch ends; the last hold's drop cancels its next fetch,
    /// and a fetch under way then finishes and records.
    #[cfg_attr(not(test), expect(dead_code, reason = "the live session folders"))]
    pub(crate) fn keep_fresh(&self, repository: FetchedRepository) -> FetchHold {
        let repo_mount_id = repository.repo_mount_id;
        let mut state = self.shared.lock_state();
        let id = if let Some(held) = state.held_by_mount.get_mut(&repo_mount_id) {
            held.hold_count += 1;
            held.id
        } else {
            state.next_id += 1;
            let id = state.next_id;
            state.held_by_mount.insert(
                repo_mount_id,
                HeldRepository {
                    id,
                    repository,
                    hold_count: 1,
                    next_fetch: None,
                },
            );
            self.shared.enqueue(&mut state, repo_mount_id);
            id
        };
        FetchHold {
            shared: Arc::downgrade(&self.shared),
            repo_mount_id,
            id,
        }
    }

    /// Cancels every held repository's next fetch, ends the fetch under way, which records
    /// nothing, and waits for the lane to end; a later hold fetches nothing.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's stop"))]
    pub(crate) async fn stop(&self) {
        let held = {
            let mut state = self.shared.lock_state();
            state.due.clear();
            std::mem::take(&mut state.held_by_mount)
        };
        for repository in held.values() {
            if let Some(next_fetch) = &repository.next_fetch {
                next_fetch.cancel();
            }
        }
        self.shared.stop.cancel();
        let lane = self
            .lane
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(lane) = lane
            && let Err(error) = lane.await
        {
            tracing::error!(
                error = &error as &(dyn Error + 'static),
                "the background fetch's lane ended unexpectedly"
            );
        }
    }
}

#[cfg(test)]
impl BackgroundFetch {
    /// The fetches begun and ended so far, and each change to them.
    pub(crate) fn counts(&self) -> tokio::sync::watch::Receiver<FetchCounts> {
        self.shared.counts.subscribe()
    }

    /// Whether any hold keeps `repo_mount_id` fetched.
    pub(crate) fn is_held(&self, repo_mount_id: &RepoMountId) -> bool {
        self.shared
            .lock_state()
            .held_by_mount
            .contains_key(repo_mount_id)
    }
}

impl FetchShared {
    fn lock_state(&self) -> MutexGuard<'_, FetchState> {
        // The state holds no invariant a panicking holder could break.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // Puts `repo_mount_id` on the due queue, unless it is there already or the fetch has stopped.
    fn enqueue(&self, state: &mut FetchState, repo_mount_id: RepoMountId) {
        if self.stop.is_cancelled() || state.due.contains(&repo_mount_id) {
            return;
        }
        state.due.push_back(repo_mount_id);
        self.due_added.notify_one();
    }

    // Lets one hold of the hold set `id` go; the last cancels the repository's next fetch.
    fn release(&self, repo_mount_id: &RepoMountId, id: u64) {
        let mut state = self.lock_state();
        let Some(held) = state.held_by_mount.get_mut(repo_mount_id) else {
            return;
        };
        if held.id != id {
            return;
        }
        held.hold_count -= 1;
        if held.hold_count > 0 {
            return;
        }
        if let Some(held) = state.held_by_mount.remove(repo_mount_id)
            && let Some(next_fetch) = held.next_fetch
        {
            next_fetch.cancel();
        }
        state.due.retain(|due| due != repo_mount_id);
    }

    // Fetches each due repository in turn until the stop, and schedules a still-held one's next
    // fetch an interval after this one ended.
    async fn run_lane(self: Arc<Self>) {
        loop {
            let next = {
                let mut state = self.lock_state();
                // A release takes its mount off the queue, so a due mount is held.
                let due = state.due.pop_front();
                due.and_then(|repo_mount_id| state.held_by_mount.get(&repo_mount_id))
                    .map(|held| (held.id, held.repository.clone()))
            };
            let Some((id, repository)) = next else {
                tokio::select! {
                    biased;
                    () = self.stop.cancelled() => return,
                    () = self.due_added.notified() => continue,
                }
            };
            match self.fetch(&repository).await {
                FetchOutcome::Stopped => return,
                FetchOutcome::Fetched => self.record(&repository, RECORD_FETCHED_SQL).await,
                FetchOutcome::Failed => self.record(&repository, RECORD_FETCH_FAILED_SQL).await,
            }
            #[cfg(test)]
            self.counts.send_modify(|counts| counts.ended += 1);
            self.schedule_next(&repository.repo_mount_id, id);
        }
    }

    // Schedules the next fetch of the hold set `id`, while it is still held.
    fn schedule_next(self: &Arc<Self>, repo_mount_id: &RepoMountId, id: u64) {
        let mut state = self.lock_state();
        if self.stop.is_cancelled() {
            return;
        }
        let Some(held) = state
            .held_by_mount
            .get_mut(repo_mount_id)
            .filter(|held| held.id == id)
        else {
            return;
        };
        let shared = Arc::downgrade(self);
        let repo_mount_id = *repo_mount_id;
        let scheduled = self.deps.scheduler.schedule(
            "background fetch",
            JobCondition::Always,
            BACKGROUND_FETCH_INTERVAL,
            move |_stop| {
                if let Some(shared) = shared.upgrade() {
                    shared.on_due(repo_mount_id, id);
                }
                async { Ok(()) }.boxed()
            },
        );
        match scheduled {
            Ok(next_fetch) => held.next_fetch = Some(next_fetch),
            Err(error) => tracing::error!(
                repo_mount_id = %repo_mount_id,
                error = &error as &(dyn Error + 'static),
                "the next background fetch of a project's repository could not be scheduled"
            ),
        }
    }

    // The scheduled job: the hold set `id`, while still held, joins the due queue.
    fn on_due(&self, repo_mount_id: RepoMountId, id: u64) {
        let mut state = self.lock_state();
        let is_held = match state.held_by_mount.get_mut(&repo_mount_id) {
            Some(held) if held.id == id => {
                held.next_fetch = None;
                true
            }
            Some(_) | None => false,
        };
        if is_held {
            self.enqueue(&mut state, repo_mount_id);
        }
    }

    // Fetches every remote of `repository`, one at a time, within one time bound; a failed remote's
    // fetch lets the others still run.
    async fn fetch(&self, repository: &FetchedRepository) -> FetchOutcome {
        #[cfg(test)]
        self.counts.send_modify(|counts| counts.begun += 1);
        let bound = CancellationToken::new();
        let fetching = self.fetch_remotes(repository, &bound);
        tokio::pin!(fetching);
        let fetched = tokio::select! {
            fetched = &mut fetching => fetched,
            () = tokio::time::sleep(GIT_COMMAND_TIMEOUT) => {
                bound.cancel();
                fetching.await
            }
        };
        if self.stop.is_cancelled() {
            // A fetch the stop ended neither succeeded nor failed, unless git could not be stopped.
            if let Err(error) = fetched {
                tracing::warn!(
                    repo_mount_id = %repository.repo_mount_id,
                    error = &*error as &(dyn Error + 'static),
                    "the background fetch of a project's repository failed as the service stopped"
                );
            }
            return FetchOutcome::Stopped;
        }
        let repo_mount_id = &repository.repo_mount_id;
        match fetched {
            Ok(None) => FetchOutcome::Fetched,
            Ok(Some(failure)) => {
                tracing::warn!(
                    repo_mount_id = %repo_mount_id,
                    failure,
                    "the background fetch of a project's repository failed, so its ahead and \
                     behind figures stay as last read"
                );
                FetchOutcome::Failed
            }
            Err(error) => {
                tracing::warn!(
                    repo_mount_id = %repo_mount_id,
                    error = &*error as &(dyn Error + 'static),
                    "the background fetch of a project's repository could not run git, so its \
                     ahead and behind figures stay as last read"
                );
                FetchOutcome::Failed
            }
        }
    }

    // The first remote's failure line, `None` when every remote fetched; fails when the remotes
    // cannot be listed or a fetch cannot be started, followed or stopped.
    async fn fetch_remotes(
        &self,
        repository: &FetchedRepository,
        bound: &CancellationToken,
    ) -> Result<Option<String>, Box<dyn Error + Send + Sync>> {
        let git = &self.deps.git;
        let place = repository.place.as_ref();
        let listing = tokio::select! {
            listed = git.run(
                place,
                GitCall::read(background_read(&repository.repository_root, &["remote"])),
            ) => listed?,
            () = self.stop.cancelled() => return Ok(None),
        };
        let skipped = tokio::select! {
            skipped = read_skipped_remotes(git, repository) => skipped?,
            () = self.stop.cancelled() => return Ok(None),
        };
        let listed = String::from_utf8_lossy(&listing.stdout).into_owned();
        let remotes: Vec<&str> = listed
            .lines()
            .filter(|remote| !remote.is_empty() && !skipped.contains(*remote))
            .collect();
        let mut failure = None;
        for (index, remote) in remotes.iter().enumerate() {
            if bound.is_cancelled() || self.stop.is_cancelled() {
                break;
            }
            // git's own fetch of several remotes downloads the bundle list once, at its first.
            let mut arguments = if index == 0 {
                Vec::new()
            } else {
                vec!["-c", "fetch.bundleURI="]
            };
            arguments.extend([
                "fetch",
                "--no-prune",
                "--no-prune-tags",
                "--no-write-fetch-head",
                "--quiet",
            ]);
            if index + 1 < remotes.len() {
                // git's own fetch of several remotes passes its children the same two.
                arguments.extend(["--no-auto-gc", "--no-write-commit-graph"]);
            }
            arguments.extend(["--", remote]);
            let call = NO_PROMPT_ENVIRONMENT.iter().fold(
                GitCall::write(in_folder(&repository.repository_root, &arguments)),
                |call, (name, value)| call.with_environment(name, value),
            );
            let mut reader = GitProgressReader::new(|_progress| {});
            let exit = run_streamed_git(git, place, call, bound, &self.stop, |chunk| {
                reader.read(chunk);
            })
            .await?;
            if !exit.has_succeeded && failure.is_none() {
                failure = Some(reader.failure_line().map_or_else(
                    || {
                        exit.exit.signal_name.clone().map_or_else(
                            || format!("git ended with code {}", exit.exit.exit_code),
                            |signal| format!("git ended with {signal}"),
                        )
                    },
                    |line| line.as_str().to_owned(),
                ));
            }
        }
        if bound.is_cancelled() && failure.is_none() && !self.stop.is_cancelled() {
            failure = Some(
                GitError::TimedOut {
                    timeout: GIT_COMMAND_TIMEOUT,
                }
                .to_string(),
            );
        }
        Ok(failure)
    }

    // Records the fetch's end on its mount's row with `sql`; a failed write is logged, since no
    // caller waits on a background fetch and the next one records again.
    async fn record(&self, repository: &FetchedRepository, sql: &'static str) {
        let statement = WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(vec![
                (
                    Cow::Borrowed("@now"),
                    Value::Text(WireInstant::now().as_str().to_owned()),
                ),
                text_binding("@repoMountId", &repository.repo_mount_id.to_string()),
            ]),
            expected_row_count: None,
        };
        if let Err(error) = self.deps.writer.write(vec![statement]).await {
            tracing::error!(
                repo_mount_id = %repository.repo_mount_id,
                error = &error as &(dyn Error + 'static),
                "the background fetch of a project's repository could not be recorded"
            );
        }
    }
}

// The remotes `git fetch --all` leaves out: those whose last `skipFetchAll` or `skipDefaultUpdate`
// setting is true. Fails with git's failure but for no setting matching.
async fn read_skipped_remotes(
    git: &GitRunner,
    repository: &FetchedRepository,
) -> Result<HashSet<String>, GitError> {
    let read = git
        .run(
            repository.place.as_ref(),
            GitCall::read(background_read(
                &repository.repository_root,
                &[
                    "config",
                    "--type=bool",
                    "--get-regexp",
                    SKIPPED_REMOTE_SETTINGS,
                ],
            )),
        )
        .await;
    let listing = match read {
        Ok(output) => output.stdout,
        Err(GitError::Exited {
            code: Some(CONFIG_UNSET_EXIT_CODE),
            ..
        }) => return Ok(HashSet::new()),
        Err(failure) => return Err(failure),
    };
    // Each setting both keys share is one flag, the last line for a remote winning.
    let mut is_skipped: HashMap<String, bool> = HashMap::new();
    for line in String::from_utf8_lossy(&listing).lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let remote = key.strip_prefix("remote.").and_then(|rest| {
            rest.strip_suffix(".skipfetchall")
                .or_else(|| rest.strip_suffix(".skipdefaultupdate"))
        });
        if let Some(remote) = remote {
            is_skipped.insert(remote.to_owned(), value == "true");
        }
    }
    Ok(is_skipped
        .into_iter()
        .filter_map(|(remote, is_skipped)| is_skipped.then_some(remote))
        .collect())
}

/// When `repo_mount_id`'s ahead and behind figures were last true, given only while its latest
/// fetch failed: its last successful fetch, or its attach when none has succeeded; `None` while
/// they are current or the mount has no row. Fails as the read does.
pub(crate) fn read_counts_as_of(
    connection: &Connection,
    repo_mount_id: &RepoMountId,
) -> rusqlite::Result<Option<WireInstant>> {
    Ok(connection
        .prepare_cached(COUNTS_AS_OF_SQL)?
        .query_row([repo_mount_id.to_string()], |row| {
            optional_text_column(row, 0, WireInstant::try_from)
        })
        .optional()?
        .flatten())
}

#[cfg(test)]
mod tests;

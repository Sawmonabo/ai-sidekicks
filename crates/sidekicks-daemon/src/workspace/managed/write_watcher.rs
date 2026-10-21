//! Reports each write a chat makes in its managed workspace, as it lands: one watch over the
//! folder holding every chat's workspace serves them all, so no chat costs a watch of its own and
//! nothing scans on a timer.
//!
//! - The feed names a path and not what happened to it, and a removal reads like a write, so each
//!   change is read on disk, off the system's thread: a path that names nothing was removed.
//! - The feed can name one write twice and names a mode change too, so an entry whose signature is
//!   unchanged since its last report is not reported again; the last signatures are kept for a
//!   bounded number of recent paths.
//! - A workspace's own `.git` folder and the workspace folder itself are the daemon's, not the
//!   chat's, so neither is reported.
//! - A watch started again once ready walks for what landed before it was armed, from the instant
//!   its owner hands it, so no write in between is lost.
//! - Every session a change names, a removal among them, is named to the owner's count of the
//!   files in that session's workspace, once per batch of changes.

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::num::NonZeroUsize;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use lru::LruCache;
use notify::{RecommendedWatcher, Watcher};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{EntryIdentity, entry_identity};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::events::session::pending::PendingSessions;
use crate::file::bounded_read::run_on_own_thread;
use crate::file_watch::{
    ChangeFeed, FileWatch, FileWatchError, FileWatchNotice, WalkFilter, WatchedRoot,
};
use crate::missing_entry::is_missing_entry;

const GIT_METADATA_FOLDER_NAME: &str = ".git";

// The recent paths whose last reported signature is kept, to tell a repeated notice from a new
// write; a path pushed out is reported once more on its next notice, which costs one extra version.
const RECENT_REPORTED_PATH_LIMIT: NonZeroUsize =
    NonZeroUsize::new(10_000).expect("the recent-path limit is not zero");

/// One write a chat made in its managed workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedWorkspaceWrite {
    /// The session whose workspace was written.
    pub(crate) session_id: SessionId,
    /// The written entry's path inside the session's workspace, as the system's bytes.
    pub(crate) relative_path: PathBuf,
    /// Whether a file was written or a folder made.
    pub(crate) kind: ManagedWorkspaceWriteKind,
}

/// What a chat wrote: a file, or a folder it made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedWorkspaceWriteKind {
    /// A file's content or modified time moved.
    File,
    /// A folder was made.
    Folder,
}

/// Why the managed workspaces watch could not start or stopped; from then on no write is reported.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ManagedWorkspaceWatchError {
    /// The folder holding every chat's workspace could not be made.
    #[error("the managed workspaces folder could not be made")]
    FolderNotMade(#[source] io::Error),
    /// The watch could not start.
    #[error("the managed workspaces watch could not start")]
    NotStarted(#[source] FileWatchError),
    /// The watch failed, its folder removed among the causes.
    #[error("the managed workspaces watch failed")]
    Failed(#[source] FileWatchError),
    /// The read of the changed entries could not run on its thread or stopped before it answered.
    #[error("the managed workspaces watch's read stopped before it finished")]
    Interrupted(#[source] io::Error),
}

/// The one watch over every chat's managed workspace; dropping it stops the watch and its task.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the chat-versions record of a chat's writes")
)]
pub(crate) struct ManagedWorkspaceWriteWatcher {
    task: JoinHandle<()>,
}

impl ManagedWorkspaceWriteWatcher {
    /// Makes `workspaces_folder` when absent, watches it, walks it once ready for every write
    /// changed at or after `missed_since`, and sends each write on `writes`, waiting for room so a
    /// slow reader slows only this watch; every session a change names, a removal among them, is
    /// added to `changed_folders`. When the watch cannot start or fails, the reason is
    /// logged and the receiver answers with the instant since which writes may be unreported, for
    /// the next watch's `missed_since`; it never answers otherwise.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the chat-versions record of a chat's writes")
    )]
    pub(crate) fn start(
        workspaces_folder: PathBuf,
        writes: mpsc::Sender<ManagedWorkspaceWrite>,
        changed_folders: Arc<PendingSessions>,
        missed_since: SystemTime,
    ) -> (Self, oneshot::Receiver<SystemTime>) {
        let (failure_sender, failure) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (outcome, unreported_since) =
                match open_watch::<RecommendedWatcher>(workspaces_folder).await {
                    Ok((mut watch, _feed)) => {
                        watch.catch_up(missed_since);
                        let outcome = report_writes(&mut watch, &writes, &changed_folders).await;
                        (outcome, watch.whole_since())
                    }
                    Err(error) => (Err(error), missed_since),
                };
            if let Err(error) = outcome {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "the managed workspaces watch stopped; chat writes are no longer reported"
                );
                if failure_sender.send(unreported_since).is_err() {
                    tracing::debug!("nobody waits for the managed workspaces watch's failure");
                }
            }
        });
        (Self { task }, failure)
    }

    /// Whether the watch's task has ended, for any reason.
    pub(crate) fn has_finished(&self) -> bool {
        self.task.is_finished()
    }
}

impl Drop for ManagedWorkspaceWriteWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// Makes the folder, since the system cannot watch a folder that does not exist yet, then watches
// it with every entry but a workspace's own `.git` folder covered.
async fn open_watch<W: Watcher + Send + 'static>(
    workspaces_folder: PathBuf,
) -> Result<(FileWatch<W>, ChangeFeed), ManagedWorkspaceWatchError> {
    tokio::fs::create_dir_all(&workspaces_folder)
        .await
        .map_err(ManagedWorkspaceWatchError::FolderNotMade)?;
    let filter = WalkFilter::new(|relative_path: &Path| {
        relative_path.components().nth(1)
            != Some(Component::Normal(OsStr::new(GIT_METADATA_FOLDER_NAME)))
    });
    FileWatch::start(vec![WatchedRoot {
        path: workspaces_folder,
        filter,
    }])
    .await
    .map_err(ManagedWorkspaceWatchError::NotStarted)
}

// Reads the watch's notices until it fails or the reader of `writes` is gone.
async fn report_writes<W: Watcher + Send + 'static>(
    watch: &mut FileWatch<W>,
    writes: &mpsc::Sender<ManagedWorkspaceWrite>,
    changed_folders: &PendingSessions,
) -> Result<(), ManagedWorkspaceWatchError> {
    let root = watch
        .roots()
        .first()
        .cloned()
        .expect("the watch is started on the workspaces folder alone");
    let mut reporter = WriteReporter {
        root,
        recent: LruCache::new(RECENT_REPORTED_PATH_LIMIT),
    };
    while let Some(notice) = watch.next_notice().await {
        match notice {
            FileWatchNotice::Changed(paths) => {
                if !reporter.report(paths, writes, changed_folders).await? {
                    return Ok(());
                }
            }
            FileWatchNotice::Incomplete => tracing::warn!(
                "some managed workspace folders are not watched, so writes in them are not \
                 reported"
            ),
            FileWatchNotice::Failed(error) => {
                return Err(ManagedWorkspaceWatchError::Failed(error));
            }
        }
    }
    Ok(())
}

// A changed path that names an entry inside one session's workspace.
struct Candidate {
    path: PathBuf,
    session_id: SessionId,
    relative_path: PathBuf,
}

// What one changed path holds now, read without following a link.
enum EntryReading {
    Missing,
    Neither,
    Written {
        kind: ManagedWorkspaceWriteKind,
        signature: EntrySignature,
    },
}

// What tells one write of an entry from the next: a file's content moves its length or modified
// time, while a mode or owner change moves neither; a folder is written once, when it is made.
#[derive(Debug, PartialEq, Eq)]
enum EntrySignature {
    File {
        identity: EntryIdentity,
        length: u64,
        modified: SystemTime,
    },
    Folder {
        identity: EntryIdentity,
        created: Option<SystemTime>,
    },
}

struct WriteReporter {
    root: PathBuf,
    recent: LruCache<PathBuf, EntrySignature>,
}

impl WriteReporter {
    // Reads every changed path in one batch on a thread of its own and sends each new write, then
    // names each session the batch changed to `changed_folders`; answers false once the reader of
    // `writes` is gone.
    async fn report(
        &mut self,
        paths: Vec<PathBuf>,
        writes: &mpsc::Sender<ManagedWorkspaceWrite>,
        changed_folders: &PendingSessions,
    ) -> Result<bool, ManagedWorkspaceWatchError> {
        let candidates: Vec<Candidate> = paths
            .into_iter()
            .filter_map(|path| self.candidate(path))
            .collect();
        if candidates.is_empty() {
            return Ok(true);
        }
        let changed_sessions: HashSet<SessionId> = candidates
            .iter()
            .map(|candidate| candidate.session_id)
            .collect();
        let readings = run_on_own_thread("managed workspace write read", move || {
            candidates
                .into_iter()
                .map(|candidate| {
                    let reading = read_entry(&candidate.path);
                    (candidate, reading)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(ManagedWorkspaceWatchError::Interrupted)?;
        for (candidate, reading) in readings {
            let (kind, signature) = match reading {
                Ok(EntryReading::Written { kind, signature }) => (kind, signature),
                Ok(EntryReading::Missing) => {
                    self.recent.pop(&candidate.path);
                    continue;
                }
                // A link is neither a file nor a folder a chat's versions can keep.
                Ok(EntryReading::Neither) => continue,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a managed workspace's written entry could not be read, so its write is \
                         not reported"
                    );
                    continue;
                }
            };
            if self.recent.get(&candidate.path) == Some(&signature) {
                continue;
            }
            self.recent.put(candidate.path, signature);
            let write = ManagedWorkspaceWrite {
                session_id: candidate.session_id,
                relative_path: candidate.relative_path,
                kind,
            };
            if writes.send(write).await.is_err() {
                return Ok(false);
            }
        }
        for session_id in changed_sessions {
            changed_folders.add(session_id);
        }
        Ok(true)
    }

    // The session and the entry inside its workspace a changed path names; none for the workspace
    // folder itself, and none, logged, for a folder named for no session.
    fn candidate(&self, path: PathBuf) -> Option<Candidate> {
        let mut components = path.strip_prefix(&self.root).ok()?.components();
        let Some(Component::Normal(session_folder)) = components.next() else {
            return None;
        };
        let relative_path = components.as_path().to_path_buf();
        if relative_path.as_os_str().is_empty() {
            return None;
        }
        let Some(session_text) = session_folder.to_str() else {
            tracing::warn!(
                "the managed workspaces folder holds a folder named for no session; its change is \
                 not reported"
            );
            return None;
        };
        let session_id = match SessionId::new(session_text) {
            Ok(session_id) => session_id,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the managed workspaces folder holds a folder named for no session; its change \
                     is not reported"
                );
                return None;
            }
        };
        Some(Candidate {
            path,
            session_id,
            relative_path,
        })
    }
}

// One read that follows no link, so a link never leads out of the workspace; a path that names
// nothing was removed, which is no write.
fn read_entry(path: &Path) -> io::Result<EntryReading> {
    let entry = match entry_identity(path) {
        Ok(entry) => entry,
        Err(error) if is_missing_entry(&error) => return Ok(EntryReading::Missing),
        Err(error) => return Err(error),
    };
    if entry.is_folder {
        // Some file systems keep no creation time; such a folder signs by its identity alone.
        let created = match entry.metadata.created() {
            Ok(created) => Some(created),
            Err(error) if error.kind() == io::ErrorKind::Unsupported => None,
            Err(error) => return Err(error),
        };
        return Ok(EntryReading::Written {
            kind: ManagedWorkspaceWriteKind::Folder,
            signature: EntrySignature::Folder {
                identity: entry.identity,
                created,
            },
        });
    }
    if !entry.metadata.is_file() {
        return Ok(EntryReading::Neither);
    }
    Ok(EntryReading::Written {
        kind: ManagedWorkspaceWriteKind::File,
        signature: EntrySignature::File {
            identity: entry.identity,
            length: entry.metadata.len(),
            modified: entry.metadata.modified()?,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use notify::event::{DataChange, ModifyKind};
    use notify::{Event, EventHandler, EventKind, NullWatcher};
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::{ManagedWorkspaceWrite, ManagedWorkspaceWriteKind, open_watch, report_writes};
    use crate::events::session::pending::PendingSessions;
    use crate::file_watch::{FEED_CAPACITY, wait_for_the_next_whole_second};

    const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";
    const OTHER_SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f";
    const WAIT: Duration = Duration::from_secs(10);

    fn notice(paths: &[PathBuf]) -> Event {
        let event = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)));
        paths.iter().cloned().fold(event, Event::add_path)
    }

    async fn next_write(
        writes: &mut mpsc::Receiver<ManagedWorkspaceWrite>,
    ) -> ManagedWorkspaceWrite {
        timeout(WAIT, writes.recv())
            .await
            .expect("a write is reported in time")
            .expect("the watch keeps reporting")
    }

    fn write(relative_path: &str, kind: ManagedWorkspaceWriteKind) -> ManagedWorkspaceWrite {
        ManagedWorkspaceWrite {
            session_id: sidekicks_contracts::session::id::SessionId::new(SESSION)
                .expect("a session id"),
            relative_path: PathBuf::from(relative_path),
            kind,
        }
    }

    fn session_folder(root: &Path) -> PathBuf {
        let session = root.join(SESSION);
        fs::create_dir_all(session.join(".git")).expect("the workspace and its .git are made");
        session
    }

    // Catches a repeated notice reported twice, the workspace's `.git` reported, a removed entry
    // reported as a write, and a removal not named to the count of the session's files, which
    // would leave the count high after a delete.
    #[tokio::test]
    async fn managed_write_watch_reports_each_write_once_never_git_and_counts_a_removal() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let (watch, mut feed) = open_watch::<NullWatcher>(scratch.path().join("workspaces"))
            .await
            .expect("the watch starts");
        let watch_root = watch.roots()[0].clone();
        let session = session_folder(&watch_root);
        fs::write(session.join("a.txt"), "first").expect("a file is written");
        fs::write(session.join("b.txt"), "second").expect("a file is written");
        fs::create_dir(session.join("made")).expect("a folder is made");
        fs::write(session.join(".git").join("index"), "index").expect("git's file is written");
        let (writes_sender, mut writes) = mpsc::channel(16);
        let changed_folders = Arc::new(PendingSessions::default());
        let named_folders = Arc::clone(&changed_folders);
        let task = tokio::spawn(async move {
            let mut watch = watch;
            report_writes(&mut watch, &writes_sender, &named_folders).await
        });

        feed.handle_event(Ok(notice(&[
            session.join("a.txt"),
            session.join("b.txt"),
            session.join("made"),
        ])));
        assert_eq!(
            next_write(&mut writes).await,
            write("a.txt", ManagedWorkspaceWriteKind::File)
        );
        assert_eq!(
            next_write(&mut writes).await,
            write("b.txt", ManagedWorkspaceWriteKind::File)
        );
        assert_eq!(
            next_write(&mut writes).await,
            write("made", ManagedWorkspaceWriteKind::Folder)
        );

        fs::remove_file(session.join("b.txt")).expect("the file is removed");
        fs::write(session.join("zz-last.txt"), "last").expect("a file is written");
        feed.handle_event(Ok(notice(&[session.join("a.txt")])));
        feed.handle_event(Ok(notice(&[
            session.join(".git").join("index"),
            session.join("b.txt"),
        ])));
        // Sent last and sorted last, so any write the notices above wrongly cause comes first.
        feed.handle_event(Ok(notice(&[session.join("zz-last.txt")])));
        assert_eq!(
            next_write(&mut writes).await,
            write("zz-last.txt", ManagedWorkspaceWriteKind::File)
        );
        assert!(writes.try_recv().is_err(), "nothing more is reported");

        // A second session's folder that only a removal changes, so only the removal names it.
        let other = watch_root.join(OTHER_SESSION);
        fs::create_dir_all(&other).expect("the other workspace is made");
        fs::write(other.join("gone.txt"), "removed").expect("a file is written");
        fs::remove_file(other.join("gone.txt")).expect("the file is removed");
        feed.handle_event(Ok(notice(&[other.join("gone.txt")])));
        let other_session =
            sidekicks_contracts::session::id::SessionId::new(OTHER_SESSION).expect("a session id");
        let mut named = HashSet::new();
        while !named.contains(&other_session) {
            named.extend(
                timeout(WAIT, changed_folders.take())
                    .await
                    .expect("the removal names its session"),
            );
        }
        assert!(writes.try_recv().is_err(), "the removal is no write");
        task.abort();
    }

    // Catches a lost feed left unread: a write whose notice was dropped from a full feed must
    // still be reported by the rescan the loss causes, a file written with its modified time set
    // an hour back among them, and an entry unchanged since the feed was last whole must not be.
    #[tokio::test]
    async fn managed_write_watch_rescans_after_the_feed_overflows() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let workspaces = scratch.path().join("workspaces");
        let session = session_folder(&workspaces);
        let unchanged = session.join("unchanged.txt");
        fs::write(&unchanged, "written before the watch").expect("written");
        age_by_an_hour(&unchanged);
        // The rescan counts whole seconds, so the unchanged file's last change is left a second
        // behind the watch's start.
        wait_for_the_next_whole_second().await;
        let (watch, mut feed) = open_watch::<NullWatcher>(workspaces)
            .await
            .expect("the watch starts");
        let session = watch.roots()[0].join(SESSION);
        fs::write(session.join("a.txt"), "written while the feed was full").expect("written");
        let unpacked = session.join("unpacked.txt");
        fs::write(&unpacked, "unpacked with its old time kept").expect("written");
        age_by_an_hour(&unpacked);

        // Nothing reads the feed yet, so it fills with notices the filter drops and the notices
        // for the writes are lost.
        let git_index = [session.join(".git").join("index")];
        for _ in 0..FEED_CAPACITY {
            feed.handle_event(Ok(notice(&git_index)));
        }
        feed.handle_event(Ok(notice(&[session.join("a.txt"), unpacked])));
        let (writes_sender, mut writes) = mpsc::channel(16);
        let task = tokio::spawn(async move {
            let mut watch = watch;
            report_writes(&mut watch, &writes_sender, &PendingSessions::default()).await
        });

        let mut reported = vec![next_write(&mut writes).await, next_write(&mut writes).await];
        reported.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        assert_eq!(
            reported,
            vec![
                write("a.txt", ManagedWorkspaceWriteKind::File),
                write("unpacked.txt", ManagedWorkspaceWriteKind::File),
            ]
        );
        assert!(
            timeout(Duration::from_millis(500), writes.recv())
                .await
                .is_err(),
            "the unchanged file is not reported"
        );
        task.abort();
    }

    fn age_by_an_hour(path: &Path) {
        fs::File::options()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(SystemTime::now() - Duration::from_secs(3_600)))
            .expect("the file is aged");
    }
}

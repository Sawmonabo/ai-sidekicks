//! A moved repository's carry: its capture folders renamed from each old common folder's name to
//! the newest one's, and the carries this daemon run holds pending, made or not, each for the mount
//! it is a carry of, until the write that ends it.

use std::error::Error;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::mount::{CapturesHeld, CapturesHeldCause, RepoMountId};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::OwnedMutexGuard;

use super::real_path_name;
use crate::trust_envelope::components_equal;

/// One moved repository's capture folders still to be renamed from each of its old common folders'
/// names to its newest one's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CaptureCarry {
    /// The old common folders' names, oldest first, the newest name never among them.
    old_names: Vec<String>,
    /// The newest common folder's name.
    new_name: String,
    /// The newest common folder.
    moved_to: PathBuf,
}

impl CaptureCarry {
    /// The carry of the repository whose common git folder moved from each of `moved_from` in turn,
    /// oldest first, to `moved_to`; a folder resolving to the newest name, as one moved back does,
    /// is no old one. Fails with the first folder that does not resolve.
    pub(crate) async fn new(
        moved_from: &[PathBuf],
        moved_to: &Path,
    ) -> Result<Self, UnresolvedFolder> {
        let new_name = resolved_name(moved_to).await?;
        let mut old_names: Vec<String> = Vec::with_capacity(moved_from.len());
        for folder in moved_from {
            let name = resolved_name(folder).await?;
            if name != new_name && !old_names.contains(&name) {
                old_names.push(name);
            }
        }
        Ok(Self {
            old_names,
            new_name,
            moved_to: moved_to.to_path_buf(),
        })
    }

    /// The old common folders' names, oldest first, which each owner's capture folder is renamed
    /// from.
    pub(crate) fn old_names(&self) -> &[String] {
        &self.old_names
    }

    /// The newest common folder's name, which each owner's capture folder is renamed to.
    pub(crate) fn new_name(&self) -> &str {
        &self.new_name
    }

    /// Whether the folders are renamed: a checkout that moved within its repository, whose common
    /// folder stayed, keeps its capture folders' names.
    pub(crate) fn is_rename(&self) -> bool {
        !self.old_names.is_empty()
    }

    /// The newest common folder, which the stored rows are rewritten to.
    pub(crate) fn moved_to(&self) -> &Path {
        &self.moved_to
    }

    // Whether `name` is an end of the carry, old or new.
    fn holds_name(&self, name: &str) -> bool {
        self.new_name == name || self.old_names.iter().any(|old_name| old_name == name)
    }

    // Whether every name of `other` is one of this carry's.
    fn covers(&self, other: &Self) -> bool {
        self.holds_name(&other.new_name) && other.old_names.iter().all(|name| self.holds_name(name))
    }
}

/// A common folder a carry names that did not resolve.
#[derive(Debug, thiserror::Error)]
#[error("the common folder {} could not be resolved", .folder.display())]
pub(crate) struct UnresolvedFolder {
    /// The folder.
    folder: PathBuf,
    /// Why.
    #[source]
    source: io::Error,
}

impl From<UnresolvedFolder> for io::Error {
    fn from(unresolved: UnresolvedFolder) -> Self {
        Self::new(unresolved.source.kind(), unresolved)
    }
}

// `folder`'s name, failing with the folder named.
async fn resolved_name(folder: &Path) -> Result<String, UnresolvedFolder> {
    real_path_name(folder)
        .await
        .map_err(|source| UnresolvedFolder {
            folder: folder.to_path_buf(),
            source,
        })
}

/// Why a moved repository's carry could not be made: what holds it, the folder that did not
/// resolve when one did not, and the cause. Each opener of a capture folder that carry names is
/// refused with it, and the mount's health carries it as [`CapturesHeld`].
#[derive(Clone, Debug)]
pub(crate) struct CaptureCarryUnmade {
    /// What holds it.
    cause: CapturesHeldCause,
    /// The folder that did not resolve, none when the record did not read.
    folder: Option<PathBuf>,
    /// The error underneath.
    source: Arc<dyn Error + Send + Sync>,
}

impl CaptureCarryUnmade {
    /// The refusal of a carry whose folder `unresolved` did not resolve: `accessDenied` when the
    /// service may not read it, `folderUnresolved` otherwise.
    fn unresolved(unresolved: UnresolvedFolder) -> Self {
        let cause = if unresolved.source.kind() == io::ErrorKind::PermissionDenied {
            CapturesHeldCause::AccessDenied
        } else {
            CapturesHeldCause::FolderUnresolved
        };
        Self {
            cause,
            folder: Some(unresolved.folder.clone()),
            source: Arc::new(unresolved),
        }
    }

    /// The refusal of a carry whose mount's record of its folders, `unread`, did not read.
    fn unread(unread: serde_json::Error) -> Self {
        Self {
            cause: CapturesHeldCause::RecordUnreadable,
            folder: None,
            source: Arc::new(unread),
        }
    }

    // The fact the mount's health carries; a folder too long for the wire is logged and left out.
    fn captures_held(&self) -> CapturesHeld {
        let folder = self.folder.as_ref().and_then(|folder| {
            FilesystemPath::new(folder.to_string_lossy().into_owned())
                .inspect_err(|error| {
                    tracing::warn!(
                        folder = %folder.display(),
                        error = error as &(dyn Error + 'static),
                        "a held carry's folder does not fit the wire, so its hold names none"
                    );
                })
                .ok()
        });
        CapturesHeld {
            cause: self.cause,
            folder,
        }
    }
}

impl fmt::Display for CaptureCarryUnmade {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .write_str("the moved repository's captures could not be carried to its new folder")
    }
}

impl Error for CaptureCarryUnmade {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&*self.source)
    }
}

/// The carries this daemon run holds pending, each for its mount, from before its move's write
/// until the write that ends it: a capture folder named for an end of one opens only once its
/// owner's folder is renamed to the newest name, one named for a carry whose move's write is out
/// waits for that write's end, and one a carry that could not be made names is refused until an
/// opener's ask makes it.
#[derive(Debug, Default)]
pub(crate) struct CaptureCarries {
    /// The carries pending, made or not, and the ones an ask made that wait for their run.
    pending: Mutex<PendingCarries>,
    /// Raised when an ask made a carry, so the carry's runner takes it.
    lift_notice: tokio::sync::Notify,
}

// The pending carries.
#[derive(Debug, Default)]
struct PendingCarries {
    // The carries made, each written carry the one chain of its mount's moves.
    made: Vec<HeldCarry>,
    // The carries that could not be made.
    unmade: Vec<Arc<UnmadeCarry>>,
    // The carries an ask made, each with its mount, until the carry's runner takes them.
    lifted: Vec<(RepoMountId, CaptureCarry)>,
}

// A pending carry of a mount, and while its move's write is out, that write.
#[derive(Debug)]
struct HeldCarry {
    repo_mount_id: RepoMountId,
    carry: CaptureCarry,
    write: Option<MoveWrite>,
}

// A move's write still out: the mount it ends, whose carry it takes forward, that mount's common
// folder's name, and the lock it holds until it ends.
#[derive(Debug)]
struct MoveWrite {
    replaced_repo_mount_id: RepoMountId,
    replaced_name: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

/// A moved repository's carry that could not be made, held for its mount, which refuses each
/// opener of a folder it names with its cause until an ask makes it.
#[derive(Debug)]
pub(crate) struct UnmadeCarry {
    // The mount it is a carry of.
    repo_mount_id: RepoMountId,
    // The record's old common folders, oldest first; `None` for a record that did not read, whose
    // old folders are unknown, so no ask tries it again.
    moved_from: Option<Vec<PathBuf>>,
    // The newest common folder; `None` for a mount whose stored folder did not read.
    moved_to: Option<PathBuf>,
    // The names of the folders that resolved.
    names: Vec<String>,
    // The cause it refuses with, and how many asks tried it.
    failure: Mutex<(CaptureCarryUnmade, u64)>,
    // Held by the ask trying it, so the openers that ask at once share one try.
    ask: tokio::sync::Mutex<()>,
}

impl UnmadeCarry {
    // The carry of `repo_mount_id` from `moved_from` to `moved_to` that `cause` kept from being
    // made, naming each of its folders that resolves; one that does not resolve names nothing,
    // since no opener's path resolves to it either.
    async fn new(
        repo_mount_id: RepoMountId,
        moved_from: Option<Vec<PathBuf>>,
        moved_to: Option<PathBuf>,
        cause: CaptureCarryUnmade,
    ) -> Self {
        let mut names: Vec<String> = Vec::new();
        for folder in moved_to.iter().chain(moved_from.iter().flatten()) {
            if let Ok(name) = real_path_name(folder).await
                && !names.contains(&name)
            {
                names.push(name);
            }
        }
        Self {
            repo_mount_id,
            moved_from,
            moved_to,
            names,
            failure: Mutex::new((cause, 0)),
            ask: tokio::sync::Mutex::new(()),
        }
    }

    // Whether `folder` is, by its path, a common folder the carry names.
    fn holds_folder(&self, folder: &Path) -> bool {
        self.moved_to
            .iter()
            .chain(self.moved_from.iter().flatten())
            .any(|held| components_equal(folder, held))
    }

    // Whether `name` is the name of a folder the carry names.
    fn holds_name(&self, name: &str) -> bool {
        self.names.iter().any(|held| held == name)
    }
}

// What an opener finds pending for a capture folder name.
pub(super) enum PendingCarry {
    // A carry whose write committed, to carry before opening.
    Written(CaptureCarry),
    // The lock of a move's write still out, to wait on before looking again.
    Awaited(Arc<tokio::sync::Mutex<()>>),
    // A carry that could not be made, to ask of before looking again.
    Unmade(Arc<UnmadeCarry>),
}

/// What a move's committed write left of the carry it takes forward.
pub(crate) enum WrittenCarry {
    /// The chain the move runs: its own carry with every made carry of the mount it ended.
    Made(CaptureCarry),
    /// The ended mount's carry that could not be made, taken onto the new mount with the move's
    /// folders, for the move to [`make`](CaptureCarries::make).
    Unmade(Arc<UnmadeCarry>),
}

impl CaptureCarries {
    /// Holds pending the carry of the mount `repo_mount_id`, whose move's write committed in an
    /// earlier run, from each of the record's old common folders `moved_from`, oldest first, to its
    /// stored common folder `moved_to`, and answers it. A carry that renames nothing is never
    /// held, since no folder waits for it. A record or a stored folder that did not read, or a
    /// folder that does not resolve, holds the carry unmade, and that cause is answered: each
    /// opener of a folder it names is refused with its cause until an ask makes it, which one with
    /// a folder that did not read never is.
    pub(crate) async fn expect_record(
        &self,
        repo_mount_id: RepoMountId,
        moved_from: Result<Vec<PathBuf>, serde_json::Error>,
        moved_to: Result<PathBuf, serde_json::Error>,
    ) -> Result<CaptureCarry, CaptureCarryUnmade> {
        let (moved_from, moved_to, cause) = match (moved_from, moved_to) {
            (Ok(moved_from), Ok(moved_to)) => match CaptureCarry::new(&moved_from, &moved_to).await
            {
                Ok(carry) => {
                    Self::hold_made(&mut lock(&self.pending), repo_mount_id, carry.clone());
                    return Ok(carry);
                }
                Err(unresolved) => (
                    Some(moved_from),
                    Some(moved_to),
                    CaptureCarryUnmade::unresolved(unresolved),
                ),
            },
            (moved_from, Err(unread)) => {
                (moved_from.ok(), None, CaptureCarryUnmade::unread(unread))
            }
            (Err(unread), Ok(moved_to)) => {
                (None, Some(moved_to), CaptureCarryUnmade::unread(unread))
            }
        };
        let unmade = UnmadeCarry::new(repo_mount_id, moved_from, moved_to, cause.clone()).await;
        lock(&self.pending).unmade.push(Arc::new(unmade));
        Err(cause)
    }

    /// Holds `carry` pending for the mount `repo_mount_id` while the write of its move, which ends
    /// the mount `replaced_repo_mount_id` whose common folder is `replaced_folder`, named
    /// `replaced_name`, is out: a capture folder named for an end of it, or of a carry of the ended
    /// mount, waits until the answer is written or dropped, so nothing is renamed for a write that
    /// is refused.
    pub(crate) fn expect_write(
        &self,
        replaced_repo_mount_id: RepoMountId,
        replaced_folder: PathBuf,
        replaced_name: String,
        repo_mount_id: RepoMountId,
        carry: CaptureCarry,
    ) -> CaptureCarryWrite<'_> {
        let write_lock = Arc::new(tokio::sync::Mutex::new(()));
        let hold = Arc::clone(&write_lock)
            .try_lock_owned()
            .expect("a lock no one else holds yet is free");
        lock(&self.pending).made.push(HeldCarry {
            repo_mount_id,
            carry: carry.clone(),
            write: Some(MoveWrite {
                replaced_repo_mount_id,
                replaced_name,
                lock: Arc::clone(&write_lock),
            }),
        });
        CaptureCarryWrite {
            carries: self,
            carry,
            replaced_repo_mount_id,
            replaced_folder,
            repo_mount_id,
            write: Some((write_lock, hold)),
        }
    }

    /// Ends every written carry `carry` covers, once the rows name the newest folder.
    pub(crate) fn finish(&self, carry: &CaptureCarry) {
        lock(&self.pending)
            .made
            .retain(|held| held.write.is_some() || !carry.covers(&held.carry));
    }

    /// The carries an opener's ask made since the last call, each with its mount, waiting until
    /// there is one.
    pub(crate) async fn next_lifted(&self) -> Vec<(RepoMountId, CaptureCarry)> {
        loop {
            let lifted = std::mem::take(&mut lock(&self.pending).lifted);
            if !lifted.is_empty() {
                return lifted;
            }
            self.lift_notice.notified().await;
        }
    }

    /// What holds the captures of the mount `repo_mount_id`, while its carry could not be made.
    pub(crate) fn captures_held(&self, repo_mount_id: RepoMountId) -> Option<CapturesHeld> {
        let unmade = lock(&self.pending)
            .unmade
            .iter()
            .find(|unmade| unmade.repo_mount_id == repo_mount_id)
            .cloned()?;
        let held = lock(&unmade.failure).0.captures_held();
        Some(held)
    }

    /// Tries `unmade` again, one try shared by every caller that asks while it runs, and answers
    /// the carry when this try made it, now held as a written carry; `None` when it was made or
    /// taken forward meanwhile. Fails with the fresh cause when it still cannot be made, and with
    /// its cause when its record or its stored folder did not read, which leaves nothing to try.
    pub(crate) async fn make(&self, unmade: &Arc<UnmadeCarry>) -> io::Result<Option<CaptureCarry>> {
        let asked = lock(&unmade.failure).1;
        let _turn = unmade.ask.lock().await;
        let (cause, tries) = lock(&unmade.failure).clone();
        let is_pending = lock(&self.pending)
            .unmade
            .iter()
            .any(|other| Arc::ptr_eq(other, unmade));
        if !is_pending {
            return Ok(None);
        }
        let (Some(moved_from), Some(moved_to)) = (
            unmade.moved_from.as_deref().filter(|_| tries == asked),
            unmade.moved_to.as_deref(),
        ) else {
            return Err(io::Error::other(cause));
        };
        match CaptureCarry::new(moved_from, moved_to).await {
            Ok(carry) => {
                let mut pending = lock(&self.pending);
                pending.unmade.retain(|other| !Arc::ptr_eq(other, unmade));
                Self::hold_made(&mut pending, unmade.repo_mount_id, carry.clone());
                Ok(Some(carry))
            }
            Err(unresolved) => {
                let cause = CaptureCarryUnmade::unresolved(unresolved);
                *lock(&unmade.failure) = (cause.clone(), tries + 1);
                Err(io::Error::other(cause))
            }
        }
    }

    // Holds the written `carry` of the mount `repo_mount_id` in place of every written carry it
    // covers, unless it renames nothing.
    fn hold_made(pending: &mut PendingCarries, repo_mount_id: RepoMountId, carry: CaptureCarry) {
        if !carry.is_rename() {
            return;
        }
        pending
            .made
            .retain(|held| held.write.is_some() || !carry.covers(&held.carry));
        pending.made.push(HeldCarry {
            repo_mount_id,
            carry,
            write: None,
        });
    }

    // What is pending for the capture folder name `name`: the lock of a move's write still out
    // that it waits on, or else the unmade or written carry it is an end of.
    pub(super) fn pending(&self, name: &str) -> Option<PendingCarry> {
        let pending = lock(&self.pending);
        let is_written_on = |replaced_repo_mount_id: RepoMountId| {
            pending.made.iter().any(|held| {
                held.write.is_none()
                    && held.repo_mount_id == replaced_repo_mount_id
                    && held.carry.holds_name(name)
            }) || pending.unmade.iter().any(|unmade| {
                unmade.repo_mount_id == replaced_repo_mount_id && unmade.holds_name(name)
            })
        };
        let awaited = pending.made.iter().find_map(|held| {
            let write = held.write.as_ref()?;
            (held.carry.holds_name(name)
                || write.replaced_name == name
                || is_written_on(write.replaced_repo_mount_id))
            .then(|| Arc::clone(&write.lock))
        });
        if let Some(write_lock) = awaited {
            return Some(PendingCarry::Awaited(write_lock));
        }
        if let Some(unmade) = pending.unmade.iter().find(|unmade| unmade.holds_name(name)) {
            return Some(PendingCarry::Unmade(Arc::clone(unmade)));
        }
        pending
            .made
            .iter()
            .find(|held| held.write.is_none() && held.carry.holds_name(name))
            .map(|held| PendingCarry::Written(held.carry.clone()))
    }

    // The unmade carry naming the common folder `folder` by its path.
    pub(super) fn unmade_at(&self, folder: &Path) -> Option<Arc<UnmadeCarry>> {
        lock(&self.pending)
            .unmade
            .iter()
            .find(|unmade| unmade.holds_folder(folder))
            .cloned()
    }

    // Tries `unmade` again for an opener as `make` does. Made now, it is handed to the carry's
    // runner, and the opener looks again; still unmade, the opener is refused with the cause.
    pub(super) async fn ask(&self, unmade: &Arc<UnmadeCarry>) -> io::Result<()> {
        if let Some(carry) = self.make(unmade).await? {
            lock(&self.pending)
                .lifted
                .push((unmade.repo_mount_id, carry));
            self.lift_notice.notify_one();
        }
        Ok(())
    }

    // Takes the move's write `write_lock` names out of the pending carries.
    fn remove_write(pending: &mut PendingCarries, write_lock: &Arc<tokio::sync::Mutex<()>>) {
        pending.made.retain(|held| {
            !held
                .write
                .as_ref()
                .is_some_and(|write| Arc::ptr_eq(&write.lock, write_lock))
        });
    }
}

/// A move's carry held pending while its write is out. [`written`](Self::written) once the write
/// commits; dropped otherwise, which withdraws it. Either way an opener waiting on it looks again
/// only once the pending carries say what the write did.
pub(crate) struct CaptureCarryWrite<'a> {
    /// The pending carries it is held in.
    carries: &'a CaptureCarries,
    /// The move's own carry.
    carry: CaptureCarry,
    /// The mount the move ends.
    replaced_repo_mount_id: RepoMountId,
    /// That mount's common folder, which the move's write appends to the record it takes forward.
    replaced_folder: PathBuf,
    /// The mount the move makes.
    repo_mount_id: RepoMountId,
    /// The write's lock and its hold, until the write's end is known.
    write: Option<(Arc<tokio::sync::Mutex<()>>, OwnedMutexGuard<()>)>,
}

impl CaptureCarryWrite<'_> {
    /// Ends the wait as the move's write committed, taking the ended mount's carry onto the new
    /// mount, as the write took its record forward. An unmade one whose old folders are known stays
    /// unmade, its record now the write's, the ended mount's folder after its old ones, and is
    /// answered for the move to make; one whose record did not read ends, its old folders unknown. A written one is taken into the move's
    /// own carry, and the chain is held pending as one written carry unless it renames nothing,
    /// and answered.
    pub(crate) fn written(mut self) -> WrittenCarry {
        let write = self.write.take();
        let mut pending = lock(&self.carries.pending);
        if let Some((write_lock, _)) = &write {
            CaptureCarries::remove_write(&mut pending, write_lock);
        }
        let replaced_repo_mount_id = self.replaced_repo_mount_id;
        let mut taken_unmade = None;
        pending.unmade.retain(|unmade| {
            let is_taken = unmade.repo_mount_id == replaced_repo_mount_id;
            if is_taken {
                taken_unmade = Some(Arc::clone(unmade));
            }
            !is_taken
        });
        if let Some(unmade) = taken_unmade
            && let Some(moved_from) = &unmade.moved_from
        {
            let mut names = unmade.names.clone();
            for name in self.carry.old_names.iter().chain([&self.carry.new_name]) {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
            let chain = Arc::new(UnmadeCarry {
                repo_mount_id: self.repo_mount_id,
                moved_from: Some(
                    moved_from
                        .iter()
                        .chain([&self.replaced_folder])
                        .cloned()
                        .collect(),
                ),
                moved_to: Some(self.carry.moved_to.clone()),
                names,
                failure: Mutex::new((lock(&unmade.failure).0.clone(), 0)),
                ask: tokio::sync::Mutex::new(()),
            });
            pending.unmade.push(Arc::clone(&chain));
            drop(pending);
            drop(write);
            return WrittenCarry::Unmade(chain);
        }
        let mut old_names = Vec::new();
        pending.made.retain(|held| {
            let is_taken = held.write.is_none() && held.repo_mount_id == replaced_repo_mount_id;
            if is_taken {
                old_names.extend(held.carry.old_names.iter().cloned());
                old_names.push(held.carry.new_name.clone());
            }
            !is_taken
        });
        old_names.extend(self.carry.old_names.iter().cloned());
        let mut chain_names: Vec<String> = Vec::with_capacity(old_names.len());
        for name in old_names {
            if name != self.carry.new_name && !chain_names.contains(&name) {
                chain_names.push(name);
            }
        }
        let chain = CaptureCarry {
            old_names: chain_names,
            new_name: self.carry.new_name.clone(),
            moved_to: self.carry.moved_to.clone(),
        };
        CaptureCarries::hold_made(&mut pending, self.repo_mount_id, chain.clone());
        drop(pending);
        // Released only now, so an opener waiting on the write finds the chain.
        drop(write);
        WrittenCarry::Made(chain)
    }
}

impl Drop for CaptureCarryWrite<'_> {
    fn drop(&mut self) {
        if let Some((write_lock, hold)) = self.write.take() {
            CaptureCarries::remove_write(&mut lock(&self.carries.pending), &write_lock);
            drop(hold);
        }
    }
}

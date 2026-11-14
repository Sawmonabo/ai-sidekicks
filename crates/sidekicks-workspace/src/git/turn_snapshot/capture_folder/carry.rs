//! A moved repository's carry: its capture folders renamed from each old common folder's name to
//! the newest one's, and the carries this daemon run holds pending, made or not, until the write
//! that ends each.

use std::error::Error;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    /// is no old one. Fails as resolving a path does.
    pub(crate) async fn new(moved_from: &[PathBuf], moved_to: &Path) -> io::Result<Self> {
        let new_name = real_path_name(moved_to).await?;
        let mut old_names: Vec<String> = Vec::with_capacity(moved_from.len());
        for folder in moved_from {
            let name = real_path_name(folder).await?;
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

/// Why a moved repository's carry could not be made: its record did not read, or a folder it names
/// did not resolve. Each opener of a capture folder that carry names is refused with it.
#[derive(Clone, Debug)]
pub(crate) struct CaptureCarryUnmade(Arc<dyn Error + Send + Sync>);

impl CaptureCarryUnmade {
    /// The refusal whose cause is `cause`.
    pub(crate) fn new(cause: impl Error + Send + Sync + 'static) -> Self {
        Self(Arc::new(cause))
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
        Some(&*self.0)
    }
}

/// The carries this daemon run holds pending, each from before its move's write until the write
/// that ends it: a capture folder named for an end of one opens only once its owner's folder is
/// renamed to the newest name, one named for a carry whose move's write is out waits for that
/// write's end, and one a carry that could not be made names is refused until an opener's ask
/// makes it.
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
    // The carries made, each written carry the one chain of its repository's moves.
    made: Vec<HeldCarry>,
    // The carries that could not be made.
    unmade: Vec<Arc<UnmadeCarry>>,
    // The carries an ask made, until the carry's runner takes them.
    lifted: Vec<CaptureCarry>,
}

// A pending carry, and while its move's write is out, that write.
#[derive(Debug)]
struct HeldCarry {
    carry: CaptureCarry,
    write: Option<MoveWrite>,
}

// A move's write still out: the name of the common folder of the mount it ends, whose written
// carry it takes forward, and the lock it holds until it ends.
#[derive(Debug)]
struct MoveWrite {
    replaced_name: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

// A moved repository's carry that could not be made, which refuses each opener of a folder it
// names with its cause until an ask makes it.
#[derive(Debug)]
pub(super) struct UnmadeCarry {
    // The record's old common folders, oldest first; `None` for a record that did not read, whose
    // old folders are unknown, so no ask tries it again.
    moved_from: Option<Vec<PathBuf>>,
    // The newest common folder.
    moved_to: PathBuf,
    // The newest common folder's name, when it resolved.
    new_name: Option<String>,
    // The names of the folders that resolved, the newest's among them.
    names: Vec<String>,
    // The cause it refuses with, and how many asks tried it.
    failure: Mutex<(CaptureCarryUnmade, u64)>,
    // Held by the ask trying it, so the openers that ask at once share one try.
    ask: tokio::sync::Mutex<()>,
}

impl UnmadeCarry {
    // The carry from `moved_from` to `moved_to` that `cause` kept from being made, naming each of
    // its folders that resolves; one that does not resolve names nothing, since no opener's path
    // resolves to it either.
    async fn new(
        moved_from: Option<Vec<PathBuf>>,
        moved_to: PathBuf,
        cause: CaptureCarryUnmade,
    ) -> Self {
        let new_name = real_path_name(&moved_to).await.ok();
        let mut names: Vec<String> = new_name.iter().cloned().collect();
        for folder in moved_from.iter().flatten() {
            if let Ok(name) = real_path_name(folder).await
                && !names.contains(&name)
            {
                names.push(name);
            }
        }
        Self {
            moved_from,
            moved_to,
            new_name,
            names,
            failure: Mutex::new((cause, 0)),
            ask: tokio::sync::Mutex::new(()),
        }
    }

    // Whether `folder` is, by its path, a common folder the carry names: only the newest when the
    // record did not read.
    fn holds_folder(&self, folder: &Path) -> bool {
        components_equal(folder, &self.moved_to)
            || self
                .moved_from
                .iter()
                .flatten()
                .any(|old| components_equal(folder, old))
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

impl CaptureCarries {
    /// Holds pending the carry of a moved repository whose move's write committed in an earlier
    /// run, from each of the record's old common folders `moved_from`, oldest first, to
    /// `moved_to`, and answers it. A carry that renames nothing is never held, since no folder
    /// waits for it. A record that did not read, or a folder that does not resolve, holds the
    /// carry unmade, and that cause is answered: each opener of a folder it names is refused with
    /// its cause until an opener's ask makes it, which a record that did not read never is.
    pub(crate) async fn expect_record(
        &self,
        moved_from: Result<Vec<PathBuf>, CaptureCarryUnmade>,
        moved_to: &Path,
    ) -> Result<CaptureCarry, CaptureCarryUnmade> {
        let (moved_from, cause) = match moved_from {
            Ok(moved_from) => match CaptureCarry::new(&moved_from, moved_to).await {
                Ok(carry) => {
                    Self::hold_made(&mut lock(&self.pending), carry.clone());
                    return Ok(carry);
                }
                Err(unresolved) => (Some(moved_from), CaptureCarryUnmade::new(unresolved)),
            },
            Err(unread) => (None, unread),
        };
        let unmade = UnmadeCarry::new(moved_from, moved_to.to_path_buf(), cause.clone()).await;
        lock(&self.pending).unmade.push(Arc::new(unmade));
        Err(cause)
    }

    /// Holds `carry` pending while the write of its move, which ends the mount whose common folder
    /// is named `replaced_name`, is out: a capture folder named for an end of it, or of the carry
    /// ending at `replaced_name`, waits until the answer is written or dropped, so nothing is
    /// renamed for a write that is refused.
    pub(crate) fn expect_write(
        &self,
        replaced_name: String,
        carry: CaptureCarry,
    ) -> CaptureCarryWrite<'_> {
        let write_lock = Arc::new(tokio::sync::Mutex::new(()));
        let hold = Arc::clone(&write_lock)
            .try_lock_owned()
            .expect("a lock no one else holds yet is free");
        lock(&self.pending).made.push(HeldCarry {
            carry: carry.clone(),
            write: Some(MoveWrite {
                replaced_name: replaced_name.clone(),
                lock: Arc::clone(&write_lock),
            }),
        });
        CaptureCarryWrite {
            carries: self,
            carry,
            replaced_name,
            write: Some((write_lock, hold)),
        }
    }

    /// Ends every written carry `carry` covers, once the rows name the newest folder.
    pub(crate) fn finish(&self, carry: &CaptureCarry) {
        lock(&self.pending)
            .made
            .retain(|held| held.write.is_some() || !carry.covers(&held.carry));
    }

    /// The carries an opener's ask made since the last call, waiting until there is one.
    pub(crate) async fn next_lifted(&self) -> Vec<CaptureCarry> {
        loop {
            let lifted = std::mem::take(&mut lock(&self.pending).lifted);
            if !lifted.is_empty() {
                return lifted;
            }
            self.lift_notice.notified().await;
        }
    }

    // Holds the written `carry` in place of every written carry it covers, unless it renames
    // nothing.
    fn hold_made(pending: &mut PendingCarries, carry: CaptureCarry) {
        if !carry.is_rename() {
            return;
        }
        pending
            .made
            .retain(|held| held.write.is_some() || !carry.covers(&held.carry));
        pending.made.push(HeldCarry { carry, write: None });
    }

    // What is pending for the capture folder name `name`: the lock of a move's write still out
    // that it waits on, or else the unmade or written carry it is an end of.
    pub(super) fn pending(&self, name: &str) -> Option<PendingCarry> {
        let pending = lock(&self.pending);
        let is_written_on = |replaced_name: &str| {
            pending.made.iter().any(|held| {
                held.write.is_none()
                    && held.carry.new_name == replaced_name
                    && held.carry.holds_name(name)
            }) || pending.unmade.iter().any(|unmade| {
                unmade.new_name.as_deref() == Some(replaced_name) && unmade.holds_name(name)
            })
        };
        let awaited = pending.made.iter().find_map(|held| {
            let write = held.write.as_ref()?;
            (held.carry.holds_name(name)
                || write.replaced_name == name
                || is_written_on(&write.replaced_name))
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

    // Tries `unmade` again for an opener, one try shared by every opener that asks while it runs.
    // Made now, it is held as a written carry and handed to the carry's runner, and the opener
    // looks again; still unmade, the opener is refused with the fresh cause. One whose record did
    // not read has nothing to try and refuses with its cause. One no longer pending was made or
    // taken forward meanwhile, so the opener looks again.
    pub(super) async fn ask(&self, unmade: &Arc<UnmadeCarry>) -> io::Result<()> {
        let asked = lock(&unmade.failure).1;
        let _turn = unmade.ask.lock().await;
        let (cause, tries) = lock(&unmade.failure).clone();
        let is_pending = lock(&self.pending)
            .unmade
            .iter()
            .any(|other| Arc::ptr_eq(other, unmade));
        if !is_pending {
            return Ok(());
        }
        let Some(moved_from) = unmade.moved_from.as_deref().filter(|_| tries == asked) else {
            return Err(io::Error::other(cause));
        };
        match CaptureCarry::new(moved_from, &unmade.moved_to).await {
            Ok(carry) => {
                let mut pending = lock(&self.pending);
                pending.unmade.retain(|other| !Arc::ptr_eq(other, unmade));
                Self::hold_made(&mut pending, carry.clone());
                pending.lifted.push(carry);
                drop(pending);
                self.lift_notice.notify_one();
                Ok(())
            }
            Err(unresolved) => {
                let cause = CaptureCarryUnmade::new(unresolved);
                *lock(&unmade.failure) = (cause.clone(), tries + 1);
                Err(io::Error::other(cause))
            }
        }
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
    /// The name of the ended mount's common folder.
    replaced_name: String,
    /// The write's lock and its hold, until the write's end is known.
    write: Option<(Arc<tokio::sync::Mutex<()>>, OwnedMutexGuard<()>)>,
}

impl CaptureCarryWrite<'_> {
    /// Ends the wait as the move's write committed, taking forward the carry ending at the ended
    /// mount's name, as the write took its record forward. A written one is taken into this one,
    /// and the chain is held pending as one written carry unless it renames nothing, and answered:
    /// the carry the move runs. An unmade one whose old folders are known stays unmade, carrying
    /// the move's folders too, and `None` is answered, since its carry waits for an opener's ask;
    /// one whose record did not read ends, its old folders unknown.
    pub(crate) fn written(mut self) -> Option<CaptureCarry> {
        let write = self.write.take();
        let mut pending = lock(&self.carries.pending);
        if let Some((write_lock, _)) = &write {
            CaptureCarries::remove_write(&mut pending, write_lock);
        }
        let mut taken_unmade = None;
        pending.unmade.retain(|unmade| {
            let is_taken = unmade.new_name.as_deref() == Some(self.replaced_name.as_str());
            if is_taken {
                taken_unmade = Some(Arc::clone(unmade));
            }
            !is_taken
        });
        if let Some(unmade) = taken_unmade
            && let Some(moved_from) = &unmade.moved_from
        {
            let mut names = unmade.names.clone();
            if !names.contains(&self.carry.new_name) {
                names.push(self.carry.new_name.clone());
            }
            let chain = UnmadeCarry {
                moved_from: Some(
                    moved_from
                        .iter()
                        .chain([&unmade.moved_to])
                        .cloned()
                        .collect(),
                ),
                moved_to: self.carry.moved_to.clone(),
                new_name: Some(self.carry.new_name.clone()),
                names,
                failure: Mutex::new((lock(&unmade.failure).0.clone(), 0)),
                ask: tokio::sync::Mutex::new(()),
            };
            pending.unmade.push(Arc::new(chain));
            drop(pending);
            drop(write);
            return None;
        }
        let mut old_names = Vec::new();
        pending.made.retain(|held| {
            let is_taken = held.write.is_none() && held.carry.new_name == self.replaced_name;
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
        CaptureCarries::hold_made(&mut pending, chain.clone());
        drop(pending);
        // Released only now, so an opener waiting on the write finds the chain.
        drop(write);
        Some(chain)
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

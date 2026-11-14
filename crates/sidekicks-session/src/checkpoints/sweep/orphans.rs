//! The sweep's walk of each session's orphaned copies and clones, those a crash or a failed step
//! left behind with no row naming them: in the session's copies folder, its large files' folder,
//! each of its folders on other volumes and the folders a backup's restore put its clones in,
//! every file of the store's naming that no row names is removed once it is an hour old. The
//! folders are listed with no lock; only the names' second read and the removal of what is still
//! unnamed run under the session's copies lock held exclusive, so no keeper is between keeping a
//! file and naming it and no edit waits out a listing. The first walk of a daemon run walks every
//! session with a checkpoint; each later one walks only the sessions active since the walk before
//! it, those it marked to walk again for a file too young to go or a step that failed, and those
//! a keeper's row write failed for.

use std::collections::{BTreeSet, HashSet};
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use jiff::{SignedDuration, Timestamp};
use rusqlite::{Connection, OptionalExtension as _, params};
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_platforms::entry_changed_at;
use sidekicks_std::missing_entry::{MissingEntry as _, is_gone};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::database::stored_column::text_column;
use tokio_util::sync::CancellationToken;

use super::{CheckpointSweep, CheckpointSweepCounts, CheckpointSweepError};
use crate::checkpoints::copies::{
    COPIES_LOCK, copies_folder, is_copy_temporary, take_unnamed_keep_sessions,
};
use crate::checkpoints::shadows::large_folder;
use crate::checkpoints::store::copy_hashes;
use crate::checkpoints::store::shadows::{VolumeFolder, cloned_shadow_ids, volume_folders};
use crate::checkpoints::volume_folders::{
    VolumeFolderState, read_volume_folder_state, restored_clones_folder,
};

/// How long since its last change a file no row names waits before it is taken for an orphan.
/// Every copy keeper holds the copies lock until its row is written, so only a command window's
/// clone, taken at its open with no lock, rests on this age between its making and its row.
const ORPHAN_AGE: Duration = Duration::from_hours(1);

/// How far before the previous walk's start a session's last activity still has it walked, past
/// any lag between an activity's time and its row's write.
const ACTIVITY_GRACE: SignedDuration = SignedDuration::from_mins(5);

// The walk's start on the database clock, which every session's last activity is written by.
static WALK_START_SQL: LazyLock<String> = LazyLock::new(|| format!("SELECT {DATABASE_NOW_SQL}"));

// Every session with a checkpoint, with a session row or not, for a daemon run's first walk; a
// session marked for its purge is left to the purge, which removes its folders whole.
static WALKABLE_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT checkpoints.session_id
  FROM session_checkpoints AS checkpoints
  LEFT JOIN sessions ON sessions.id = checkpoints.session_id
 WHERE sessions.state IS NULL OR sessions.state <> '{}'",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

// The sessions active at or after `?1` that hold a checkpoint, none marked for its purge: one pass
// over the sessions and one probe of each one's checkpoints, never a read of every checkpoint row.
static ACTIVE_WALKABLE_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sessions.id
  FROM sessions
 WHERE julianday(sessions.last_activity_at) >= julianday(?1)
   AND sessions.state <> '{}'
   AND EXISTS (SELECT 1 FROM session_checkpoints AS checkpoints
                WHERE checkpoints.session_id = sessions.id)",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

// Whether the session `?1` holds a checkpoint and is not marked for its purge, for a session marked
// to walk again whatever its activity.
static IS_WALKABLE_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1
 WHERE EXISTS (SELECT 1 FROM session_checkpoints WHERE session_id = ?1)
   AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND state = '{}')",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

/// What the sweep keeps from one orphans walk to the next.
#[derive(Default)]
pub(super) struct OrphanWalks {
    memory: Mutex<WalkMemory>,
}

/// The previous whole walk's start and the sessions to walk again whatever their activity.
#[derive(Default)]
struct WalkMemory {
    /// `None` until a walk of this daemon run went through, so the next walks every session.
    previous_walk_start: Option<Timestamp>,
    /// The sessions a walk marked for a file too young to go, or whose walk failed, and those a
    /// keeper's row write failed for.
    walk_again: HashSet<SessionId>,
}

/// One session's listing, made with no lock.
#[derive(Debug, Default)]
struct SessionListing {
    /// The files of the store's naming looked at, named or not.
    entries_examined: u64,
    /// The unnamed files old enough to go, as the listing found them.
    candidates: Vec<OrphanCandidate>,
    /// Whether an orphan was too young to go, or a step failed and was passed over.
    should_walk_again: bool,
}

/// A file the listing found unnamed and an hour old.
#[derive(Debug)]
struct OrphanCandidate {
    path: PathBuf,
    place: PlaceNaming,
}

/// How a place's files are named by the rows.
#[derive(Clone, Copy, Debug)]
enum PlaceNaming {
    /// The copies folder: a copy by its hash, or a copy's temporary.
    Copy,
    /// A folder of clones, each named by its shadow's id.
    Clone,
}

/// The removal of a session's candidates, under its copies lock.
#[derive(Debug, Default)]
struct SessionRemoval {
    /// The orphans removed.
    entries_removed: u64,
    /// Whether a removal failed and was passed over.
    has_failed: bool,
}

/// The names a session's rows hold.
struct KeptNames {
    /// The hash of every copy a version names.
    copies: HashSet<String>,
    /// The id of every shadow that kept a clone.
    clones: HashSet<String>,
    /// The session's own folders on other volumes.
    volume_folders: Vec<VolumeFolder>,
}

/// How a session's walk ended: walked, the session to walk again or not, or cut by the stop.
enum SessionWalkEnd {
    Walked { should_walk_again: bool },
    Stopped,
}

impl CheckpointSweep {
    /// Walks each session due a walk for its orphans, counting each walked session and its files
    /// into `counts`. A walk `stop` cuts leaves the previous walk's start, so the next walk takes
    /// every session this one did not reach. Fails with the first read that failed, once every
    /// session was walked; a session whose read or walk failed is walked again next time.
    pub(super) async fn walk_orphans(
        &self,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<(), CheckpointSweepError> {
        let (previous_walk_start, walk_again) = {
            let mut memory = lock(&self.orphan_walks.memory);
            memory.walk_again.extend(take_unnamed_keep_sessions());
            (memory.previous_walk_start, memory.walk_again.clone())
        };
        let active_since = previous_walk_start
            .map(|start| start.checked_sub(ACTIVITY_GRACE).unwrap_or(Timestamp::MIN));
        let read_meter = meter.clone();
        let (walk_start, due) = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_meter
                    .measure(|| read_due_sessions(reader, active_since, &walk_again))
                    .map_err(CheckpointSweepError::from)
            })
            .await?;
        let mut next_walk_again = HashSet::new();
        let mut is_whole = true;
        let mut failure = None;
        for session_id in due {
            if stop.is_cancelled() {
                is_whole = false;
                break;
            }
            match self
                .walk_session_orphans(session_id, stop, meter, counts)
                .await
            {
                Ok(SessionWalkEnd::Walked { should_walk_again }) => {
                    if should_walk_again {
                        next_walk_again.insert(session_id);
                    }
                }
                Ok(SessionWalkEnd::Stopped) => {
                    is_whole = false;
                    break;
                }
                Err(error) => {
                    next_walk_again.insert(session_id);
                    failure.get_or_insert(error);
                }
            }
        }
        let mut memory = lock(&self.orphan_walks.memory);
        if is_whole {
            memory.previous_walk_start = Some(walk_start);
            memory.walk_again = next_walk_again;
        } else {
            memory.walk_again.extend(next_walk_again);
        }
        failure.map_or(Ok(()), Err)
    }

    // Lists `session_id`'s places with no lock, then, when the listing found an orphan, takes its
    // copies lock exclusive, reads its names again and removes each one still unnamed. Fails when
    // its names do not read; a failed step is logged and the session walked again.
    async fn walk_session_orphans(
        &self,
        session_id: SessionId,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<SessionWalkEnd, CheckpointSweepError> {
        let names = self.read_kept_names(session_id, meter).await?;
        let owner_folder = session_storage_folder(&self.deps.data_folder, &session_id);
        let restored_folder = restored_clones_folder(&self.deps.data_folder, &session_id);
        let now = self.deps.clock.now();
        let listed = meter
            .run_blocking(move || {
                list_session(session_id, &owner_folder, &restored_folder, &names, now)
            })
            .await;
        let listing = match listed {
            Ok(listing) => listing,
            Err(ended) => {
                counts.sessions_walked += 1;
                tracing::warn!(
                    %session_id,
                    error = &ended as &(dyn Error + 'static),
                    "a session's orphans walk ended before it finished"
                );
                return Ok(SessionWalkEnd::Walked {
                    should_walk_again: true,
                });
            }
        };
        counts.sessions_walked += 1;
        counts.entries_examined += listing.entries_examined;
        if listing.candidates.is_empty() {
            return Ok(SessionWalkEnd::Walked {
                should_walk_again: listing.should_walk_again,
            });
        }
        let hold = tokio::select! {
            biased;
            () = stop.cancelled() => return Ok(SessionWalkEnd::Stopped),
            hold = COPIES_LOCK.write(session_id) => hold,
        };
        let names = self.read_kept_names(session_id, meter).await?;
        let candidates = listing.candidates;
        let removed = meter
            .run_blocking(move || remove_unnamed(session_id, candidates, &names))
            .await;
        drop(hold);
        let removal = removed.unwrap_or_else(|ended| {
            tracing::warn!(
                %session_id,
                error = &ended as &(dyn Error + 'static),
                "a session's orphans removal ended before it finished"
            );
            SessionRemoval {
                entries_removed: 0,
                has_failed: true,
            }
        });
        counts.entries_removed += removal.entries_removed;
        Ok(SessionWalkEnd::Walked {
            should_walk_again: listing.should_walk_again || removal.has_failed,
        })
    }

    // The names `session_id`'s rows hold.
    async fn read_kept_names(
        &self,
        session_id: SessionId,
        meter: &ProcessorMeter,
    ) -> Result<KeptNames, CheckpointSweepError> {
        let read_meter = meter.clone();
        self.deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_meter.measure(|| {
                    Ok::<_, CheckpointSweepError>(KeptNames {
                        copies: copy_hashes(reader, session_id)?,
                        clones: cloned_shadow_ids(reader, session_id)?,
                        volume_folders: volume_folders(reader, session_id)?,
                    })
                })
            })
            .await
    }
}

// The walk's start and the sessions due a walk: every session with a checkpoint when
// `active_since` is `None`, else those active since it and those of `walk_again`, none marked for
// its purge.
fn read_due_sessions(
    reader: &Connection,
    active_since: Option<Timestamp>,
    walk_again: &HashSet<SessionId>,
) -> rusqlite::Result<(Timestamp, BTreeSet<SessionId>)> {
    let walk_start = reader
        .prepare_cached(&WALK_START_SQL)?
        .query_row([], |row| {
            text_column(row, 0, |text| text.parse::<Timestamp>())
        })?;
    let session_of = |row: &rusqlite::Row<'_>| text_column(row, 0, |text| SessionId::new(&text));
    let Some(since) = active_since else {
        let sessions = reader
            .prepare_cached(&WALKABLE_SESSIONS_SQL)?
            .query_map([], session_of)?
            .collect::<rusqlite::Result<_>>()?;
        return Ok((walk_start, sessions));
    };
    let mut sessions: BTreeSet<SessionId> = reader
        .prepare_cached(&ACTIVE_WALKABLE_SESSIONS_SQL)?
        .query_map(params![since.to_string()], session_of)?
        .collect::<rusqlite::Result<_>>()?;
    let mut is_walkable = reader.prepare_cached(&IS_WALKABLE_SESSION_SQL)?;
    for session_id in walk_again {
        if !sessions.contains(session_id)
            && is_walkable
                .query_row(params![session_id.text().as_str()], |_| Ok(()))
                .optional()?
                .is_some()
        {
            sessions.insert(*session_id);
        }
    }
    Ok((walk_start, sessions))
}

/// Lists, in the session whose storage folder is `owner_folder` and whose restored clones sit in
/// `restored_folder`, every file of the store's naming that `names` leaves unnamed and that last
/// changed at least [`ORPHAN_AGE`] before `now`: in the copies folder a copy or a copy's
/// temporary, elsewhere a clone named by a shadow's id. A folder on an absent volume is not walked.
/// Blocking; an entry or a folder that does not read is logged and passed over.
fn list_session(
    session_id: SessionId,
    owner_folder: &Path,
    restored_folder: &Path,
    names: &KeptNames,
    now: SystemTime,
) -> SessionListing {
    let mut listing = SessionListing::default();
    let list = |folder: &Path, place: PlaceNaming, listing: &mut SessionListing| {
        if let Err(failure) = list_folder(session_id, folder, place, names, now, listing) {
            log_unread(session_id, folder, &failure);
            listing.should_walk_again = true;
        }
    };
    list(
        &copies_folder(owner_folder),
        PlaceNaming::Copy,
        &mut listing,
    );
    list(
        &large_folder(owner_folder),
        PlaceNaming::Clone,
        &mut listing,
    );
    for volume_folder in &names.volume_folders {
        let folder = Path::new(volume_folder.folder.as_str());
        match read_volume_folder_state(volume_folder) {
            Ok(state) => {
                if state == (VolumeFolderState::Mounted { is_present: true }) {
                    list(folder, PlaceNaming::Clone, &mut listing);
                }
            }
            Err(failure) => {
                log_unread(session_id, folder, &failure);
                listing.should_walk_again = true;
            }
        }
    }
    match restored_volume_folders(restored_folder) {
        Ok(folders) => {
            for folder in folders {
                list(&folder, PlaceNaming::Clone, &mut listing);
            }
        }
        Err(failure) => {
            log_unread(session_id, restored_folder, &failure);
            listing.should_walk_again = true;
        }
    }
    listing
}

// The folders a backup's restore put the session's clones in, one per volume, none when it put
// none.
fn restored_volume_folders(restored_folder: &Path) -> io::Result<Vec<PathBuf>> {
    let Some(entries) = fs::read_dir(restored_folder).none_if_missing()? else {
        return Ok(Vec::new());
    };
    let mut folders = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            folders.push(entry.path());
        }
    }
    Ok(folders)
}

// Lists each regular file of `folder` that `place` reads as the store's and `names` leaves
// unnamed once it last changed at least `ORPHAN_AGE` before `now`; a name not of the store's
// naming is passed over, a link is never followed, and an entry that does not read is logged and
// passed over. Fails when the folder itself does not list.
fn list_folder(
    session_id: SessionId,
    folder: &Path,
    place: PlaceNaming,
    names: &KeptNames,
    now: SystemTime,
    listing: &mut SessionListing,
) -> io::Result<()> {
    let Some(entries) = fs::read_dir(folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(failure) => {
                log_unread(session_id, folder, &failure);
                listing.should_walk_again = true;
                continue;
            }
        };
        let Some(is_named) = place.is_named(names, entry.file_name().as_os_str()) else {
            continue;
        };
        listing.entries_examined += 1;
        if is_named {
            continue;
        }
        let path = entry.path();
        // Read from the entry itself, so a link reads as a link.
        let is_old = match entry.metadata().and_then(|metadata| {
            if !metadata.is_file() {
                return Ok(None);
            }
            let changed_at = entry_changed_at(&metadata)?;
            Ok(Some(
                now.duration_since(changed_at)
                    .is_ok_and(|age| age >= ORPHAN_AGE),
            ))
        }) {
            Ok(is_old) => is_old,
            Err(gone) if is_gone(&gone) => None,
            Err(failure) => {
                log_unread(session_id, &path, &failure);
                listing.should_walk_again = true;
                None
            }
        };
        match is_old {
            Some(true) => listing.candidates.push(OrphanCandidate { path, place }),
            Some(false) => listing.should_walk_again = true,
            None => {}
        }
    }
    Ok(())
}

// Removes each of `candidates` that `names`, read again under the session's copies lock, still
// leaves unnamed; a removal that fails is logged and passed over.
fn remove_unnamed(
    session_id: SessionId,
    candidates: Vec<OrphanCandidate>,
    names: &KeptNames,
) -> SessionRemoval {
    let mut removal = SessionRemoval::default();
    for candidate in candidates {
        let is_unnamed = candidate
            .path
            .file_name()
            .and_then(|name| candidate.place.is_named(names, name))
            == Some(false);
        if !is_unnamed {
            continue;
        }
        match fs::remove_file(&candidate.path) {
            Ok(()) => removal.entries_removed += 1,
            Err(gone) if is_gone(&gone) => {}
            Err(failure) => {
                tracing::warn!(
                    %session_id,
                    path = %candidate.path.display(),
                    error = &failure as &(dyn Error + 'static),
                    "an orphaned copy or clone could not be removed"
                );
                removal.has_failed = true;
            }
        }
    }
    removal
}

// Logs a place or an entry of a session's walk that did not read.
fn log_unread(session_id: SessionId, path: &Path, failure: &io::Error) {
    tracing::warn!(
        %session_id,
        path = %path.display(),
        error = failure as &(dyn Error + 'static),
        "a place of a session's orphans walk could not be read, so it was passed over"
    );
}

impl PlaceNaming {
    // Whether `names` names the file `name` of a place of this naming: `None` for a name not of
    // the store's naming, `Some(false)` for an unnamed one, a copy's temporary included.
    fn is_named(self, names: &KeptNames, name: &OsStr) -> Option<bool> {
        match self {
            Self::Copy => {
                if is_copy_temporary(name) {
                    return Some(false);
                }
                let name = name.to_str()?;
                Sha256Hex::new(name.to_owned())
                    .is_some()
                    .then(|| names.copies.contains(name))
            }
            Self::Clone => {
                let name = name.to_str()?;
                UuidTextForm::new(name)
                    .is_ok()
                    .then(|| names.clones.contains(name))
            }
        }
    }
}

#[cfg(test)]
mod tests;

//! The sweep's walk of each session's orphaned copies and clones, those a crash or a failed step
//! left behind with no row naming them: in the session's copies folder, its large files' folder,
//! each of its folders on other volumes and the folders a backup's restore put its clones in,
//! every file of the store's naming that no row names is removed once it is an hour old, under the
//! session's copies lock held exclusive, so no keeper is between keeping a file and naming it.
//! The first walk of a daemon run walks every session with a checkpoint; each later one walks only
//! the sessions active since the walk before it and those it marked to walk again for a file too
//! young to go.

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use jiff::{SignedDuration, Timestamp};
use rusqlite::Connection;
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
use sidekicks_store::database::stored_column::{optional_text_column, text_column};
use tokio_util::sync::CancellationToken;

use super::{CheckpointSweep, CheckpointSweepCounts, CheckpointSweepError};
use crate::checkpoints::copies::{COPIES_LOCK, copies_folder, is_copy_temporary};
use crate::checkpoints::shadows::large_folder;
use crate::checkpoints::store::copy_hashes;
use crate::checkpoints::store::shadows::{VolumeFolder, cloned_shadow_ids, volume_folders};
use crate::checkpoints::volume_folders::{
    VolumeFolderState, read_volume_folder_state, restored_clones_folder,
};

/// How long since its last change a file no row names waits before it is taken for an orphan:
/// past any keeper's write between keeping a file and naming it.
const ORPHAN_AGE: Duration = Duration::from_hours(1);

/// How far before the previous walk's start a session's last activity still has it walked, past
/// any lag between an activity's time and its row's write.
const ACTIVITY_GRACE: SignedDuration = SignedDuration::from_mins(5);

// The walk's start on the database clock, which every session's last activity is written by.
static WALK_START_SQL: LazyLock<String> = LazyLock::new(|| format!("SELECT {DATABASE_NOW_SQL}"));

// Every session with a checkpoint and its last activity, `NULL` with no session row; a session
// marked for its purge is left to the purge, which removes its folders whole.
static WALKABLE_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT checkpoints.session_id, sessions.last_activity_at
  FROM session_checkpoints AS checkpoints
  LEFT JOIN sessions ON sessions.id = checkpoints.session_id
 WHERE sessions.state IS NULL OR sessions.state <> '{}'
 ORDER BY checkpoints.session_id",
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
    /// The sessions a walk marked for a file too young to go, or whose walk failed.
    walk_again: HashSet<SessionId>,
}

/// One session's walk, as it ended.
#[derive(Debug, Default)]
struct SessionWalk {
    /// The files of the store's naming looked at, named or not.
    entries_examined: u64,
    /// The orphans removed.
    entries_removed: u64,
    /// Whether an orphan was too young to go.
    should_walk_again: bool,
    /// The step that stopped the walk, every place after it left for the next.
    failure: Option<io::Error>,
}

/// The names a session's rows hold, read under its copies lock.
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
        let read_meter = meter.clone();
        let (walk_start, sessions) = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                read_meter
                    .measure(|| read_walkable_sessions(reader))
                    .map_err(CheckpointSweepError::from)
            })
            .await?;
        let (previous_walk_start, walk_again) = {
            let memory = lock(&self.orphan_walks.memory);
            (memory.previous_walk_start, memory.walk_again.clone())
        };
        let active_since = previous_walk_start
            .map(|start| start.checked_sub(ACTIVITY_GRACE).unwrap_or(Timestamp::MIN));
        let due = sessions
            .into_iter()
            .filter(|(session_id, last_activity)| match active_since {
                None => true,
                Some(since) => {
                    walk_again.contains(session_id)
                        || last_activity.is_some_and(|activity| activity >= since)
                }
            })
            .map(|(session_id, _)| session_id);
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

    // Walks `session_id`'s places under its copies lock held exclusive, from before its names are
    // read until its removals end. Fails when its names do not read; a failed walk is logged and
    // the session walked again.
    async fn walk_session_orphans(
        &self,
        session_id: SessionId,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        counts: &mut CheckpointSweepCounts,
    ) -> Result<SessionWalkEnd, CheckpointSweepError> {
        let hold = tokio::select! {
            biased;
            () = stop.cancelled() => return Ok(SessionWalkEnd::Stopped),
            hold = COPIES_LOCK.write(session_id) => hold,
        };
        let read_meter = meter.clone();
        let names = self
            .deps
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
            .await?;
        let owner_folder = session_storage_folder(&self.deps.data_folder, &session_id);
        let restored_folder = restored_clones_folder(&self.deps.data_folder, &session_id);
        let now = self.deps.clock.now();
        let walked = meter
            .run_blocking(move || walk_session(&owner_folder, &restored_folder, &names, now))
            .await;
        drop(hold);
        counts.sessions_walked += 1;
        let walk = match walked {
            Ok(walk) => walk,
            Err(ended) => {
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
        counts.entries_examined += walk.entries_examined;
        counts.entries_removed += walk.entries_removed;
        if let Some(failure) = &walk.failure {
            tracing::warn!(
                %session_id,
                error = failure as &(dyn Error + 'static),
                "a session's orphaned copies and clones could not all be walked"
            );
        }
        Ok(SessionWalkEnd::Walked {
            should_walk_again: walk.should_walk_again || walk.failure.is_some(),
        })
    }
}

// A session with a checkpoint and its last activity, `None` with no session row.
type WalkableSession = (SessionId, Option<Timestamp>);

// The walk's start and every session with a checkpoint, none marked for its purge, with its last
// activity.
fn read_walkable_sessions(
    reader: &Connection,
) -> rusqlite::Result<(Timestamp, Vec<WalkableSession>)> {
    let walk_start = reader
        .prepare_cached(&WALK_START_SQL)?
        .query_row([], |row| {
            text_column(row, 0, |text| text.parse::<Timestamp>())
        })?;
    let sessions = reader
        .prepare_cached(&WALKABLE_SESSIONS_SQL)?
        .query_map([], |row| {
            Ok((
                text_column(row, 0, |text| SessionId::new(&text))?,
                optional_text_column(row, 1, |text| text.parse::<Timestamp>())?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((walk_start, sessions))
}

/// Removes, from the session whose storage folder is `owner_folder` and whose restored clones sit
/// in `restored_folder`, every file of the store's naming that `names` leaves unnamed and that
/// last changed at least [`ORPHAN_AGE`] before `now`: in the copies folder a copy or a copy's
/// temporary, elsewhere a clone named by a shadow's id. A folder on an absent volume is not walked.
/// Blocking; the first failing step ends the walk and is kept in its answer.
fn walk_session(
    owner_folder: &Path,
    restored_folder: &Path,
    names: &KeptNames,
    now: SystemTime,
) -> SessionWalk {
    let mut walk = SessionWalk::default();
    if let Err(failure) = walk_places(owner_folder, restored_folder, names, now, &mut walk) {
        walk.failure = Some(failure);
    }
    walk
}

// Walks each place of the session in turn, stopping at the first failing step.
fn walk_places(
    owner_folder: &Path,
    restored_folder: &Path,
    names: &KeptNames,
    now: SystemTime,
    walk: &mut SessionWalk,
) -> io::Result<()> {
    let copy_name = |name: &OsStr| {
        if is_copy_temporary(name) {
            return Some(false);
        }
        let name = name.to_str()?;
        Sha256Hex::new(name.to_owned())
            .is_some()
            .then(|| names.copies.contains(name))
    };
    let clone_name = |name: &OsStr| {
        let name = name.to_str()?;
        UuidTextForm::new(name)
            .is_ok()
            .then(|| names.clones.contains(name))
    };
    walk_folder(&copies_folder(owner_folder), &copy_name, now, walk)?;
    walk_folder(&large_folder(owner_folder), &clone_name, now, walk)?;
    for folder in &names.volume_folders {
        if read_volume_folder_state(folder)? == (VolumeFolderState::Mounted { is_present: true }) {
            walk_folder(Path::new(folder.folder.as_str()), &clone_name, now, walk)?;
        }
    }
    let Some(entries) = fs::read_dir(restored_folder).none_if_missing()? else {
        return Ok(());
    };
    let mut restored_volume_folders: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            restored_volume_folders.push(entry.path());
        }
    }
    for folder in restored_volume_folders {
        walk_folder(&folder, &clone_name, now, walk)?;
    }
    Ok(())
}

// Removes each regular file of `folder` that `naming` reads as the store's and unnamed, with
// `Some(false)`, once it last changed at least `ORPHAN_AGE` before `now`; a name `naming` answers
// `None` for is not the store's and is passed over, and a link is never followed.
fn walk_folder(
    folder: &Path,
    naming: &dyn Fn(&OsStr) -> Option<bool>,
    now: SystemTime,
    walk: &mut SessionWalk,
) -> io::Result<()> {
    let Some(entries) = fs::read_dir(folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        let Some(is_named) = naming(entry.file_name().as_os_str()) else {
            continue;
        };
        walk.entries_examined += 1;
        if is_named {
            continue;
        }
        // Read from the entry itself, so a link reads as a link.
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(gone) if is_gone(&gone) => continue,
            Err(failure) => return Err(failure),
        };
        if !metadata.is_file() {
            continue;
        }
        let is_old = now
            .duration_since(entry_changed_at(&metadata)?)
            .is_ok_and(|age| age >= ORPHAN_AGE);
        if !is_old {
            walk.should_walk_again = true;
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => walk.entries_removed += 1,
            Err(gone) if is_gone(&gone) => {}
            Err(failure) => return Err(failure),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

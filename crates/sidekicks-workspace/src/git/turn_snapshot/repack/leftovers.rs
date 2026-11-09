//! What a git cut at its bound, or a daemon stopped mid-write, leaves in a capture folder and in
//! its owner's captures folder: git's temporary packs and loose objects, a capture's scratch index
//! and the lock beside it, and a capture folder still being made. Each is removed by its name once
//! it is an hour old, as git's prune removes its own temporaries, and a scratch index also once it
//! was written before this daemon run began; nothing else is touched. The walk of the loose objects
//! also finds those an hour old, and those written before this daemon run began at any age, which
//! a capture whose own pack failed left loose.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::remove_tree;
use sidekicks_std::missing_entry::{MissingEntry as _, is_gone};

use super::{PACK_EXTENSION, PACK_INDEX_EXTENSION, PACK_REVERSE_INDEX_EXTENSION, PACK_SEGMENT};
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, INDEXES_SEGMENT, OBJECTS_SEGMENT, is_partial_capture_folder_name,
    is_scratch_index_file_name,
};

/// How long since its last write an entry waits before it is taken for a leftover: past every git
/// call's bound in a capture folder, the fold's the longest, and past any one capture, which a
/// partial folder and a scratch index never outlive.
pub(super) const STALE_LEFTOVER_AGE: Duration = Duration::from_hours(1);

/// The coarsest step a file system keeps a file's time in (FAT's two seconds), taken off the run's
/// start so a scratch index or a loose object this run writes never reads as written before it
/// began.
const FILE_TIME_STEP: Duration = Duration::from_secs(2);

/// The name prefixes of the temporary files a pack write keeps in the pack folder until it
/// finishes: `pack-objects`' and `index-pack`'s `tmp_`, and `repack`'s `.tmp-`.
const TEMPORARY_PACK_PREFIXES: [&str; 2] = ["tmp_", ".tmp-"];

/// The name prefix of the temporary file a loose object's write keeps in its fan-out folder until
/// it finishes.
const TEMPORARY_OBJECT_PREFIX: &str = "tmp_obj_";

/// Removes from `pack_folder` each temporary pack, a file or a folder, and each index or reverse
/// index whose pack's data file is gone, as a reclaim stopped between the two leaves one, each last
/// written an hour or more ago, and answers how many it removed. Blocking. Fails as a listing, a
/// stat or a removal does; a folder or an entry already gone is none.
pub(super) fn remove_stale_temporary_packs(pack_folder: &Path) -> io::Result<u64> {
    remove_stale_entries(pack_folder, stale_cutoff(), |name| {
        has_any_prefix(name, &TEMPORARY_PACK_PREFIXES) || is_index_without_pack(pack_folder, name)
    })
}

// Whether `name` in `pack_folder` is a pack's index or reverse index whose data file reads as
// gone; one whose data file cannot be read is kept.
fn is_index_without_pack(pack_folder: &Path, name: &OsStr) -> bool {
    let path = Path::new(name);
    let is_index = path.extension().is_some_and(|extension| {
        extension == PACK_INDEX_EXTENSION || extension == PACK_REVERSE_INDEX_EXTENSION
    });
    is_index
        && name
            .to_str()
            .is_some_and(|name| name.starts_with(PACK_SEGMENT))
        && matches!(
            fs::symlink_metadata(pack_folder.join(path.with_extension(PACK_EXTENSION))),
            Err(missing) if missing.kind() == io::ErrorKind::NotFound
        )
}

/// Removes the stale leftovers of the capture folder `folder`: its temporary packs, then, when
/// `is_object_folder_walked`, the temporary loose objects in its fan-out folders, then its scratch
/// indexes and their locks, a scratch index written before `run_began_at` at any age. Answers the
/// loose objects the walk found an hour old or written before `run_began_at`, none when it did not
/// walk; the record of a capture whose own pack failed is lost with the run, so its loose objects
/// are packed at the run's first pass, before any fold rolls them up. Blocking. Fails as a
/// listing, a stat or a removal does; a folder or an entry already gone is none.
pub(super) fn clear_capture_folder_leftovers(
    folder: &Path,
    is_object_folder_walked: bool,
    run_began_at: SystemTime,
) -> io::Result<Vec<GitObjectId>> {
    let objects = folder.join(OBJECTS_SEGMENT);
    remove_stale_temporary_packs(&objects.join(PACK_SEGMENT))?;
    let run_cutoff = run_began_at
        .checked_sub(FILE_TIME_STEP)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut stale_objects = Vec::new();
    if is_object_folder_walked && let Some(entries) = fs::read_dir(&objects).none_if_missing()? {
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            if let Some(fan_out) = fan_out_name(&name)
                && entry.file_type()?.is_dir()
            {
                let fan_out_folder = entry.path();
                remove_stale_entries(&fan_out_folder, stale_cutoff(), |name| {
                    has_any_prefix(name, &[TEMPORARY_OBJECT_PREFIX])
                })?;
                read_stale_loose_objects(
                    &fan_out_folder,
                    fan_out,
                    stale_cutoff().max(run_cutoff),
                    &mut stale_objects,
                )?;
            }
        }
    }
    remove_stale_entries(
        &folder.join(INDEXES_SEGMENT),
        stale_cutoff().max(run_cutoff),
        is_scratch_index_file_name,
    )?;
    Ok(stale_objects)
}

/// Removes, whole, each capture folder still being made in the captures folder of the owner whose
/// folder is `owner_folder` that was last written an hour or more ago, and answers how many it
/// removed. Blocking. Fails as a listing, a stat or a removal does; a folder or an entry already
/// gone is none.
pub(super) fn clear_partial_capture_folders(owner_folder: &Path) -> io::Result<u64> {
    remove_stale_entries(
        &owner_folder.join(CAPTURES_SEGMENT),
        stale_cutoff(),
        is_partial_capture_folder_name,
    )
}

// Adds to `stale_objects` each loose object in the fan-out folder `fan_out_folder`, named
// `fan_out`, last written at or before `cutoff`; a name that is no object id is passed over.
fn read_stale_loose_objects(
    fan_out_folder: &Path,
    fan_out: &str,
    cutoff: SystemTime,
    stale_objects: &mut Vec<GitObjectId>,
) -> io::Result<()> {
    let Some(entries) = fs::read_dir(fan_out_folder).none_if_missing()? else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        let Some(object) = entry
            .file_name()
            .to_str()
            .and_then(|rest| GitObjectId::new(format!("{fan_out}{rest}")))
        else {
            continue;
        };
        match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) if modified <= cutoff => stale_objects.push(object),
            Ok(_) => {}
            Err(gone) if is_gone(&gone) => {}
            Err(failure) => return Err(failure),
        }
    }
    Ok(())
}

// Removes each entry of `folder` whose name `is_leftover` reads true for and that was last written
// at or before `stale_before`, a folder whole, and answers how many it removed.
fn remove_stale_entries(
    folder: &Path,
    stale_before: SystemTime,
    is_leftover: impl Fn(&OsStr) -> bool,
) -> io::Result<u64> {
    let Some(entries) = fs::read_dir(folder).none_if_missing()? else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        if !is_leftover(&entry.file_name()) {
            continue;
        }
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(gone) if is_gone(&gone) => continue,
            Err(failure) => return Err(failure),
        };
        if modified > stale_before {
            continue;
        }
        match remove_tree(&entry.path()) {
            Ok(()) => removed += 1,
            Err(gone) if is_gone(&gone) => {}
            Err(failure) => return Err(failure),
        }
    }
    Ok(removed)
}

// The last write time at or before which an entry is old enough to be a leftover; a time ahead of
// the clock reads as just written.
fn stale_cutoff() -> SystemTime {
    SystemTime::now()
        .checked_sub(STALE_LEFTOVER_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

// Whether `name` is UTF-8 and starts with one of `prefixes`.
fn has_any_prefix(name: &OsStr, prefixes: &[&str]) -> bool {
    name.to_str()
        .is_some_and(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
}

// `name` when it is a fan-out folder's: two lowercase hex digits, the first byte of an object id.
fn fan_out_name(name: &OsStr) -> Option<&str> {
    name.to_str().filter(|name| {
        name.len() == 2
            && name
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

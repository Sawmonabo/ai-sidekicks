//! What a git cut at its bound, or a daemon stopped mid-write, leaves in a capture folder and in
//! its owner's captures folder: git's temporary packs and loose objects, a capture's scratch index
//! and the lock beside it, and a capture folder still being made. Each is removed by its name once
//! it is an hour old, as git's prune removes its own temporaries; nothing else is touched.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

use sidekicks_platforms::remove_tree;
use sidekicks_std::missing_entry::{MissingEntry as _, is_gone};

use super::PACK_SEGMENT;
use crate::git::turn_snapshot::capture_folder::{
    CAPTURES_SEGMENT, INDEXES_SEGMENT, OBJECTS_SEGMENT, is_partial_capture_folder_name,
    is_scratch_index_file_name,
};

/// How long since its last write an entry waits before it is taken for a leftover: past every git
/// call's bound in a capture folder, the fold's the longest, and past any one capture, which a
/// partial folder and a scratch index never outlive.
pub(super) const STALE_LEFTOVER_AGE: Duration = Duration::from_hours(1);

/// The name prefixes of the temporary files a pack write keeps in the pack folder until it
/// finishes: `pack-objects`' and `index-pack`'s `tmp_`, and `repack`'s `.tmp-`.
const TEMPORARY_PACK_PREFIXES: [&str; 2] = ["tmp_", ".tmp-"];

/// The name prefix of the temporary file a loose object's write keeps in its fan-out folder until
/// it finishes.
const TEMPORARY_OBJECT_PREFIX: &str = "tmp_obj_";

/// Removes from `pack_folder` each temporary pack, a file or a folder, last written an hour or more
/// ago, and answers how many it removed. Blocking. Fails as a listing, a stat or a removal does; a
/// folder or an entry already gone is none.
pub(super) fn remove_stale_temporary_packs(pack_folder: &Path) -> io::Result<u64> {
    remove_stale_entries(pack_folder, |name| {
        has_any_prefix(name, &TEMPORARY_PACK_PREFIXES)
    })
}

/// Removes the stale leftovers of the capture folder `folder`: its temporary packs, then, when
/// `is_object_folder_walked`, the temporary loose objects in its fan-out folders, then its scratch
/// indexes and their locks; answers how many it removed. Blocking. Fails as a listing, a stat or a
/// removal does; a folder or an entry already gone is none.
pub(super) fn clear_capture_folder_leftovers(
    folder: &Path,
    is_object_folder_walked: bool,
) -> io::Result<u64> {
    let objects = folder.join(OBJECTS_SEGMENT);
    let mut removed = remove_stale_temporary_packs(&objects.join(PACK_SEGMENT))?;
    if is_object_folder_walked && let Some(entries) = fs::read_dir(&objects).none_if_missing()? {
        for entry in entries {
            let entry = entry?;
            if is_fan_out_name(&entry.file_name()) && entry.file_type()?.is_dir() {
                removed += remove_stale_entries(&entry.path(), |name| {
                    has_any_prefix(name, &[TEMPORARY_OBJECT_PREFIX])
                })?;
            }
        }
    }
    removed += remove_stale_entries(&folder.join(INDEXES_SEGMENT), is_scratch_index_file_name)?;
    Ok(removed)
}

/// Removes, whole, each capture folder still being made in the captures folder of the owner whose
/// folder is `owner_folder` that was last written an hour or more ago, and answers how many it
/// removed. Blocking. Fails as a listing, a stat or a removal does; a folder or an entry already
/// gone is none.
pub(super) fn clear_partial_capture_folders(owner_folder: &Path) -> io::Result<u64> {
    remove_stale_entries(
        &owner_folder.join(CAPTURES_SEGMENT),
        is_partial_capture_folder_name,
    )
}

// Removes each entry of `folder` whose name `is_leftover` reads true for and that is stale, a
// folder whole, and answers how many it removed.
fn remove_stale_entries(folder: &Path, is_leftover: impl Fn(&OsStr) -> bool) -> io::Result<u64> {
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
        if !is_stale(modified) {
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

// Whether an entry last written at `modified` is old enough to be a leftover; a time ahead of the
// clock reads as just written.
fn is_stale(modified: SystemTime) -> bool {
    modified.elapsed().unwrap_or(Duration::ZERO) >= STALE_LEFTOVER_AGE
}

// Whether `name` is UTF-8 and starts with one of `prefixes`.
fn has_any_prefix(name: &OsStr, prefixes: &[&str]) -> bool {
    name.to_str()
        .is_some_and(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
}

// Whether `name` is a fan-out folder's: two lowercase hex digits, the first byte of an object id.
fn is_fan_out_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        name.len() == 2
            && name
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

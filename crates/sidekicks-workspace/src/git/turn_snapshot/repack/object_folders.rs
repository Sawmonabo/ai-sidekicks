//! The stat data that tells a sweep whether a capture folder's objects changed since its last
//! count, without running git: a loose object written or removed changes its fan-out folder's
//! times, and a pack written or removed changes the `pack` folder's.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sidekicks_platforms::FileFacts;

use super::ref_state::{child_folders, has_entry_near, read_entry};

/// The facts of a capture folder's `objects` folder and of every folder in it, by path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ObjectFolderState {
    entries: BTreeMap<PathBuf, FileFacts>,
}

impl ObjectFolderState {
    /// Whether any folder was modified or changed within the coarsest time precision of
    /// `read_at`, or after it, so a write right after the read could keep the facts it had.
    pub(super) fn has_entry_near(&self, read_at: SystemTime) -> bool {
        has_entry_near(&self.entries, read_at)
    }
}

/// The object folder state of `objects`, a capture folder's `objects` folder: its own facts and
/// those of each folder in it, the fan-out folders and `pack` among them. Blocking. Fails as a
/// stat or the listing does; a missing folder is none.
pub(super) fn read_object_folder_state(objects: &Path) -> io::Result<ObjectFolderState> {
    let mut entries = BTreeMap::new();
    if read_entry(objects, &mut entries)? {
        for folder in child_folders(objects)? {
            read_entry(&folder, &mut entries)?;
        }
    }
    Ok(ObjectFolderState { entries })
}

//! A process owner for tests that records each folder it was asked about and when its hold drops.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;

use super::{FolderProcessHold, FolderProcessOwner};

/// One moment the owner saw a folder: which folder, and whether it was still on disk then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FolderSighting {
    /// The folder the owner was asked about.
    pub(crate) folder: PathBuf,
    /// Whether the folder was on disk at that moment.
    pub(crate) was_present: bool,
}

impl FolderSighting {
    fn of(folder: &Path) -> Self {
        Self {
            folder: folder.to_path_buf(),
            was_present: folder.exists(),
        }
    }
}

/// An owner that records each folder it was asked to end processes in, and, as each hold it
/// answered drops, whether that folder was still on disk.
#[derive(Default)]
pub(crate) struct RecordingOwner {
    asked: Mutex<Vec<FolderSighting>>,
    released: Arc<Mutex<Vec<FolderSighting>>>,
}

impl RecordingOwner {
    /// The folders asked about, in order.
    pub(crate) fn asked(&self) -> Vec<FolderSighting> {
        self.asked.lock().expect("the owner's list").clone()
    }

    /// The folders whose holds have dropped, in order.
    pub(crate) fn released(&self) -> Vec<FolderSighting> {
        self.released.lock().expect("the owner's list").clone()
    }
}

// Records its folder as it drops.
struct RecordingHold {
    folder: PathBuf,
    released: Arc<Mutex<Vec<FolderSighting>>>,
}

impl Drop for RecordingHold {
    fn drop(&mut self) {
        self.released
            .lock()
            .expect("the owner's list")
            .push(FolderSighting::of(&self.folder));
    }
}

impl FolderProcessOwner for RecordingOwner {
    fn end_processes_in_folder<'a>(
        &'a self,
        folder: &'a Path,
    ) -> BoxFuture<'a, Result<FolderProcessHold, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            self.asked
                .lock()
                .expect("the owner's list")
                .push(FolderSighting::of(folder));
            Ok(Box::new(RecordingHold {
                folder: folder.to_path_buf(),
                released: Arc::clone(&self.released),
            }) as FolderProcessHold)
        })
    }
}

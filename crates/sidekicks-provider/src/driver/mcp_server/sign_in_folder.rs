//! The folder of the daemon's own an MCP sign-in through a provider's own client runs in: made for
//! that sign-in alone, readable by the person alone, and gone once the sign-in ends, whether it
//! ends, fails or is dropped mid-flow; and the start's removal of the folders a stopped daemon
//! left.

use std::error::Error;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use sidekicks_platforms::{LeftoverSweep, create_private_folder, replace_file_atomically};
use sidekicks_std::random_hex::random_hex;

/// One sign-in's own folder, removed when dropped unless [`SignInFolder::remove`] removed it
/// first, so a sign-in dropped mid-flow leaves no token behind.
pub(crate) struct SignInFolder {
    path: PathBuf,
    is_removed: bool,
}

impl SignInFolder {
    /// Makes a folder under `parent`, named by `name_bytes` random bytes in hex and readable by the
    /// person alone, holding `file_name` with `contents` readable by the person alone, since a
    /// server's entry can hold header values. Fails as the name, the folder or the file cannot be
    /// made; a folder made before the file failed is removed.
    pub(crate) async fn make(
        parent: &Path,
        name_bytes: usize,
        file_name: &'static str,
        contents: String,
    ) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let folder = Self {
            path: parent.join(random_hex(name_bytes)?),
            is_removed: false,
        };
        let made = folder.path.clone();
        tokio::task::spawn_blocking(move || {
            create_private_folder(&made)?;
            replace_file_atomically(
                &made.join(file_name),
                contents.as_bytes(),
                0o600,
                LeftoverSweep::Unswept,
            )?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        })
        .await??;
        Ok(folder)
    }

    /// The folder.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Removes the folder now; a folder already gone counts as removed. Fails with the system's
    /// error, the folder then still removed when this drops.
    pub(crate) async fn remove(mut self) -> io::Result<()> {
        remove_folder(tokio::fs::remove_dir_all(&self.path).await)?;
        self.is_removed = true;
        Ok(())
    }
}

impl Drop for SignInFolder {
    // Removed in place, not on a spawned task, so the folder is gone once the sign-in is.
    fn drop(&mut self) {
        if self.is_removed {
            return;
        }
        if let Err(error) = remove_folder(std::fs::remove_dir_all(&self.path)) {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %self.path.display(),
                "the folder of a dropped MCP sign-in was not removed"
            );
        }
    }
}

/// Removes `parent`, the folder each sign-in makes its own in, with every folder a stopped daemon
/// left there; none there counts as removed. Fails with the system's error.
pub(crate) async fn remove_left_sign_in_folders(parent: &Path) -> io::Result<()> {
    remove_folder(tokio::fs::remove_dir_all(parent).await)
}

// A removal's outcome, a folder already gone counted as removed.
fn remove_folder(removed: io::Result<()>) -> io::Result<()> {
    match removed {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

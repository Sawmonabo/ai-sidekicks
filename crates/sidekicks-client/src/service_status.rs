//! The service's status file as a client reads it while the service is not answering, and the
//! removal of a `stopping` record whose service has ended, which a reader would otherwise take as a
//! stop still under way.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::service_status::ServiceStatusFile;
use sidekicks_platforms::pin_identified_process;

/// Why the status file did not read.
#[derive(Debug, thiserror::Error)]
pub enum ServiceStatusReadError {
    /// The file is there but could not be read.
    #[error("could not read the background service's status from {}", path.display())]
    Read {
        /// The status file.
        path: PathBuf,
        /// The system's error.
        #[source]
        source: io::Error,
    },
    /// The file's bytes hold no status, as a power loss can leave a write.
    #[error("the background service's status in {} does not read", path.display())]
    Unparsed {
        /// The status file.
        path: PathBuf,
        /// Why the bytes do not parse.
        #[source]
        source: serde_json::Error,
    },
}

/// The status file at `path`; `None` where there is none. Blocking; fails as
/// [`ServiceStatusReadError`] names.
pub fn read_service_status(
    path: &Path,
) -> Result<Option<ServiceStatusFile>, ServiceStatusReadError> {
    let text = match std::fs::read(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ServiceStatusReadError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    serde_json::from_slice(&text)
        .map(Some)
        .map_err(|source| ServiceStatusReadError::Unparsed {
            path: path.to_path_buf(),
            source,
        })
}

/// Removes the status file at `path` where it holds a `stopping` record whose process no longer
/// runs with the identity it names; any other fact, and bytes that do not parse, are left as they
/// are. Blocking; fails as the read other than a parse, the process's pin, or the removal fails.
pub(crate) fn remove_stale_stopping(path: &Path) -> io::Result<()> {
    let stopping = match read_service_status(path) {
        Ok(Some(ServiceStatusFile::Stopping(stopping))) => stopping,
        Ok(None | Some(ServiceStatusFile::CannotStart(_) | ServiceStatusFile::CannotStop(_)))
        | Err(ServiceStatusReadError::Unparsed { .. }) => return Ok(()),
        Err(error @ ServiceStatusReadError::Read { .. }) => return Err(io::Error::other(error)),
    };
    if pin_identified_process(&stopping.process)?.is_some() {
        return Ok(());
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

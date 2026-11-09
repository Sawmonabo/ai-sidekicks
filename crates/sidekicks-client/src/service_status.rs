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
    read_status_bytes(path)?
        .map(|bytes| parse_status(path, &bytes))
        .transpose()
}

/// Removes the status file at `path` where it holds a `stopping` record whose process no longer
/// runs with the identity it names, and still holds the same bytes once that is known, so a record
/// a new service wrote meanwhile stays; any other fact, and bytes that do not parse, are left as
/// they are. Blocking; fails as the read other than a parse, the process's pin, or the removal
/// fails.
pub(crate) fn remove_stale_stopping(path: &Path) -> io::Result<()> {
    let read = |path: &Path| read_status_bytes(path).map_err(io::Error::other);
    let Some(bytes) = read(path)? else {
        return Ok(());
    };
    let stopping = match parse_status(path, &bytes) {
        Ok(ServiceStatusFile::Stopping(stopping)) => stopping,
        Ok(ServiceStatusFile::CannotStart(_) | ServiceStatusFile::CannotStop(_)) | Err(_) => {
            return Ok(());
        }
    };
    if pin_identified_process(&stopping.process)?.is_some() || read(path)? != Some(bytes) {
        return Ok(());
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

// The status file's bytes, `None` where there is none.
fn read_status_bytes(path: &Path) -> Result<Option<Vec<u8>>, ServiceStatusReadError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ServiceStatusReadError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn parse_status(path: &Path, bytes: &[u8]) -> Result<ServiceStatusFile, ServiceStatusReadError> {
    serde_json::from_slice(bytes).map_err(|source| ServiceStatusReadError::Unparsed {
        path: path.to_path_buf(),
        source,
    })
}

//! A file its writer holds locked while another process may sweep its name: the sweeper removes it
//! only while holding the lock itself, so a writer never ends up holding a file without a name.

use std::fs::{self, File, TryLockError};
use std::io;
use std::path::Path;

/// Removes the file at `path` unless another handle holds it locked, and answers whether one did,
/// so the file was kept; a file already gone was not held. Fails with the open's, the lock's or the
/// removal's error.
pub fn remove_unless_held(path: &Path) -> io::Result<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(failure),
    };
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(true),
        Err(TryLockError::Error(failure)) => return Err(failure),
    }
    // The name goes while this lock is still held: a writer whose lock waited on it then finds its
    // name gone, where one that locked between a release and the removal would lose its file.
    match fs::remove_file(path) {
        Err(failure) if failure.kind() != io::ErrorKind::NotFound => return Err(failure),
        _removed => {}
    }
    drop(file);
    Ok(false)
}

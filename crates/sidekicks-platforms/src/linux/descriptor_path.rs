//! The path an open descriptor names, as Linux reads it back through `/proc/self/fd`.

use std::fs;
use std::io::{self, ErrorKind};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use nix::sys::stat::fstat;

// What the kernel adds to the path of a file removed while it is open.
const DELETED_SUFFIX: &[u8] = b" (deleted)";

/// The path the file `descriptor` has open sits at now, as the kernel names it, the target of any
/// link resolved. Fails with `InvalidInput` when the descriptor names no file in the file system,
/// as a pipe's or a socket's does not, with `NotFound` when its file was removed, and with the
/// system's error when the read is refused.
pub fn read_descriptor_path(descriptor: impl AsFd) -> io::Result<PathBuf> {
    let descriptor = descriptor.as_fd();
    let path = fs::read_link(format!("/proc/self/fd/{}", descriptor.as_raw_fd()))?;
    if !path.is_absolute() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            format!(
                "the descriptor names no file in the file system ({})",
                path.display()
            ),
        ));
    }
    // A file whose own name ends in the suffix is still linked.
    if path.as_os_str().as_bytes().ends_with(DELETED_SUFFIX)
        && fstat(descriptor).map_err(io::Error::from)?.st_nlink == 0
    {
        return Err(io::Error::new(
            ErrorKind::NotFound,
            format!("the descriptor's file was removed ({})", path.display()),
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use super::read_descriptor_path;
    use crate::real_path;

    // Fails when the path is read from anything but the open descriptor.
    #[test]
    fn descriptor_path_round_trips_an_open_file() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("standard output");
        let file = File::create(&path).expect("the file is made");

        let read = read_descriptor_path(&file).expect("the path reads");

        assert_eq!(read, real_path(&path).expect("the file's real path"));
    }
}

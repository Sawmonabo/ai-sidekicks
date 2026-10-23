//! The path an open descriptor names, as Linux reads it back through `/proc/self/fd`.

use std::fs;
use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::path::PathBuf;

/// The path the file `descriptor` has open sits at now, as the kernel names it, the target of any
/// link resolved; a descriptor that names no file in the file system, as a pipe's or a socket's,
/// reads as the kernel's name for it (`pipe:[<inode>]`). Fails with the system's error when the
/// read is refused.
pub fn read_descriptor_path(descriptor: impl AsFd) -> io::Result<PathBuf> {
    fs::read_link(format!("/proc/self/fd/{}", descriptor.as_fd().as_raw_fd()))
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

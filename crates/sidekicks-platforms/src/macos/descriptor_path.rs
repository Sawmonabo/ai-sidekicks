//! The path an open descriptor names, as macOS reads it back with `F_GETPATH`.

use std::ffi::OsString;
use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

/// The path the file `descriptor` has open sits at now, as the kernel names it, the target of any
/// link resolved. Fails with the system's error when the descriptor names no file in the file
/// system, as a pipe's or a socket's does not.
pub fn read_descriptor_path(descriptor: impl AsFd) -> io::Result<PathBuf> {
    let mut buffer = vec![0_u8; usize::try_from(libc::PATH_MAX).map_err(io::Error::other)?];
    // SAFETY: the descriptor is open for the call, and `F_GETPATH` writes at most `PATH_MAX`
    // bytes, a path ended by a zero byte, into the live buffer that long, which nothing else reads
    // until the call returns.
    let status = unsafe {
        libc::fcntl(
            descriptor.as_fd().as_raw_fd(),
            libc::F_GETPATH,
            buffer.as_mut_ptr(),
        )
    };
    if status == -1 {
        return Err(io::Error::last_os_error());
    }
    let end = buffer.iter().position(|byte| *byte == 0).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "the path read back has no end")
    })?;
    buffer.truncate(end);
    Ok(PathBuf::from(OsString::from_vec(buffer)))
}

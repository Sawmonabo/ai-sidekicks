//! The disk on Windows: the free room on a folder's volume, and a written file flushed so it
//! survives a power loss; a folder has no flush there, and a rename is on disk when it returns.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

use crate::windows::real_path::verbatim_path;

// The UTF-16 unit of `\`, the only separator a verbatim path takes.
const BACKSLASH: u16 = 0x5C;

/// A file's flush failed, and so did setting its read-only attribute back afterwards.
#[derive(Debug, thiserror::Error)]
#[error("setting the read-only attribute back after the flush failed too: {restore}")]
pub struct FlushFailure {
    /// The flush's own failure.
    #[source]
    pub flush: io::Error,
    /// The failure setting the file's read-only attribute back.
    pub restore: io::Error,
}

/// The bytes the calling account may still write on the volume holding `folder`, read through its
/// verbatim path so a folder past 260 characters needs no long-path manifest. Fails with
/// `InvalidInput` when the path holds a NUL, and with the system's error when the path cannot be
/// made absolute or the volume cannot be read.
pub fn volume_free_bytes(folder: &Path) -> io::Result<u64> {
    let mut directory = verbatim_path(folder)?;
    // The call needs a share's path to end in a separator, and a folder's path may.
    if directory.last() != Some(&BACKSLASH) {
        directory.push(BACKSLASH);
    }
    directory.push(0);
    let mut free_bytes = 0_u64;
    // SAFETY: the path is NUL-terminated and outlives the call, the one result pointer names a
    // live local, and the two totals the caller does not want are null, which the call allows.
    let result = unsafe {
        GetDiskFreeSpaceExW(
            directory.as_ptr(),
            &raw mut free_bytes,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(free_bytes)
}

/// Flushes the file at `path` to disk through a write open, which the flush needs; a read-only file
/// (git leaves its packs so) has the attribute cleared for the flush and set back. Fails with the
/// flush's error, carrying a [`FlushFailure`] as its source when setting the attribute back failed
/// too, or with the attribute's own error.
pub fn flush_file(path: &Path) -> io::Result<()> {
    let original_permissions = fs::metadata(path)?.permissions();
    if !original_permissions.readonly() {
        return flush_opened(path);
    }
    let mut writable_permissions = original_permissions.clone();
    #[expect(
        clippy::permissions_set_readonly_false,
        reason = "Windows clears only the read-only attribute"
    )]
    writable_permissions.set_readonly(false);
    fs::set_permissions(path, writable_permissions)?;
    let flushed = flush_opened(path);
    let restored = fs::set_permissions(path, original_permissions);
    match (flushed, restored) {
        (Ok(()), restored) => restored,
        (Err(flush), Ok(())) => Err(flush),
        (Err(flush), Err(restore)) => Err(io::Error::new(
            flush.kind(),
            FlushFailure { flush, restore },
        )),
    }
}

/// Does nothing: Windows has no flush of a folder's entries, and a rename is on disk when it
/// returns. Never fails.
pub fn flush_folder(_folder: &Path) -> io::Result<()> {
    Ok(())
}

/// The folders the Windows drives are mounted at inside a WSL distribution: none, since this is
/// Windows itself. Never fails.
pub fn windows_drive_mounts() -> io::Result<Vec<PathBuf>> {
    Ok(Vec::new())
}

// A file is closed when dropped; a failure a close could report is one `sync_all` already reported.
fn flush_opened(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.sync_all()
}

//! The disk on macOS and Linux: the free room on a folder's volume, a read at a file offset, and a
//! written file or a changed folder flushed so it survives a power loss.

use std::fs::File;
use std::io;
use std::path::Path;

/// The bytes an unprivileged process may still write on the volume holding `folder`. Fails with
/// the system's error when the volume cannot be read, and with `Other` when the count passes
/// `u64`.
pub fn volume_free_bytes(folder: &Path) -> io::Result<u64> {
    let (available_blocks, block_bytes) = available_blocks(folder)?;
    available_blocks
        .checked_mul(block_bytes)
        .ok_or_else(|| io::Error::other("the volume's free room passes 64 bits"))
}

/// Whether a reader that keeps a file open reads it through a memory map rather than by reads at
/// an offset: on macOS alone, whose footprint (the memory it charges a process) leaves out a mapped
/// file's clean pages, so a mapped file measures smaller there.
pub const SHOULD_MEMORY_MAP_READS: bool = cfg!(target_os = "macos");

/// Fills `buffer` from `file` at byte `offset`; each read names its own offset, so threads sharing
/// one handle read independently. Fails with `UnexpectedEof` when the file ends first, or with the
/// read's error.
pub fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buffer, offset)
}

/// Flushes the file at `path` to disk through a read-only open. Fails with the open's or the
/// flush's error.
pub fn flush_file(path: &Path) -> io::Result<()> {
    flush_opened(path)
}

/// Flushes `folder`'s entries to disk through a read-only open, so a rename or removal in it
/// survives a power loss. Fails with the open's or the flush's error.
pub fn flush_folder(folder: &Path) -> io::Result<()> {
    flush_opened(folder)
}

// The volume's available blocks and the bytes in each. macOS reads `statfs`, since its `statvfs`
// holds block counts in 32 bits and wraps past 16 TiB.
#[cfg(target_os = "macos")]
fn available_blocks(folder: &Path) -> io::Result<(u64, u64)> {
    let volume = nix::sys::statfs::statfs(folder)?;
    Ok((volume.blocks_available(), u64::from(volume.block_size())))
}

// The volume's available blocks and the bytes in each; POSIX counts `f_bavail` in `f_frsize`
// units.
#[cfg(target_os = "linux")]
fn available_blocks(folder: &Path) -> io::Result<(u64, u64)> {
    let volume = nix::sys::statvfs::statvfs(folder)?;
    Ok((volume.blocks_available(), volume.fragment_size()))
}

// A file is closed when dropped; a failure a close could report is one `sync` already reported.
fn flush_opened(path: &Path) -> io::Result<()> {
    let opened = File::open(path)?;
    sync(&opened)
}

// macOS's `fsync` leaves the drive's own cache unflushed, so the full flush goes first; a file
// system that refuses it takes the barrier flush, then a plain `fsync`, so a share that has
// neither still flushes.
#[cfg(target_os = "macos")]
fn sync(opened: &File) -> io::Result<()> {
    use nix::fcntl::{FcntlArg, fcntl};

    if fcntl(opened, FcntlArg::F_FULLFSYNC).is_ok()
        || fcntl(opened, FcntlArg::F_BARRIERFSYNC).is_ok()
    {
        return Ok(());
    }
    nix::unistd::fsync(opened)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn sync(opened: &File) -> io::Result<()> {
    opened.sync_all()
}

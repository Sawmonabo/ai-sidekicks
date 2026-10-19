//! The disk on macOS and Linux: the free room on a folder's volume, whether that volume is a
//! network file system, a read at a file offset, and a written file (by path, or through a handle
//! already open with `flush_open_file`) or a changed folder flushed so it survives a power loss.

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

/// Whether `path` sits on a network file system (NFS, SMB, 9p, a FUSE mount on Linux; NFS, SMB,
/// AFP, FTP, web folders on macOS), where a change another computer makes raises no file event.
/// Reads the volume's type with `statfs`, which waits on a hung network mount; a FUSE volume that is
/// a virtual machine's shared folder (virtiofs), which tells its changes, is not one. Fails with the
/// system's error.
#[cfg(target_os = "linux")]
pub fn is_on_network_file_system(path: &Path) -> io::Result<bool> {
    use nix::sys::statfs::{FUSE_SUPER_MAGIC, FsType, NFS_SUPER_MAGIC, SMB_SUPER_MAGIC, statfs};

    // The kernel's numbers for CIFS, SMB2 and 9p, which nix does not name.
    const UNNAMED_NETWORK_TYPES: [u32; 3] = [0xFF53_4D42, 0xFE53_4D42, 0x0102_1997];
    let volume_type = statfs(path)?.filesystem_type();
    if volume_type == FUSE_SUPER_MAGIC {
        let mounts = std::fs::read_to_string("/proc/self/mountinfo")?;
        return Ok(mount_type_holding(&mounts, path) != Some("virtiofs"));
    }
    Ok([NFS_SUPER_MAGIC, SMB_SUPER_MAGIC].contains(&volume_type)
        || UNNAMED_NETWORK_TYPES
            .iter()
            .any(|network_type| volume_type == FsType((*network_type).into())))
}

// The file-system type of the mount in `mountinfo` (the text of `/proc/self/mountinfo`) whose
// mount point holds `path` most closely, `None` when no line reads. A line is `<id> <parent>
// <device> <root> <mount point> <options> [<optional fields>] - <type> <source> <options>`, its
// mount point with a space, tab, newline or backslash written as an octal escape.
#[cfg(target_os = "linux")]
fn mount_type_holding<'a>(mountinfo: &'a str, path: &Path) -> Option<&'a str> {
    mountinfo
        .lines()
        .filter_map(|line| {
            let (mount_fields, type_fields) = line.split_once(" - ")?;
            let mount_point = unescape_mount_point(mount_fields.split(' ').nth(4)?);
            let mount_type = type_fields.split(' ').next()?;
            path.starts_with(&mount_point)
                .then(|| (mount_point.components().count(), mount_type))
        })
        // A later line mounted over the same point wins, as the kernel resolves it.
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, mount_type)| mount_type)
}

// A mount point as `mountinfo` writes it, each `\ooo` octal escape read back to its byte.
#[cfg(target_os = "linux")]
fn unescape_mount_point(written: &str) -> std::path::PathBuf {
    use std::os::unix::ffi::OsStringExt;

    let bytes = written.as_bytes();
    let mut unescaped = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = bytes
            .get(index + 1..index + 4)
            .filter(|digits| {
                bytes[index] == b'\\' && digits.iter().all(|digit| (b'0'..=b'7').contains(digit))
            })
            .and_then(|digits| u8::from_str_radix(std::str::from_utf8(digits).ok()?, 8).ok());
        match escaped {
            Some(byte) => {
                unescaped.push(byte);
                index += 4;
            }
            None => {
                unescaped.push(bytes[index]);
                index += 1;
            }
        }
    }
    std::ffi::OsString::from_vec(unescaped).into()
}

/// Whether `path` sits on a network file system (NFS, SMB, 9p, a FUSE mount on Linux; NFS, SMB,
/// AFP, FTP, web folders on macOS), where a change another computer makes raises no file event.
/// Reads the volume's type name with `statfs`, which waits on a hung network mount. Fails with the
/// system's error.
#[cfg(target_os = "macos")]
pub fn is_on_network_file_system(path: &Path) -> io::Result<bool> {
    const NETWORK_TYPE_NAMES: [&str; 6] = ["nfs", "smbfs", "cifs", "afpfs", "webdav", "ftp"];
    let volume = nix::sys::statfs::statfs(path)?;
    Ok(NETWORK_TYPE_NAMES.contains(&volume.filesystem_type_name()))
}

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

// A file is closed when dropped; a failure a close could report is one the flush already reported.
fn flush_opened(path: &Path) -> io::Result<()> {
    let opened = File::open(path)?;
    flush_open_file(&opened)
}

/// Flushes `opened`, a file already open, to disk; any open works, a read-only one included. Fails
/// with the flush's error.
// macOS's `fsync` leaves the drive's own cache unflushed, so the full flush goes first; a file
// system that refuses it takes the barrier flush, then a plain `fsync`, so a share that has
// neither still flushes.
#[cfg(target_os = "macos")]
pub fn flush_open_file(opened: &File) -> io::Result<()> {
    use nix::fcntl::{FcntlArg, fcntl};

    if fcntl(opened, FcntlArg::F_FULLFSYNC).is_ok()
        || fcntl(opened, FcntlArg::F_BARRIERFSYNC).is_ok()
    {
        return Ok(());
    }
    nix::unistd::fsync(opened)?;
    Ok(())
}

/// Flushes `opened`, a file already open, to disk; any open works, a read-only one included. Fails
/// with the flush's error.
#[cfg(target_os = "linux")]
pub fn flush_open_file(opened: &File) -> io::Result<()> {
    opened.sync_all()
}

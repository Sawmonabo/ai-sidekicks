//! The disk on Windows: the free room on a folder's volume, and a written file flushed so it
//! survives a power loss; a folder has no flush there, and a rename is on disk when it returns.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows_sys::Wdk::Storage::FileSystem::{
    FileFsFullSizeInformation, NtQueryVolumeInformationFile,
};
use windows_sys::Wdk::System::SystemServices::FILE_FS_FULL_SIZE_INFORMATION;
use windows_sys::Win32::Foundation::RtlNtStatusToDosError;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use crate::windows::real_path::verbatim_path;

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

/// The bytes the calling account may still write on the volume holding `folder`, read through a
/// handle the folder opens by its verbatim path, so a folder past 260 characters or one whose name
/// ends in a dot needs no long-path manifest. Fails with `InvalidInput` when the path holds a NUL,
/// with `Other` when the count passes `u64`, and with the system's error when the folder cannot be
/// opened or its volume read.
pub fn volume_free_bytes(folder: &Path) -> io::Result<u64> {
    let verbatim = PathBuf::from(OsString::from_wide(&verbatim_path(folder)?));
    // The query needs no access right, and a folder opens only with backup semantics; std passes a
    // verbatim path to the system as it is.
    let opened = OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(verbatim)?;
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut size = FILE_FS_FULL_SIZE_INFORMATION::default();
    let size_length =
        u32::try_from(size_of::<FILE_FS_FULL_SIZE_INFORMATION>()).expect("the size fits in a u32");
    // SAFETY: the handle is the open folder's, alive for the call; the status block and the size
    // buffer are live locals of the lengths given, and the buffer's type is 8-byte aligned.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            opened.as_raw_handle(),
            &raw mut status_block,
            (&raw mut size).cast(),
            size_length,
            FileFsFullSizeInformation,
        )
    };
    if status < 0 {
        // SAFETY: the call takes one plain status value.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code.cast_signed()));
    }
    let free_units =
        u64::try_from(size.CallerAvailableAllocationUnits).map_err(io::Error::other)?;
    let unit_bytes = u64::from(size.SectorsPerAllocationUnit) * u64::from(size.BytesPerSector);
    free_units
        .checked_mul(unit_bytes)
        .ok_or_else(|| io::Error::other("the volume's free room passes 64 bits"))
}

/// Flushes the file at `path` to disk through a write open, which the flush needs; a read-only file
/// (git leaves its packs so) has the attribute cleared for the flush and set back. Fails with the
/// flush's error; when setting the attribute back failed too, the error keeps the flush's kind and
/// wraps a [`FlushFailure`] (reached with `get_ref` or `into_inner`), whose source is the flush's
/// failure. A failure clearing or setting back the attribute alone is its own error.
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

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};

    use rstest::rstest;

    use super::volume_free_bytes;

    enum FolderForm {
        PastMaxPath,
        NameEndingInDot,
        ForwardSlashVerbatim,
        ForwardSlashDevice,
    }

    // `folder` written after `prefix` with every `\` as `/`, as `//?/C:/x` or `//./C:/x`.
    fn forward_slash_form(prefix: &str, folder: &Path) -> PathBuf {
        let backslash = u16::from(b'\\');
        let units: Vec<u16> = prefix
            .encode_utf16()
            .chain(folder.as_os_str().encode_wide().map(|unit| {
                if unit == backslash {
                    u16::from(b'/')
                } else {
                    unit
                }
            }))
            .collect();
        PathBuf::from(OsString::from_wide(&units))
    }

    // Each folder is reached only through the verbatim path: the system's own parsing cuts a path
    // at 260 characters and drops a name's trailing dot, and a `//?/` or `//./` path read as a
    // share names no server.
    #[rstest]
    #[case::past_max_path(FolderForm::PastMaxPath)]
    #[case::name_ending_in_dot(FolderForm::NameEndingInDot)]
    #[case::forward_slash_verbatim(FolderForm::ForwardSlashVerbatim)]
    #[case::forward_slash_device(FolderForm::ForwardSlashDevice)]
    fn the_free_room_reads_on_a_folder_only_its_verbatim_path_reaches(#[case] form: FolderForm) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let asked = match form {
            FolderForm::PastMaxPath => {
                let folder = scratch
                    .path()
                    .join("a".repeat(100))
                    .join("b".repeat(100))
                    .join("c".repeat(100));
                fs::create_dir_all(&folder).expect("the folders are made");
                folder
            }
            FolderForm::NameEndingInDot => {
                let folder = scratch.path().join("name.");
                let mut verbatim = OsString::from(r"\\?\");
                verbatim.push(folder.as_os_str());
                fs::create_dir(PathBuf::from(verbatim)).expect("the folder is made");
                folder
            }
            FolderForm::ForwardSlashVerbatim => forward_slash_form("//?/", scratch.path()),
            FolderForm::ForwardSlashDevice => forward_slash_form("//./", scratch.path()),
        };
        volume_free_bytes(&asked).expect("the free room reads");
    }
}

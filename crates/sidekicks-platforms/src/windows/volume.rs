//! The volume holding a path on Windows: its root, read by the path's verbatim form, and its
//! volume GUID path, read through a handle open on the path.

use std::fs::File;
use std::io::{self, ErrorKind};
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, GetVolumePathNameW, VOLUME_NAME_GUID,
};

use crate::windows::real_path::verbatim_path;

// The UTF-16 units a volume GUID path's prefix takes before its first separator: `\\?\`.
const VERBATIM_PREFIX_UNITS: usize = 4;

// Room for a volume GUID path and a short path under it, grown when the path is longer.
const FIRST_PATH_UNITS: usize = 128;

/// The root of the volume holding `path`, read by the path's verbatim form, so it comes back
/// verbatim too (`\\?\C:\`, `\\?\UNC\server\share\`), as UTF-16 units ending in one NUL, the form a
/// system call takes it in. Fails with `InvalidInput` when the path holds a NUL, and with the
/// system's error when its volume cannot be read.
pub(crate) fn read_volume_root(path: &Path) -> io::Result<Vec<u16>> {
    let mut verbatim = verbatim_path(path)?;
    verbatim.push(0);
    // A volume's root is never longer than the path inside it, plus the separator the system adds
    // to a root given without one (`\\server\share` comes back `\\server\share\`).
    let mut volume_root = vec![0_u16; verbatim.len() + 1];
    let root_length = u32::try_from(volume_root.len()).map_err(io::Error::other)?;
    // SAFETY: `verbatim` is NUL-terminated, and `volume_root` is a live buffer of the length given.
    let is_read =
        unsafe { GetVolumePathNameW(verbatim.as_ptr(), volume_root.as_mut_ptr(), root_length) };
    if is_read == 0 {
        return Err(io::Error::last_os_error());
    }
    // The call wrote a NUL-terminated root, so a NUL is found.
    let end = volume_root
        .iter()
        .position(|&unit| unit == 0)
        .expect("the root read ends in a NUL");
    volume_root.truncate(end + 1);
    Ok(volume_root)
}

/// The volume GUID path (`\\?\Volume{…}\`) of the volume holding the open file or folder `file`,
/// read through its handle and cut after its first separator past the `\\?\` prefix, so two entries
/// on one volume read the same. Fails with the system's error, as a network share's file does, and
/// with `InvalidData` for a path with no separator past the prefix.
pub(crate) fn volume_guid_path(file: &File) -> io::Result<Vec<u16>> {
    let mut path = vec![0_u16; FIRST_PATH_UNITS];
    loop {
        let room = u32::try_from(path.len()).map_err(io::Error::other)?;
        // SAFETY: the handle is the open file's, alive for the call, and `path` is a live buffer
        // of the length given.
        let written = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                path.as_mut_ptr(),
                room,
                VOLUME_NAME_GUID,
            )
        };
        if written == 0 {
            return Err(io::Error::last_os_error());
        }
        let written = usize::try_from(written).map_err(io::Error::other)?;
        // A path that fits comes back without its NUL; one that does not answers the room it
        // needs, its NUL included.
        if written < path.len() {
            path.truncate(written);
            break;
        }
        path.resize(written, 0);
    }
    let separator = path
        .iter()
        .skip(VERBATIM_PREFIX_UNITS)
        .position(|&unit| unit == u16::from(b'\\'))
        .ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidData,
                "the volume GUID path holds no separator after its volume",
            )
        })?;
    path.truncate(VERBATIM_PREFIX_UNITS + separator + 1);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;

    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    use super::volume_guid_path;

    // Fails when the compare takes whole paths, which never match between a file and its folder,
    // or reads anything but the volume GUID path.
    #[test]
    fn a_file_and_its_folder_read_one_volume_guid_path() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let path = folder.path().join("file");
        fs::write(&path, b"a file").expect("the file is written");
        let file = File::open(&path).expect("the file opens");
        let opened_folder = OpenOptions::new()
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .read(true)
            .open(folder.path())
            .expect("the folder opens");

        let file_volume = volume_guid_path(&file).expect("the file's volume reads");
        assert_eq!(
            volume_guid_path(&opened_folder).expect("the folder's volume reads"),
            file_volume
        );
        let text = String::from_utf16(&file_volume).expect("the volume GUID path is text");
        assert!(
            text.starts_with(r"\\?\Volume{") && text.ends_with(r"}\"),
            "{text} is a volume GUID path"
        );
    }
}

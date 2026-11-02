//! A refused clone's error read on Windows, where the code alone cannot tell a clone across volumes
//! from one the volume cannot make: `ERROR_INVALID_FUNCTION` answers both whenever either end makes
//! no clones. So the two ends' volumes are compared first, by their volume GUID paths, and only
//! after the clone has failed.

use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_INVALID_FUNCTION;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
};

use crate::clone_refusal::CloneRefusal;
use crate::windows::volume::volume_guid_path;

// The high half of an HRESULT that wraps a Win32 code (`HRESULT_FROM_WIN32`): the failure bit and
// facility 7. reflink-copy's `DeviceIoControl` calls answer in this form.
const WIN32_HRESULT_HIGH_HALF: u32 = 0x8007_0000;

// The high half of an HRESULT, which holds its failure bit and its facility.
const HRESULT_HIGH_HALF_MASK: u32 = 0xFFFF_0000;

/// A clone failed, and so did reading which volume its source or its destination's folder is on.
#[derive(Debug, thiserror::Error)]
#[error("reading the clone's volumes failed too: {volume_read}")]
pub struct CloneVolumeReadFailure {
    /// The clone's own failure.
    #[source]
    pub clone: io::Error,
    /// The failure reading the source's or the destination folder's volume.
    pub volume_read: io::Error,
}

/// What `error`, from cloning `source` into a new file at `destination`, tells: a copy on another
/// volume when the volume GUID paths of the source and of the destination's folder differ, else a
/// volume that makes no clones for `ERROR_INVALID_FUNCTION`, plain or as an HRESULT. Fails with
/// `error` itself, unchanged, for the source's or the destination's own refusal (`AlreadyExists`,
/// `NotFound` or `PermissionDenied`, as std reads a plain code) and for any other code on one
/// volume. When a volume cannot be read, as a network share's cannot, fails with an error of the
/// clone's kind that wraps a [`CloneVolumeReadFailure`] (reached with `get_ref` or `into_inner`).
pub fn read_clone_refusal(
    source: &File,
    destination: &Path,
    error: io::Error,
) -> Result<CloneRefusal, io::Error> {
    refusal_of(error, || {
        let folder = destination
            .parent()
            .filter(|folder| !folder.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        // Opened as `file_facts` opens a file; a folder opens only with backup semantics.
        let opened_folder = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(folder)?;
        Ok(volume_guid_path(source)? == volume_guid_path(&opened_folder)?)
    })
}

// The refusal `error` tells, `is_one_volume` read only once the error is not an end's own refusal.
fn refusal_of(
    error: io::Error,
    is_one_volume: impl FnOnce() -> io::Result<bool>,
) -> Result<CloneRefusal, io::Error> {
    if matches!(
        error.kind(),
        ErrorKind::AlreadyExists | ErrorKind::NotFound | ErrorKind::PermissionDenied
    ) {
        return Err(error);
    }
    match is_one_volume() {
        Ok(false) => Ok(CloneRefusal::AcrossVolumes),
        Ok(true) if win32_code_of(&error) == Some(ERROR_INVALID_FUNCTION) => {
            Ok(CloneRefusal::Unsupported)
        }
        Ok(true) => Err(error),
        Err(volume_read) => Err(io::Error::new(
            error.kind(),
            CloneVolumeReadFailure {
                clone: error,
                volume_read,
            },
        )),
    }
}

// The Win32 code `error` carries, plain or wrapped in an HRESULT, whose low half it is.
fn win32_code_of(error: &io::Error) -> Option<u32> {
    let code = error.raw_os_error()?.cast_unsigned();
    if code & HRESULT_HIGH_HALF_MASK == WIN32_HRESULT_HIGH_HALF {
        Some(code & !HRESULT_HIGH_HALF_MASK)
    } else {
        Some(code)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, ErrorKind};

    use rstest::rstest;

    use super::{CloneVolumeReadFailure, refusal_of};
    use crate::clone_refusal::CloneRefusal;

    // `HRESULT_FROM_WIN32` of a code, as reflink-copy's `DeviceIoControl` calls answer it.
    fn hresult(code: u32) -> io::Error {
        io::Error::from_raw_os_error((0x8007_0000 | code).cast_signed())
    }

    // The clone-size error reflink-copy makes itself, with no code.
    fn cluster_size_error() -> io::Error {
        io::Error::other("Cluster size of source must either be 4K or 64K (restricted by ReFS)")
    }

    // Fails when the HRESULT form goes unread, when `ERROR_NOT_SUPPORTED` reads as a volume that
    // makes no clones, when the volume compare is skipped, and when an end's own refusal or a
    // failed volume read is answered as a refusal.
    #[rstest]
    #[case::invalid_function(
        io::Error::from_raw_os_error(1),
        Some(true),
        Some(CloneRefusal::Unsupported)
    )]
    #[case::invalid_function_hresult(hresult(1), Some(true), Some(CloneRefusal::Unsupported))]
    #[case::not_supported_hresult(hresult(50), Some(true), None)]
    #[case::invalid_parameter_hresult(hresult(87), Some(true), None)]
    #[case::invalid_function_across(hresult(1), Some(false), Some(CloneRefusal::AcrossVolumes))]
    #[case::invalid_parameter_across(hresult(87), Some(false), Some(CloneRefusal::AcrossVolumes))]
    #[case::already_there_across(io::Error::from(ErrorKind::AlreadyExists), Some(false), None)]
    #[case::cluster_size(cluster_size_error(), Some(true), None)]
    #[case::volume_unread(hresult(1), None, None)]
    fn a_clone_error_reads_as_its_refusal_or_comes_back(
        #[case] error: io::Error,
        #[case] is_one_volume: Option<bool>,
        #[case] expected: Option<CloneRefusal>,
    ) {
        let (kind, code, text) = (error.kind(), error.raw_os_error(), error.to_string());
        let read = refusal_of(error, || {
            is_one_volume.ok_or_else(|| io::Error::from(ErrorKind::Unsupported))
        });

        match read {
            Ok(refusal) => assert_eq!(Some(refusal), expected),
            Err(back) => {
                assert_eq!(expected, None, "a listed error reads as its refusal");
                assert_eq!(back.kind(), kind, "the error keeps the clone's kind");
                if is_one_volume.is_some() {
                    assert_eq!(
                        (back.raw_os_error(), back.to_string()),
                        (code, text),
                        "an unlisted error comes back unchanged"
                    );
                } else {
                    let failure = back
                        .get_ref()
                        .and_then(|inner| inner.downcast_ref::<CloneVolumeReadFailure>())
                        .expect("a failed volume read keeps both failures");
                    assert_eq!(failure.clone.raw_os_error(), code);
                    assert_eq!(failure.volume_read.kind(), ErrorKind::Unsupported);
                }
            }
        }
    }
}

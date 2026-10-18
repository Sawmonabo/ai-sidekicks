//! One record of what Windows keeps about an open file or folder, read through its handle.

use std::fs::File;
use std::io;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_INFO_BY_HANDLE_CLASS, GetFileInformationByHandleEx,
};

/// One record of `class` read from `file`'s handle; `Record` must be the record `class` fills
/// (`FILE_ID_INFO` for `FileIdInfo`). Fails with the system's error from the read.
pub(crate) fn read_information<Record: Default>(
    file: &File,
    class: FILE_INFO_BY_HANDLE_CLASS,
) -> io::Result<Record> {
    let mut record = Record::default();
    let length = u32::try_from(size_of::<Record>()).expect("the record's size fits in a u32");
    // SAFETY: the handle is the open file's, alive for the call; the buffer is a live `Record`,
    // the record `class` fills, of the length given.
    let has_record = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            class,
            (&raw mut record).cast(),
            length,
        )
    };
    if has_record == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(record)
}

//! The removal of a file's or a folder's access list on macOS, whose entries a mode change leaves
//! in place, so a folder made private keeps none it inherited from its parent.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

// `FILESEC_ACL` of the SDK's `filesec_property_t`: the access list a file security description
// carries.
const FILESEC_ACL: libc::c_int = 5;

// `_FILESEC_REMOVE_ACL`: the access list value that asks the change to remove the list.
const FILESEC_REMOVE_ACL: *const c_void = std::ptr::without_provenance(1);

unsafe extern "C" {
    // `filesec_t filesec_init(void)`, declared in the SDK's `sys/fcntl.h`: a new, empty file
    // security description, or NULL with `errno` set.
    fn filesec_init() -> *mut c_void;
    // `int filesec_set_property(filesec_t, filesec_property_t, const void *)`: sets one property of
    // the description, answering 0, or -1 with `errno` set.
    fn filesec_set_property(
        filesec: *mut c_void,
        property: libc::c_int,
        value: *const c_void,
    ) -> libc::c_int;
    // `void filesec_free(filesec_t)`: frees a description `filesec_init` made.
    fn filesec_free(filesec: *mut c_void);
    // `int fchmodx_np(int, filesec_t)`, declared in the SDK's `sys/stat.h`: applies the set
    // properties of the description to the open file, answering 0, or -1 with `errno` set.
    fn fchmodx_np(descriptor: libc::c_int, filesec: *mut c_void) -> libc::c_int;
}

/// Removes every entry of the access list of the open file or folder `file`, its inherited ones
/// included, leaving its owner and mode alone, as `chmod -N` does. Fails with the system's error.
pub(crate) fn remove_access_control_list(file: &File) -> io::Result<()> {
    // SAFETY: the call takes no argument and answers a description this function frees below.
    let filesec = unsafe { filesec_init() };
    if filesec.is_null() {
        return Err(io::Error::last_os_error());
    }
    let removed = apply_access_list_removal(file, filesec);
    // SAFETY: `filesec` was made by `filesec_init` and is freed once, after its last use.
    unsafe { filesec_free(filesec) };
    removed
}

// Sets the description `filesec` to remove the access list and applies it to `file`.
fn apply_access_list_removal(file: &File, filesec: *mut c_void) -> io::Result<()> {
    // SAFETY: `filesec` is a live description, and the remove value is the one the SDK defines for
    // this property.
    if unsafe { filesec_set_property(filesec, FILESEC_ACL, FILESEC_REMOVE_ACL) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor is the open file's, alive for the call, and `filesec` is live.
    if unsafe { fchmodx_np(file.as_raw_fd(), filesec) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

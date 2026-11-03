//! A file's or a folder's access list on macOS: its removal, whose entries a mode change leaves in
//! place, so a folder made private keeps none it inherited from its parent, and the read of whether
//! it lets another account remove or rename the entries of a folder.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

// `FILESEC_ACL` of the SDK's `filesec_property_t`: the access list a file security description
// carries.
const FILESEC_ACL: libc::c_int = 5;

// `_FILESEC_REMOVE_ACL`: the access list value that asks the change to remove the list.
const FILESEC_REMOVE_ACL: *const c_void = std::ptr::without_provenance(1);

// `ACL_TYPE_EXTENDED` of the SDK's `acl_type_t`: the access list kind macOS keeps.
const ACL_TYPE_EXTENDED: libc::c_int = 0x100;

// `ACL_FIRST_ENTRY` and `ACL_NEXT_ENTRY` of the SDK's `acl_entry_id_t`.
const ACL_FIRST_ENTRY: libc::c_int = 0;
const ACL_NEXT_ENTRY: libc::c_int = -1;

// `ACL_EXTENDED_ALLOW` of the SDK's `acl_tag_t`: an entry that grants what it names.
const ACL_EXTENDED_ALLOW: libc::c_int = 1;

// `ACL_DELETE_CHILD` of the SDK's `acl_perm_t`: the right to remove or rename a folder's entries.
const ACL_DELETE_CHILD: u64 = 1 << 6;

// `ACL_ENTRY_ONLY_INHERIT` of the SDK's `acl_flag_t`: an entry only passed down, which grants
// nothing on the folder itself.
const ACL_ENTRY_ONLY_INHERIT: libc::c_int = 1 << 8;

// The root account's id, whose access no access list can narrow.
const ROOT_USER_ID: libc::uid_t = 0;

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
    // `acl_t acl_get_fd_np(int, acl_type_t)`, declared in the SDK's `sys/acl.h`: the open file's
    // access list, which `acl_free` frees, or NULL with `errno` set: `ENOENT` when it has none,
    // `EOPNOTSUPP` when its volume keeps none.
    fn acl_get_fd_np(descriptor: libc::c_int, kind: libc::c_int) -> *mut c_void;
    // `int acl_get_entry(acl_t, int, acl_entry_t *)`: the list's first or next entry, answering 0,
    // or -1 once no entry is left.
    fn acl_get_entry(
        acl: *mut c_void,
        entry_id: libc::c_int,
        entry: *mut *mut c_void,
    ) -> libc::c_int;
    // `int acl_get_tag_type(acl_entry_t, acl_tag_t *)`: whether the entry allows or denies,
    // answering 0, or -1 with `errno` set.
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut libc::c_int) -> libc::c_int;
    // `int acl_get_permset_mask_np(acl_entry_t, acl_permset_mask_t *)`: the rights the entry
    // names, answering 0, or -1 with `errno` set.
    fn acl_get_permset_mask_np(entry: *mut c_void, mask: *mut u64) -> libc::c_int;
    // `int acl_get_flagset_np(void *, acl_flagset_t *)`: the entry's flags, answering 0, or -1
    // with `errno` set.
    fn acl_get_flagset_np(entry: *mut c_void, flagset: *mut *mut c_void) -> libc::c_int;
    // `int acl_get_flag_np(acl_flagset_t, acl_flag_t)`: 1 when the flag is set, 0 when not, or -1
    // with `errno` set.
    fn acl_get_flag_np(flagset: *mut c_void, flag: libc::c_int) -> libc::c_int;
    // `void *acl_get_qualifier(acl_entry_t)`: the 16-byte UUID of the account or group the entry
    // names, which `acl_free` frees, or NULL with `errno` set.
    fn acl_get_qualifier(entry: *mut c_void) -> *mut c_void;
    // `int acl_free(void *)`: frees what `acl_get_fd_np` or `acl_get_qualifier` answered.
    fn acl_free(object: *mut c_void) -> libc::c_int;
    // `int mbr_uid_to_uuid(uid_t, uuid_t)`, declared in the SDK's `membership.h`: the account's
    // UUID, answering 0, or the error's code.
    fn mbr_uid_to_uuid(user: libc::uid_t, uuid: *mut u8) -> libc::c_int;
}

/// Removes every entry of the access list of the open file or folder `file`, its inherited ones
/// included, leaving its owner and mode alone, as `chmod -N` does; on a volume that keeps no access
/// lists there is none to remove. Fails with the system's error.
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

/// Whether the access list of the open folder `folder` lets an account other than the user
/// `user` and root remove or rename its entries: an allowing entry that is not only passed down
/// and grants `delete_child` to any other account or group. A folder with no access list, or on a
/// volume that keeps none, grants none. Fails with the system's error.
pub(crate) fn grants_others_delete_child(folder: &File, user: libc::uid_t) -> io::Result<bool> {
    // SAFETY: the descriptor is the open folder's, alive for the call.
    let acl = unsafe { acl_get_fd_np(folder.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT | libc::EOPNOTSUPP) => Ok(false),
            _ => Err(error),
        };
    }
    let acl = AclObject(acl);
    let trusted = [account_uuid(user)?, account_uuid(ROOT_USER_ID)?];
    let mut entry_id = ACL_FIRST_ENTRY;
    let mut entry: *mut c_void = std::ptr::null_mut();
    // SAFETY: `acl` is a live list, and `entry` a live slot the call writes an entry of it into.
    while unsafe { acl_get_entry(acl.0, entry_id, &raw mut entry) } == 0 {
        entry_id = ACL_NEXT_ENTRY;
        if grants_delete_child(entry)? && !trusted.contains(&qualifier(entry)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

// Whether `entry`, of a live list, allows `delete_child` on the folder itself.
fn grants_delete_child(entry: *mut c_void) -> io::Result<bool> {
    let mut tag: libc::c_int = 0;
    // SAFETY: `entry` is an entry of a live list, and `tag` a live slot the call writes.
    if unsafe { acl_get_tag_type(entry, &raw mut tag) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut rights: u64 = 0;
    // SAFETY: as above, with `rights` the live slot.
    if unsafe { acl_get_permset_mask_np(entry, &raw mut rights) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut flags: *mut c_void = std::ptr::null_mut();
    // SAFETY: as above, with `flags` the live slot, which then points into the entry.
    if unsafe { acl_get_flagset_np(entry, &raw mut flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `flags` is the live entry's flag set the call above answered.
    let is_only_passed_down = match unsafe { acl_get_flag_np(flags, ACL_ENTRY_ONLY_INHERIT) } {
        -1 => return Err(io::Error::last_os_error()),
        flag => flag == 1,
    };
    Ok(tag == ACL_EXTENDED_ALLOW && rights & ACL_DELETE_CHILD != 0 && !is_only_passed_down)
}

// The UUID of the account or group `entry`, of a live list, names.
fn qualifier(entry: *mut c_void) -> io::Result<[u8; 16]> {
    // SAFETY: `entry` is an entry of a live list.
    let named = unsafe { acl_get_qualifier(entry) };
    if named.is_null() {
        return Err(io::Error::last_os_error());
    }
    let named = AclObject(named);
    // SAFETY: an extended entry's qualifier is a 16-byte UUID, live until `named` drops.
    Ok(unsafe { named.0.cast::<[u8; 16]>().read() })
}

// The UUID of the account whose id is `user`.
fn account_uuid(user: libc::uid_t) -> io::Result<[u8; 16]> {
    let mut uuid = [0_u8; 16];
    // SAFETY: `uuid` is a live 16-byte buffer, the `uuid_t` the call writes.
    match unsafe { mbr_uid_to_uuid(user, uuid.as_mut_ptr()) } {
        0 => Ok(uuid),
        code => Err(io::Error::from_raw_os_error(code)),
    }
}

// What `acl_get_fd_np` or `acl_get_qualifier` answered, freed once when dropped.
struct AclObject(*mut c_void);

impl Drop for AclObject {
    fn drop(&mut self) {
        // SAFETY: the pointer came from an `acl_*` call that hands its caller the object to free,
        // and it is freed only here. A failed free leaves nothing for the caller to do.
        unsafe { acl_free(self.0) };
    }
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
        let error = io::Error::last_os_error();
        // The kernel answers `ENOTSUP` to any access list change on a volume that keeps none.
        if error.raw_os_error() == Some(libc::ENOTSUP) {
            return Ok(());
        }
        return Err(error);
    }
    Ok(())
}

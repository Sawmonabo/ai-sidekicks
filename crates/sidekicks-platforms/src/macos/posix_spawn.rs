//! What macOS's `posix_spawn` takes, owned: its attributes and its file actions, each destroyed
//! when dropped, and the `NULL`-terminated arrays its arguments and environment pass as.

use std::ffi::{CString, c_char, c_int, c_short};
use std::io;

/// A spawn's attributes, destroyed when this drops. macOS's attributes object is a pointer to
/// memory the system owns, so moving this moves only the pointer.
pub(crate) struct SpawnAttributes(libc::posix_spawnattr_t);

impl SpawnAttributes {
    /// Fresh attributes, every flag clear. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        // SAFETY: `attributes` is a live, writable attributes object for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawnattr_init(&raw mut attributes) })?;
        Ok(Self(attributes))
    }

    /// Sets the spawn's flags to `flags`, replacing any set before. Fails with the error code the
    /// system answers.
    pub(crate) fn set_flags(&mut self, flags: c_int) -> io::Result<()> {
        let flags = c_short::try_from(flags).expect("the spawn flags fit the flags' short");
        // SAFETY: the attributes were set up by `new` and live as long as `self`.
        check_spawn_status(unsafe { libc::posix_spawnattr_setflags(self.as_mut_ptr(), flags) })
    }

    /// The attributes, for a call that sets one of them.
    pub(crate) fn as_mut_ptr(&mut self) -> *mut libc::posix_spawnattr_t {
        &raw mut self.0
    }

    /// The attributes, for the spawn.
    pub(crate) fn as_ptr(&self) -> *const libc::posix_spawnattr_t {
        &raw const self.0
    }
}

impl Drop for SpawnAttributes {
    fn drop(&mut self) {
        // SAFETY: the attributes were set up by `new` and are destroyed only here. The call frees
        // memory and cannot fail on a set-up object.
        unsafe { libc::posix_spawnattr_destroy(self.as_mut_ptr()) };
    }
}

/// A spawn's file actions, run in order in the child before its program, destroyed when this
/// drops; a pointer to memory the system owns, as [`SpawnAttributes`] is.
pub(crate) struct SpawnFileActions(libc::posix_spawn_file_actions_t);

impl SpawnFileActions {
    /// An empty list of file actions. Fails with the error code the system answers.
    pub(crate) fn new() -> io::Result<Self> {
        let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
        // SAFETY: `actions` is a live, writable file-actions object for the call to set up.
        check_spawn_status(unsafe { libc::posix_spawn_file_actions_init(&raw mut actions) })?;
        Ok(Self(actions))
    }

    /// The file actions, for a call that adds one.
    pub(crate) fn as_mut_ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
        &raw mut self.0
    }

    /// The file actions, for the spawn.
    pub(crate) fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
        &raw const self.0
    }
}

impl Drop for SpawnFileActions {
    fn drop(&mut self) {
        // SAFETY: the file actions were set up by `new` and are destroyed only here. The call frees
        // memory and cannot fail on a set-up object.
        unsafe { libc::posix_spawn_file_actions_destroy(self.as_mut_ptr()) };
    }
}

/// `Ok` for a spawn call's status of 0, else the error its code names.
pub(crate) fn check_spawn_status(status: c_int) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status))
    }
}

/// Pointers to `strings`, followed by the `NULL` a spawn's arrays end with; valid as long as
/// `strings` lives unchanged.
pub(crate) fn null_terminated(strings: &[CString]) -> Vec<*mut c_char> {
    strings
        .iter()
        .map(|string| string.as_ptr().cast_mut())
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect()
}

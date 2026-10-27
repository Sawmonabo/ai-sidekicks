//! The symbols this process's loaded images export, looked up by name.

use std::ffi::CStr;

/// The address of `name` in the loaded images, `None` when no image exports it.
pub(crate) fn look_up_symbol(name: &CStr) -> Option<*mut libc::c_void> {
    // SAFETY: `RTLD_DEFAULT` searches every loaded image, and the name is a C string.
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!symbol.is_null()).then_some(symbol)
}

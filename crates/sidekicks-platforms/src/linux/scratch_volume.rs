//! A scratch volume on Linux: a memory-backed file system needs a mount namespace, which a
//! multithreaded test cannot enter, so the test runs again alone in a child that makes its own user
//! and mount namespaces before its program starts and mounts the file system there.

use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::linux::user_namespace::{
    can_create_user_namespace, check_step, enter_own_user_namespace, own_id_maps,
};
use crate::scratch_volume::ScratchVolume;
use crate::test_program::this_test_arguments;

// The variable that hands the child its parent's root folder, and marks it as the run that holds
// the volume.
const ROOT_VARIABLE: &str = "SIDEKICKS_SCRATCH_VOLUME_ROOT";

// The memory-backed file system, its type and its source both, which a user namespace may mount.
const MEMORY_FILE_SYSTEM: &CStr = c"tmpfs";

/// In the child, the volume its parent mounted; in a test, `None` once this test program ran the
/// test `test_name` again in a child with a memory-backed file system at `mount_at` under a fresh
/// root folder, or at once where this user may not make a user namespace. Panics when the check,
/// the root folder or the child's start fails, or the child's run fails.
pub(crate) fn run_test_on_scratch_volume(
    test_name: &str,
    mount_at: &Path,
) -> Option<ScratchVolume> {
    if let Some(root) = std::env::var_os(ROOT_VARIABLE) {
        let root = PathBuf::from(root);
        return Some(ScratchVolume {
            mount_point: root.join(mount_at),
            root,
            _attachment: (),
        });
    }
    if !can_create_user_namespace().expect("the user-namespace check runs") {
        return None;
    }
    let root = tempfile::tempdir().expect("the volume's root folder is made");
    let mount_point = root.path().join(mount_at);
    std::fs::create_dir_all(&mount_point).expect("the mount folder is made");
    let mount_point = CString::new(mount_point.as_os_str().as_bytes())
        .expect("a temporary folder's path holds no NUL");
    let (user_map, group_map) = own_id_maps();
    let mut command = Command::new(std::env::current_exe().expect("the test program names itself"));
    command
        .args(this_test_arguments(test_name))
        .env(ROOT_VARIABLE, root.path());
    // SAFETY: the closure runs in the forked child before any exec and makes only `unshare`,
    // `open`, `write`, `close` and `mount`, on bytes made before the fork, so it allocates nothing.
    unsafe {
        command.pre_exec(move || {
            enter_own_user_namespace(&user_map, &group_map)?;
            check_step(libc::unshare(libc::CLONE_NEWNS))?;
            check_step(libc::mount(
                MEMORY_FILE_SYSTEM.as_ptr(),
                mount_point.as_ptr(),
                MEMORY_FILE_SYSTEM.as_ptr(),
                0,
                std::ptr::null(),
            ))
        });
    }
    let output = command
        .output()
        .expect("the test starts again on a scratch volume");
    assert!(
        output.status.success(),
        "the run on a scratch volume failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    None
}

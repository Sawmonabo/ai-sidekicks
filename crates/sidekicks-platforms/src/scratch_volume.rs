//! A scratch volume for a test that renames or copies across volumes: a fresh, empty file system
//! mounted at a folder under a test's root folder, so a rename from the root into it fails as a
//! rename across volumes does. Built where the system can make one without root: an attached disk
//! image on macOS, and on Linux a memory-backed file system inside a child's own namespaces.

use std::path::{Path, PathBuf};

/// A folder on the ordinary volume with a scratch volume mounted at a folder under it; the volume
/// goes away when this is dropped.
pub struct ScratchVolume {
    /// The folder on the ordinary volume the test builds in.
    pub(crate) root: PathBuf,
    /// The folder under `root` the scratch volume is mounted at.
    pub(crate) mount_point: PathBuf,
    /// What ends the volume and removes `root` when this is dropped.
    pub(crate) _attachment: Attachment,
}

/// What ends a scratch volume: on macOS the attached image and the folders it sits in.
#[cfg(target_os = "macos")]
pub(crate) type Attachment = crate::macos::scratch_volume::ImageAttachment;

/// What ends a scratch volume: nothing off macOS, since a Linux child's mount ends with its
/// process and its parent removes the root folder.
#[cfg(not(target_os = "macos"))]
pub(crate) type Attachment = ();

impl ScratchVolume {
    /// The folder on the ordinary volume the test builds in.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The folder under [`root`](Self::root) the scratch volume is mounted at.
    pub fn mount_point(&self) -> &Path {
        &self.mount_point
    }
}

/// A scratch volume mounted at `mount_at`, a relative path under a fresh root folder, for the test
/// named `test_name` (as [`harness_test_name`](crate::harness_test_name) names it). On macOS an
/// APFS disk image is attached there. On Linux this test program runs again on that test alone in
/// a child holding its own user and mount namespaces, with a memory-backed file system mounted
/// there: the call answers the volume in that child, and here asserts the child passed and answers
/// `None`, so the test body runs once. `None` where the system cannot make one without root:
/// Windows, and Linux where user namespaces are refused. Panics when the volume cannot be made or
/// the child's run fails.
pub fn scratch_volume(test_name: &str, mount_at: &Path) -> Option<ScratchVolume> {
    #[cfg(target_os = "linux")]
    {
        crate::linux::scratch_volume::run_test_on_scratch_volume(test_name, mount_at)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = test_name;
        Some(crate::macos::scratch_volume::attach_scratch_volume(
            mount_at,
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (test_name, mount_at);
        None
    }
}

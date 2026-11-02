//! The volume holding a path on Linux, read from the mount table: the deepest mount holding it.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use crate::linux::mount_info::{MOUNT_INFO_PATH, mount_holding};
use crate::volume::{Volume, VolumeId};

/// The volume holding `path`, a real path as [`real_path`](crate::real_path) gives it: its top is
/// the mount point of the deepest mount holding the path, and its id that mount's source, root and
/// file system type as the mount table writes them. Fails with the table's read error, and with
/// `NotFound` when no mount holds the path.
pub fn read_volume(path: &Path) -> io::Result<Volume> {
    let mount_info = fs::read_to_string(MOUNT_INFO_PATH)?;
    let mount = mount_holding(&mount_info, path).ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            format!("no mount holds {}", path.display()),
        )
    })?;
    Ok(Volume {
        id: VolumeId::new(format!(
            "{} {} {}",
            mount.source, mount.written_root, mount.file_system_type
        )),
        top: mount.mount_point,
    })
}

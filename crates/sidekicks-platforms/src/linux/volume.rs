//! The volume holding a path on Linux, read from the mount table: the mount a lookup of the path
//! ends in, its device known by its file system's UUID where it has one.

use std::borrow::Cow;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use crate::linux::mount_info::{MOUNT_INFO_PATH, mount_holding};
use crate::real_path;
use crate::volume::{Volume, VolumeId};

// The folder of links udev names by each file system's UUID, each to its device node.
const DEVICES_BY_UUID_FOLDER: &str = "/dev/disk/by-uuid";

/// The volume holding `path`, a real path as [`real_path`](crate::real_path) gives it: its top is
/// the mount point of the mount a lookup of the path ends in, and its id that mount's source, root
/// and file system type as the mount table writes them, a device node's source written as
/// `UUID=<its file system's UUID>` where udev names one, so a disk plugged in again under another
/// node keeps its id. Fails with the table's or the device folder's read error, and with
/// `NotFound` when no mount holds the path.
pub fn read_volume(path: &Path) -> io::Result<Volume> {
    let mount_info = fs::read_to_string(MOUNT_INFO_PATH)?;
    let mount = mount_holding(&mount_info, path).ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            format!("no mount holds {}", path.display()),
        )
    })?;
    let source = if mount.source.starts_with("/dev/") {
        stable_source(Path::new(DEVICES_BY_UUID_FOLDER), mount.source)?
    } else {
        Cow::Borrowed(mount.source)
    };
    Ok(Volume {
        id: VolumeId::new(format!(
            "{source} {} {}",
            mount.written_root, mount.file_system_type
        )),
        top: mount.mount_point,
    })
}

// The device node `source` as `UUID=<uuid>` when a link in `by_uuid_folder` resolves to it, else
// `source` itself, as for a node or a folder of links this system lacks.
fn stable_source<'a>(by_uuid_folder: &Path, source: &'a str) -> io::Result<Cow<'a, str>> {
    let device = match real_path(Path::new(source)) {
        Ok(device) => device,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Cow::Borrowed(source)),
        Err(error) => return Err(error),
    };
    let links = match fs::read_dir(by_uuid_folder) {
        Ok(links) => links,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Cow::Borrowed(source)),
        Err(error) => return Err(error),
    };
    for link in links {
        let link = link?;
        // A link whose device went since the listing names no device.
        match real_path(&link.path()) {
            Ok(target) if target == device => {
                return Ok(Cow::Owned(format!(
                    "UUID={}",
                    link.file_name().to_string_lossy()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(Cow::Borrowed(source))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::stable_source;

    // Fails when a device node's source is kept although a link names its file system's UUID, or
    // when a node no link names, or a missing one, is not kept as written.
    #[test]
    fn a_device_node_reads_as_the_uuid_its_link_names() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let by_uuid = scratch.path().join("by-uuid");
        fs::create_dir(&by_uuid).expect("the link folder is made");
        let named = scratch.path().join("sdb1");
        let unnamed = scratch.path().join("sdc1");
        fs::write(&named, b"").expect("the named node is written");
        fs::write(&unnamed, b"").expect("the unnamed node is written");
        symlink("../sdb1", by_uuid.join("1234-ABCD")).expect("the link is made");
        let missing = scratch.path().join("gone");

        for (source, expected) in [
            (named.to_string_lossy(), "UUID=1234-ABCD".to_owned()),
            (
                unnamed.to_string_lossy(),
                unnamed.to_string_lossy().into_owned(),
            ),
            (
                missing.to_string_lossy(),
                missing.to_string_lossy().into_owned(),
            ),
        ] {
            assert_eq!(
                stable_source(&by_uuid, &source).expect("the source reads"),
                expected
            );
        }
    }
}

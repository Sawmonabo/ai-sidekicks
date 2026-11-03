//! The volume holding a path on macOS: its mount point, read with `statfs`, and its UUID, read with
//! `getattrlist` from that mount point, since a volume's attributes are read only at its root.

use std::ffi::{CStr, OsStr};
use std::fmt::Write as _;
use std::io::{self, ErrorKind};
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use crate::posix::c_string::c_string;
use crate::volume::{Volume, VolumeId};

// What `getattrlist` writes for the attributes asked: the length it filled, the attributes it
// returned, then the volume's UUID, which a volume without one (a network share) leaves out.
#[repr(C)]
struct VolumeUuidReply {
    length: u32,
    returned: libc::attribute_set_t,
    uuid: libc::uuid_t,
}

/// The volume holding `path`, a real path as [`real_path`](crate::real_path) gives it: its top is
/// the mount point `statfs` names, and its id the volume's UUID read at that top. Fails with
/// `Unsupported` for a volume with no UUID, as a network share is, `InvalidInput` when the path
/// holds a NUL, and the system's error otherwise.
pub fn read_volume(path: &Path) -> io::Result<Volume> {
    let top = read_mount_point(path)?;
    let uuid = read_volume_uuid(&top)?;
    Ok(Volume {
        top,
        id: VolumeId::new(uuid_text(&uuid)),
    })
}

/// The mount point of the volume holding `path`, as `statfs` names it, which is a network share's
/// root for a path on one. Fails with `InvalidInput` when the path holds a NUL, and the system's
/// error otherwise.
pub(crate) fn read_mount_point(path: &Path) -> io::Result<PathBuf> {
    let path = c_string(path.as_os_str())?;
    // SAFETY: an all-zero `statfs` is a valid value of plain integers and arrays.
    let mut volume: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: the path is a live NUL-ended string, and the record a live `statfs` the call fills.
    if unsafe { libc::statfs(path.as_ptr(), &raw mut volume) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let bytes = volume.f_mntonname.map(libc::c_char::cast_unsigned);
    let mount_point = CStr::from_bytes_until_nul(&bytes)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    Ok(PathBuf::from(OsStr::from_bytes(mount_point.to_bytes())))
}

// The UUID of the volume whose root is `top`; asked of any other folder, the read fails with
// `EINVAL`.
fn read_volume_uuid(top: &Path) -> io::Result<libc::uuid_t> {
    let top = c_string(top.as_os_str())?;
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut reply = VolumeUuidReply {
        length: 0,
        returned: libc::attribute_set_t {
            commonattr: 0,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        },
        uuid: [0; 16],
    };
    // SAFETY: the path is a live NUL-ended string, the request a live `attrlist`, and the reply a
    // live buffer of the size given, laid out as the call packs the attributes asked.
    let status = unsafe {
        libc::getattrlist(
            top.as_ptr(),
            (&raw mut request).cast(),
            (&raw mut reply).cast(),
            size_of::<VolumeUuidReply>(),
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if reply.returned.volattr & libc::ATTR_VOL_UUID == 0 {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "the volume has no UUID, as a network share has none",
        ));
    }
    Ok(reply.uuid)
}

// The UUID as 36 characters, uppercase and hyphenated: 8-4-4-4-12 hexadecimal digits.
fn uuid_text(uuid: &libc::uuid_t) -> String {
    let mut text = String::with_capacity(36);
    for (index, byte) in uuid.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        write!(text, "{byte:02X}").expect("a string takes any text written to it");
    }
    text
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::read_volume;
    use crate::{harness_test_name, real_path, scratch_volume};

    // Fails when the volume attribute is asked of the path rather than its top, which answers
    // `EINVAL`, or when the id is fixed or built from the path.
    #[test]
    fn a_volume_id_holds_across_reads_and_differs_on_another_volume() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = real_path(folder.path()).expect("the folder resolves");

        let first = read_volume(&path).expect("the folder's volume reads");
        let again = read_volume(&path).expect("the folder's volume reads again");
        let text = first.id.to_string();
        let groups: Vec<usize> = text.split('-').map(str::len).collect();

        assert_eq!(first, again);
        assert_eq!(groups, [8, 4, 4, 4, 12], "{text} is a hyphenated UUID");
        assert!(
            text.chars()
                .all(|character| character == '-' || matches!(character, '0'..='9' | 'A'..='F')),
            "{text} is uppercase hexadecimal"
        );
        let scratch = scratch_volume(
            &harness_test_name(
                module_path!(),
                "a_volume_id_holds_across_reads_and_differs_on_another_volume",
            ),
            Path::new("volume"),
        )
        .expect("macOS makes a scratch volume");
        let mount_point = real_path(scratch.mount_point()).expect("the mount point resolves");
        let other = read_volume(&mount_point).expect("the scratch volume reads");
        assert_eq!(other.top, mount_point);
        assert_ne!(other.id, first.id);
    }
}

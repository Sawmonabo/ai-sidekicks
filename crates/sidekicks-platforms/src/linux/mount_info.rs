//! The mount table of this process's mount namespace, read from `/proc/self/mountinfo`: each line
//! one mount, `<id> <parent> <device> <root> <mount point> <options> [<optional fields>] - <type>
//! <source> <options>`, a space, tab, newline or backslash in a path written as an octal escape.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt as _;
use std::path::{Path, PathBuf};

use crate::linux::unescape_mount_point;

/// The mount table of this process's mount namespace, one mount per line with its root.
pub(crate) const MOUNT_INFO_PATH: &str = "/proc/self/mountinfo";

/// One mount of the table: where it sits, the folder of its file system it shows there, and what
/// it mounts, the last three as the table writes them, so text built from them holds no space.
pub(crate) struct MountEntry<'a> {
    /// The folder the mount sits at, decoded.
    pub(crate) mount_point: PathBuf,
    /// The folder of its file system the mount shows at its mount point, decoded.
    pub(crate) root: PathBuf,
    /// That root as the table writes it, still escaped.
    pub(crate) written_root: &'a str,
    /// The file system's type (`ext4`, `cgroup2`), as written.
    pub(crate) file_system_type: &'a str,
    /// What is mounted, a device or a name the file system takes, as written.
    pub(crate) source: &'a str,
}

/// Each mount the table text `mount_info` lists, in its order; a line without the ` - ` separator
/// or with too few fields is skipped.
pub(crate) fn mount_entries(mount_info: &str) -> impl Iterator<Item = MountEntry<'_>> {
    mount_info.lines().filter_map(read_entry)
}

/// The mount in `mount_info` whose mount point holds `path` most deeply, compared by components;
/// `None` when none holds it.
pub(crate) fn mount_holding<'a>(mount_info: &'a str, path: &Path) -> Option<MountEntry<'a>> {
    mount_entries(mount_info)
        .filter(|entry| path.starts_with(&entry.mount_point))
        // `max_by_key` keeps the last of equal keys, so of two mounts stacked on one point the later
        // line wins, as the kernel resolves it.
        .max_by_key(|entry| entry.mount_point.components().count())
}

// One line's mount: before the separator the fourth field is the root and the fifth the mount
// point, ahead of any optional field; after it, the type and then the source.
fn read_entry(line: &str) -> Option<MountEntry<'_>> {
    let (mount_fields, file_system_fields) = line.split_once(" - ")?;
    let mut mount_fields = mount_fields.split(' ').skip(3);
    let written_root = mount_fields.next()?;
    let written_mount_point = mount_fields.next()?;
    let mut file_system_fields = file_system_fields.split(' ');
    let file_system_type = file_system_fields.next()?;
    let source = file_system_fields.next()?;
    Some(MountEntry {
        mount_point: decode(written_mount_point),
        root: decode(written_root),
        written_root,
        file_system_type,
        source,
    })
}

fn decode(written: &str) -> PathBuf {
    PathBuf::from(OsString::from_vec(unescape_mount_point(written.as_bytes())))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::mount_holding;

    const ROOT_LINE: &str = "21 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n";

    // Fails when a mount point is matched as a string prefix, the earlier of two stacked lines is
    // kept, a field is read from the wrong place, a mount point is left escaped, or the root, type
    // or source is decoded, so an id built from them could hold a space.
    #[rstest]
    #[case::deepest_over_root(
        "30 21 8:2 / /mnt/data rw - xfs /dev/sdb1 rw",
        "/mnt/data/f",
        ("/mnt/data", "/", "xfs", "/dev/sdb1")
    )]
    #[case::later_stacked_line(
        "30 21 0:40 / /mnt/s rw - tmpfs first rw\n31 30 0:41 / /mnt/s rw - tmpfs second rw",
        "/mnt/s/f",
        ("/mnt/s", "/", "tmpfs", "second")
    )]
    #[case::escaped_mount_point(
        "30 21 8:3 / /mnt/my\\040disk rw - ext4 /dev/sdc1 rw",
        "/mnt/my disk/f",
        ("/mnt/my disk", "/", "ext4", "/dev/sdc1")
    )]
    #[case::sibling_name_prefix(
        "30 21 8:2 / /mnt/a rw - xfs /dev/sdb1 rw",
        "/mnt/ab/f",
        ("/", "/", "ext4", "/dev/sda1")
    )]
    #[case::optional_fields(
        "30 21 8:4 /sub /mnt/b rw shared:1 master:2 - btrfs /dev/sdd1 rw",
        "/mnt/b/f",
        ("/mnt/b", "/sub", "btrfs", "/dev/sdd1")
    )]
    #[case::no_separator(
        "30 21 8:2 / /mnt/c rw xfs /dev/sdb1 rw",
        "/mnt/c/f",
        ("/", "/", "ext4", "/dev/sda1")
    )]
    #[case::id_parts_as_written(
        "30 21 0:42 /a\\040b /mnt/d rw - ext4 my\\040source rw",
        "/mnt/d/f",
        ("/mnt/d", "/a\\040b", "ext4", "my\\040source")
    )]
    fn the_deepest_mount_holding_a_path_is_found_with_its_id_parts_as_written(
        #[case] mounts: &str,
        #[case] path: &str,
        #[case] expected: (&str, &str, &str, &str),
    ) {
        let mount_info = format!("{ROOT_LINE}{mounts}\n");

        let entry = mount_holding(&mount_info, Path::new(path)).expect("a mount holds the path");

        assert_eq!(
            (
                entry.mount_point.as_path(),
                entry.written_root,
                entry.file_system_type,
                entry.source
            ),
            (Path::new(expected.0), expected.1, expected.2, expected.3)
        );
    }
}

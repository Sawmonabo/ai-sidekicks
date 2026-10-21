//! A symbolic link made again at another path, pointing where the original points.

use std::fs;
use std::io;
use std::path::Path;

/// Makes a symbolic link at `destination` pointing where the link `source_link` points, its target
/// copied as written, so a relative or dangling target stays one; on Windows a folder link stays a
/// folder link and a file link a file link, by the source link's own kind. Fails with
/// `AlreadyExists` when anything is at `destination`, else with the read's or the make's error.
pub fn recreate_link(source_link: &Path, destination: &Path) -> io::Result<()> {
    let target = fs::read_link(source_link)?;
    #[cfg(unix)]
    return std::os::unix::fs::symlink(&target, destination);
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt as _;
        if fs::symlink_metadata(source_link)?
            .file_type()
            .is_symlink_dir()
        {
            std::os::windows::fs::symlink_dir(&target, destination)
        } else {
            std::os::windows::fs::symlink_file(&target, destination)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;

    use super::recreate_link;
    use crate::make_folder_link;

    #[test]
    fn a_dangling_relative_link_is_made_again_as_written_and_never_over_an_entry() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source_link = scratch.path().join("source-link");
        make_folder_link(Path::new("../gone"), &source_link).expect("the source link is made");
        let destination = scratch.path().join("copy");

        recreate_link(&source_link, &destination).expect("the link is made again");

        assert_eq!(
            fs::read_link(&destination).expect("the copy is a link"),
            Path::new("../gone")
        );
        let refusal = recreate_link(&source_link, &destination)
            .expect_err("a link is never made over an entry");
        assert_eq!(refusal.kind(), io::ErrorKind::AlreadyExists);
    }
}

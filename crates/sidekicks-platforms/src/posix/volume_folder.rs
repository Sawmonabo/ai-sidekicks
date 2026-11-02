//! This user's own folder on a volume, on macOS and Linux: `.ai-sidekicks-<uid>`, made readable by
//! its owner alone or found and made so again, and refused where a link, a file or another user's
//! folder holds the name.

use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use nix::unistd::getuid;

use crate::posix::error_codes::is_link_loop;
use crate::posix::private_folder::{PRIVATE_FOLDER_MODE, create_new_private_folder};
use crate::volume::user_folder_name;

/// Makes or finds this user's folder `.ai-sidekicks-<uid>` in `place`, readable by its owner alone,
/// and answers its path; a folder the user made earlier with other bits is made private again.
/// Answers `None` where `place` refuses the make (`EACCES`, `EPERM`, `EROFS`) or a link, a file or
/// another user's folder holds the name; fails with any other error.
pub(crate) fn create_user_folder_in(place: &Path) -> io::Result<Option<PathBuf>> {
    let user = getuid();
    let folder = place.join(user_folder_name(user));
    if let Err(error) = create_new_private_folder(&folder) {
        if is_refusal(&error) {
            return Ok(None);
        }
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    // Opened without following a link, so the owner read and the mode change reach the entry at
    // the name itself: a link there answers `ELOOP`, a file `ENOTDIR`.
    let opened = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&folder)
    {
        Ok(opened) => opened,
        Err(error)
            if is_refusal(&error)
                || error.kind() == ErrorKind::NotADirectory
                || is_link_loop(&error) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if opened.metadata()?.uid() != user.as_raw() {
        return Ok(None);
    }
    opened.set_permissions(Permissions::from_mode(PRIVATE_FOLDER_MODE))?;
    Ok(Some(folder))
}

/// Whether this user owns `folder`, read without following a link. Fails with the read's error.
pub(crate) fn is_owned_by_user(folder: &Path) -> io::Result<bool> {
    Ok(fs::symlink_metadata(folder)?.uid() == getuid().as_raw())
}

// Whether `error` is the system's refusal to let this user write there: `EACCES` or `EPERM`, which
// std reads as `PermissionDenied`, or `EROFS`.
fn is_refusal(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
    )
}

#[cfg(test)]
mod tests {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    use rstest::rstest;

    use super::create_user_folder_in;
    use crate::{is_superuser, make_folder_link, make_unwritable};

    fn user_folder(place: &Path) -> PathBuf {
        place.join(format!(".ai-sidekicks-{}", nix::unistd::getuid()))
    }

    fn mode_of(path: &Path) -> u32 {
        fs::symlink_metadata(path)
            .expect("the entry reads")
            .permissions()
            .mode()
            & 0o777
    }

    // Fails when the mode change through the handle goes, so a folder the user left open stays
    // open.
    #[test]
    fn a_place_gets_the_user_s_private_folder_made_or_made_private_again() {
        let place = tempfile::tempdir().expect("a scratch folder");
        let folder = user_folder(place.path());

        let made = create_user_folder_in(place.path()).expect("the folder is made");
        assert_eq!(made.as_deref(), Some(folder.as_path()));
        assert_eq!(mode_of(&folder), 0o700);
        fs::set_permissions(&folder, Permissions::from_mode(0o755)).expect("the folder opens up");
        let found = create_user_folder_in(place.path()).expect("the folder is found");
        assert_eq!(found.as_deref(), Some(folder.as_path()));
        assert_eq!(mode_of(&folder), 0o700);
    }

    // Fails when the open follows a link, which makes the link's target private and answers it,
    // or a file at the name comes back as an error.
    #[rstest]
    #[case::folder_link(true)]
    #[case::file(false)]
    fn an_entry_at_the_name_that_is_not_the_user_s_folder_is_refused(#[case] is_link: bool) {
        let place = tempfile::tempdir().expect("a scratch folder");
        let target = tempfile::tempdir().expect("a link's target");
        fs::set_permissions(target.path(), Permissions::from_mode(0o755))
            .expect("the target opens up");
        let folder = user_folder(place.path());
        if is_link {
            make_folder_link(target.path(), &folder).expect("the link is made");
        } else {
            fs::write(&folder, b"a file").expect("the file is written");
        }

        assert_eq!(
            create_user_folder_in(place.path()).expect("the name is read"),
            None
        );
        assert_eq!(mode_of(target.path()), 0o755);
    }

    // Fails when a place that refuses the make answers an error rather than no folder.
    #[test]
    fn an_unwritable_place_gets_no_folder() {
        // Root makes a folder whatever the place's mode.
        if is_superuser() {
            return;
        }
        let place = tempfile::tempdir().expect("a scratch folder");
        let unwritable = make_unwritable(place.path()).expect("the place is made unwritable");

        let made = create_user_folder_in(place.path());
        drop(unwritable);

        assert_eq!(made.expect("a refused make is no error"), None);
        assert!(!user_folder(place.path()).exists());
    }
}

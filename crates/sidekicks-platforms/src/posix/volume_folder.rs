//! This user's own folder on a volume, on macOS and Linux: `.ai-sidekicks-<uid>`, made readable by
//! its owner alone or found and made so again, and refused where a link, a file or another user's
//! folder holds the name, or where another account could swap the folder for its own.

use std::fs::{self, File, Metadata, OpenOptions, Permissions};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::{Mode, mkdirat};
use nix::unistd::{ROOT, getuid};

use crate::posix::error_codes::is_link_loop;
use crate::posix::private_folder::PRIVATE_FOLDER_MODE;
use crate::volume::user_folder_name;

// The mode bits that let the folder's group or any other account write in it.
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;

// The sticky bit, which keeps others from renaming or removing an entry they do not own.
const STICKY_BIT: u32 = 0o1000;

/// Makes or finds this user's folder `.ai-sidekicks-<uid>` in `place`, readable by its owner alone,
/// with no access list entry it inherited, and answers its path; a folder the user made earlier
/// with other bits is made private again. Answers `None` where `place` refuses the make (`EACCES`,
/// `EPERM`, `EROFS`), where another account could rename the folder and plant its own (a place
/// owned by an account but this user and root, one others may write in with no sticky bit, or on
/// macOS one whose access list grants another account `delete_child`), or where a link, a file or
/// another user's folder holds the name; fails with any other error.
pub(crate) fn create_user_folder_in(place: &Path) -> io::Result<Option<PathBuf>> {
    let user = getuid();
    let name = user_folder_name(user);
    // The place is held open, so its check, the make and the open all reach the one folder its
    // path named when the call began.
    let opened_place = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY)
        .open(place)
    {
        Ok(opened_place) => opened_place,
        Err(error) if is_refusal(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !is_held_by_user(&opened_place.metadata()?, user.as_raw()) {
        return Ok(None);
    }
    // An access list entry grants what the mode does not show.
    #[cfg(target_os = "macos")]
    if crate::macos::access_control_list::grants_others_delete_child(&opened_place, user.as_raw())?
    {
        return Ok(None);
    }
    match mkdirat(&opened_place, name.as_str(), Mode::S_IRWXU) {
        Ok(()) | Err(Errno::EEXIST) => {}
        Err(errno) if is_refusal(&io::Error::from(errno)) => return Ok(None),
        Err(errno) => return Err(errno.into()),
    }
    // Opened without following a link, so the owner read and the mode change reach the entry at
    // the name itself: a link there answers `ELOOP`, a file `ENOTDIR`.
    let opened = match openat(
        &opened_place,
        name.as_str(),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Ok(opened) => File::from(opened),
        Err(errno) => {
            let error = io::Error::from(errno);
            if is_refusal(&error)
                || error.kind() == ErrorKind::NotADirectory
                || is_link_loop(&error)
            {
                return Ok(None);
            }
            return Err(error);
        }
    };
    if opened.metadata()?.uid() != user.as_raw() {
        return Ok(None);
    }
    opened.set_permissions(Permissions::from_mode(PRIVATE_FOLDER_MODE))?;
    // macOS keeps an access list's entries past a mode change, so the ones the folder inherited
    // from its place would still let others in.
    #[cfg(target_os = "macos")]
    crate::macos::access_control_list::remove_access_control_list(&opened)?;
    Ok(Some(place.join(name)))
}

// Whether the place whose facts are `place_facts` keeps others from renaming its entries, by its
// owner and mode: it is owned by `user` or root, and no other account may write in it unless its
// sticky bit is set.
fn is_held_by_user(place_facts: &Metadata, user: u32) -> bool {
    let owner = place_facts.uid();
    let mode = place_facts.mode();
    (owner == user || owner == ROOT.as_raw())
        && (mode & GROUP_OR_OTHER_WRITE_BITS == 0 || mode & STICKY_BIT != 0)
}

/// Whether this user owns `folder`, read without following a link. Fails with the read's error.
pub fn is_owned_by_user(folder: &Path) -> io::Result<bool> {
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

    // Fails when the check of the place's mode goes, so a folder in a place others may write with
    // no sticky bit is answered, or when it refuses a place whose sticky bit keeps the folder the
    // user's.
    #[rstest]
    #[case::open_without_sticky_bit(0o777, false)]
    #[case::group_writable_without_sticky_bit(0o770, false)]
    #[case::open_with_sticky_bit(0o1777, true)]
    fn a_place_others_may_write_gets_a_folder_only_with_its_sticky_bit(
        #[case] place_mode: u32,
        #[case] is_folder_made: bool,
    ) {
        let place = tempfile::tempdir().expect("a scratch folder");
        fs::set_permissions(place.path(), Permissions::from_mode(place_mode))
            .expect("the place's mode is set");

        let made = create_user_folder_in(place.path()).expect("the place is read");

        assert_eq!(made.is_some(), is_folder_made);
        assert_eq!(user_folder(place.path()).exists(), is_folder_made);
    }

    // Fails when the access list entries the folder inherits from its place stay, which keep
    // letting others in after the mode change.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_keeps_no_access_list_entry_its_place_passes_down() {
        let place = tempfile::tempdir().expect("a scratch folder");
        let granted = std::process::Command::new("/bin/chmod")
            .args([
                "+a",
                "everyone allow list,search,file_inherit,directory_inherit",
            ])
            .arg(place.path())
            .status()
            .expect("chmod runs");
        assert!(granted.success(), "the place's inheritable entry is set");

        let folder = create_user_folder_in(place.path())
            .expect("the folder is made")
            .expect("the place holds a folder");
        let listing = std::process::Command::new("/bin/ls")
            .arg("-lde")
            .arg(&folder)
            .output()
            .expect("ls runs");

        let listing = String::from_utf8_lossy(&listing.stdout);
        assert!(
            !listing.contains("everyone"),
            "the folder holds no inherited entry: {listing}"
        );
    }

    // Fails when the access list read goes, so a place whose list lets every account rename its
    // entries gets a folder, or when it refuses the user's own entry or one only passed down.
    #[cfg(target_os = "macos")]
    #[rstest]
    #[case::everyone_may_rename(false, "allow delete_child", false)]
    #[case::the_user_may_rename(true, "allow delete_child", true)]
    #[case::only_passed_down(false, "allow delete_child,only_inherit,directory_inherit", true)]
    fn a_place_whose_access_list_lets_another_account_rename_gets_no_folder(
        #[case] is_users_entry: bool,
        #[case] grant: &str,
        #[case] is_folder_made: bool,
    ) {
        let place = tempfile::tempdir().expect("a scratch folder");
        fs::set_permissions(place.path(), Permissions::from_mode(0o755))
            .expect("the place's mode is set");
        let account = if is_users_entry {
            let user = std::process::Command::new("/usr/bin/id")
                .arg("-un")
                .output()
                .expect("id runs");
            String::from_utf8(user.stdout)
                .expect("the user's name is text")
                .trim()
                .to_owned()
        } else {
            "everyone".to_owned()
        };
        let granted = std::process::Command::new("/bin/chmod")
            .args(["+a", &format!("{account} {grant}")])
            .arg(place.path())
            .status()
            .expect("chmod runs");
        assert!(granted.success(), "the place's entry is set");

        let made = create_user_folder_in(place.path()).expect("the place is read");

        assert_eq!(made.is_some(), is_folder_made);
        assert_eq!(user_folder(place.path()).exists(), is_folder_made);
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

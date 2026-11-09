//! This user's own folder on a volume, on Windows: `.ai-sidekicks-<SID>`, made with an access list
//! naming the user alone and marked hidden, and refused where a link, a file or a folder another
//! account owns or may enter holds the name.

use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::os::windows::io::AsRawHandle as _;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::FALSE;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_WRITE_ATTRIBUTES, FileBasicInfo, READ_CONTROL, SetFileInformationByHandle,
};

use crate::volume::user_folder_name;
use crate::windows::file_information::read_information;
use crate::windows::folder_security::{FolderSecurity, is_admitted};
use crate::windows::process_user::{ProcessUser, UserOnlyDescriptor, read_user_sid_text};
use crate::windows::real_path::verbatim_path;

/// Makes or finds this user's folder `.ai-sidekicks-<SID>` in `place`, its access list naming the
/// user alone, marks it hidden and answers its path. Answers `None` where `place` refuses the make
/// or a link, a file, or a folder another account owns or may enter holds the name, which is
/// refused, not repaired; fails with any other error.
pub(crate) fn create_user_folder_in(place: &Path) -> io::Result<Option<PathBuf>> {
    let user_sid = read_user_sid_text()?;
    let folder = place.join(user_folder_name(&user_sid));
    // A descriptor given at the make replaces the one the folder would inherit.
    let descriptor = UserOnlyDescriptor::for_folder(&user_sid)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .expect("the attributes' size fits a u32"),
        lpSecurityDescriptor: descriptor.as_raw(),
        bInheritHandle: FALSE,
    };
    let mut wide_folder = verbatim_path(&folder)?;
    wide_folder.push(0);
    // SAFETY: the path is a live NUL-ended string, and the attributes and the descriptor they
    // point at live past the call.
    if unsafe { CreateDirectoryW(wide_folder.as_ptr(), &raw const attributes) } == FALSE {
        let error = io::Error::last_os_error();
        if is_refusal(&error) {
            return Ok(None);
        }
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    // Opened without following a reparse point, so the checks and the hidden mark reach the entry
    // at the name itself.
    let opened = match OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&folder)
    {
        Ok(opened) => opened,
        Err(error) if is_refusal(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = opened.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(None);
    }
    let security = FolderSecurity::read(&opened)?;
    let user = ProcessUser::of_this_process()?;
    if !is_admitted(&user, security.owner) || security.first_other_account(&user)?.is_some() {
        return Ok(None);
    }
    hide(&opened)?;
    Ok(Some(folder))
}

/// Whether this user owns `folder`; a folder this user may not read the owner of is not its own.
/// Fails with the system's error from the open or the read.
pub fn is_owned_by_user(folder: &Path) -> io::Result<bool> {
    let opened = match OpenOptions::new()
        .access_mode(READ_CONTROL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(folder)
    {
        Ok(opened) => opened,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => return Ok(false),
        Err(error) => return Err(error),
    };
    let security = FolderSecurity::read(&opened)?;
    Ok(ProcessUser::of_this_process()?.has_sid(security.owner))
}

// Whether `error` is the system's refusal to let this user write there: access denied, or a
// volume that is write-protected.
fn is_refusal(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
    )
}

// Marks the open folder hidden, writing its basic record back whole with the hidden bit added.
fn hide(opened: &File) -> io::Result<()> {
    let mut information: FILE_BASIC_INFO = read_information(opened, FileBasicInfo)?;
    information.FileAttributes |= FILE_ATTRIBUTE_HIDDEN;
    let length =
        u32::try_from(size_of::<FILE_BASIC_INFO>()).expect("the record's size fits in a u32");
    // SAFETY: the handle is the open folder's, alive for the call and open with
    // `FILE_WRITE_ATTRIBUTES`; the record is a live `FILE_BASIC_INFO` of the length given.
    let is_written = unsafe {
        SetFileInformationByHandle(
            opened.as_raw_handle(),
            FileBasicInfo,
            (&raw const information).cast(),
            length,
        )
    };
    if is_written == FALSE {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_HIDDEN, FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL,
    };

    use super::{create_user_folder_in, is_owned_by_user};
    use crate::make_folder_link;
    use crate::volume::user_folder_name;
    use crate::windows::folder_security::{FolderSecurity, change_access_list};
    use crate::windows::process_user::{ProcessUser, read_user_sid_text};

    fn is_hidden(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .expect("the entry reads")
            .file_attributes()
            & FILE_ATTRIBUTE_HIDDEN
            != 0
    }

    // Fails when the folder's own descriptor is not passed or not protected, so the place's grant
    // to every signed-in user (`S-1-5-11`) is inherited, or the hidden mark is not written.
    #[test]
    fn a_place_gets_the_user_s_hidden_folder_open_to_the_user_alone() {
        let place = tempfile::tempdir().expect("a scratch folder");
        change_access_list(place.path(), &["/grant", "*S-1-5-11:(OI)(CI)M"]);

        let folder = create_user_folder_in(place.path())
            .expect("the folder is made")
            .expect("the place takes the folder");
        let opened = OpenOptions::new()
            .access_mode(READ_CONTROL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&folder)
            .expect("the folder opens");
        let security = FolderSecurity::read(&opened).expect("the folder's security reads");
        let user = ProcessUser::of_this_process().expect("this user reads");

        assert_eq!(
            folder,
            place.path().join(user_folder_name(
                read_user_sid_text().expect("this user's id reads")
            ))
        );
        assert!(is_hidden(&folder));
        assert_eq!(
            security
                .first_other_account(&user)
                .expect("the access list reads"),
            None
        );
    }

    // Fails when the open follows the link, which hides the link's target and answers it.
    #[test]
    fn a_folder_link_at_the_name_is_refused_and_its_target_left_alone() {
        let place = tempfile::tempdir().expect("a scratch folder");
        let target = tempfile::tempdir().expect("a link's target");
        let name = user_folder_name(read_user_sid_text().expect("this user's id reads"));
        make_folder_link(target.path(), &place.path().join(name)).expect("the link is made");

        assert_eq!(
            create_user_folder_in(place.path()).expect("the name is read"),
            None
        );
        assert!(!is_hidden(target.path()));
    }

    // Fails when the owner compare goes, so a system folder reads as the user's own.
    #[test]
    fn the_user_owns_a_temporary_folder_and_not_the_system_folder() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let system_root = std::env::var_os("SystemRoot").expect("Windows names its system folder");

        assert!(is_owned_by_user(folder.path()).expect("the folder's owner reads"));
        assert!(
            !is_owned_by_user(Path::new(&system_root)).expect("the system folder's owner reads")
        );
    }
}

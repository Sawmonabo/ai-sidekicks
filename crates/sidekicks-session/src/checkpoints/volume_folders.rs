//! A session's own folders on other volumes, as files: whether a folder's volume is mounted, the
//! removal of a purged session's folder with its user folder once that is empty, and the place in
//! the data folder that holds the clones a backup's restore brings back from other volumes. Every
//! call blocks on the file system, so the caller runs it off the async workers.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{VolumeId, read_volume, real_path, remove_tree};
use sidekicks_std::missing_entry::is_gone;

use crate::checkpoints::store::shadows::VolumeFolder;

/// The data folder's folder that holds, per session, the clones a restore brought back from other
/// volumes.
const RESTORED_CLONES_SEGMENT: &str = "restored-clones";

/// Whether a session's folder on another volume can be reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeFolderState {
    /// The folder's volume is mounted.
    Mounted {
        /// Whether the folder itself is there.
        is_present: bool,
    },
    /// The folder's volume is not mounted, or has no id to tell it by.
    Absent,
}

/// What [`remove_volume_folder`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeFolderRemoval {
    /// The folder is gone, and its user folder with it once nothing else was in it.
    Removed,
    /// The folder's volume is absent, so nothing was removed.
    VolumeAbsent,
}

/// Reads whether `folder`'s volume is mounted, from the volume of the folder's nearest existing
/// path, the folder itself first: a path whose volume is the recorded one is mounted; another
/// volume, a volume with no id, or no existing path at all is absent. Blocks on the file system.
/// Fails with a path's read error other than its being gone, and with the volume read's error
/// other than `Unsupported`.
pub fn read_volume_folder_state(folder: &VolumeFolder) -> io::Result<VolumeFolderState> {
    read_state(&mut NativeVolumeFolderFiles, folder)
}

/// Removes `folder` and everything in it when its volume is mounted, then its user folder when
/// nothing else is left in it; a folder already gone is removed. Removes nothing when the volume
/// is absent, as [`read_volume_folder_state`] reads it. Blocks on the file system. Fails as that
/// read does, and with the removals' errors.
pub fn remove_volume_folder(folder: &VolumeFolder) -> io::Result<VolumeFolderRemoval> {
    remove_folder(&mut NativeVolumeFolderFiles, folder)
}

/// `<data folder>/restored-clones/<session id>`: where a backup's restore puts, as plain copies,
/// the clones `session_id` kept on other volumes. The backup mirrors this folder, the undo reads a
/// shadow's restored copy here when its volume is absent, and the purge removes it.
pub fn restored_clones_folder(data_folder: &Path, session_id: &SessionId) -> PathBuf {
    data_folder
        .join(RESTORED_CLONES_SEGMENT)
        .join(session_id.text().as_str())
}

/// The folder of [`restored_clones_folder`] that holds the restored copies of the clones
/// `session_id` kept on volume `volume_id`, named by the SHA-256 of the id's text in lowercase hex;
/// each copy is named by its shadow's id. The backup mirrors it, the undo reads a shadow's restored
/// copy here when its volume is absent, and the purge removes it.
pub fn restored_clone_folder(
    data_folder: &Path,
    session_id: &SessionId,
    volume_id: &VolumeId,
) -> PathBuf {
    restored_clones_folder(data_folder, session_id).join(base16ct::lower::encode_string(
        &Sha256::digest(volume_id.to_string().as_bytes()),
    ))
}

/// The file-system calls a volume folder's read and removal make, apart so each can be shown with
/// answers a test chooses.
trait VolumeFolderFiles {
    /// Reads whether something is at `path`, a link not followed.
    fn read_entry(&mut self, path: &Path) -> io::Result<()>;

    /// The id of the volume holding `path`, read from its real path.
    fn read_volume_id(&mut self, path: &Path) -> io::Result<VolumeId>;

    /// Removes `path` and everything under it; a path already gone is `Ok`.
    fn remove_tree(&mut self, path: &Path) -> io::Result<()>;

    /// Removes the folder at `path` only when it is empty.
    fn remove_empty_folder(&mut self, path: &Path) -> io::Result<()>;
}

/// The system's own calls.
struct NativeVolumeFolderFiles;

impl VolumeFolderFiles for NativeVolumeFolderFiles {
    fn read_entry(&mut self, path: &Path) -> io::Result<()> {
        fs::symlink_metadata(path).map(drop)
    }

    fn read_volume_id(&mut self, path: &Path) -> io::Result<VolumeId> {
        Ok(read_volume(&real_path(path)?)?.id)
    }

    fn remove_tree(&mut self, path: &Path) -> io::Result<()> {
        remove_tree(path)
    }

    fn remove_empty_folder(&mut self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }
}

// `folder`'s state, read through `files`.
fn read_state(
    files: &mut impl VolumeFolderFiles,
    folder: &VolumeFolder,
) -> io::Result<VolumeFolderState> {
    let recorded = Path::new(folder.folder.as_str());
    let Some(existing) = nearest_existing_path(files, recorded)? else {
        return Ok(VolumeFolderState::Absent);
    };
    match files.read_volume_id(existing) {
        Ok(volume_id) if volume_id == folder.volume_id => Ok(VolumeFolderState::Mounted {
            is_present: existing == recorded,
        }),
        Ok(_) => Ok(VolumeFolderState::Absent),
        Err(error) if error.kind() == ErrorKind::Unsupported => Ok(VolumeFolderState::Absent),
        Err(error) => Err(error),
    }
}

// The first of `path` and its ancestors that exists, `None` when none does.
fn nearest_existing_path<'path>(
    files: &mut impl VolumeFolderFiles,
    path: &'path Path,
) -> io::Result<Option<&'path Path>> {
    for ancestor in path.ancestors() {
        match files.read_entry(ancestor) {
            Ok(()) => return Ok(Some(ancestor)),
            Err(error) if is_gone(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

// Removes `folder` through `files` when its volume is mounted.
fn remove_folder(
    files: &mut impl VolumeFolderFiles,
    folder: &VolumeFolder,
) -> io::Result<VolumeFolderRemoval> {
    let is_present = match read_state(files, folder)? {
        VolumeFolderState::Mounted { is_present } => is_present,
        VolumeFolderState::Absent => return Ok(VolumeFolderRemoval::VolumeAbsent),
    };
    let path = Path::new(folder.folder.as_str());
    if is_present {
        files.remove_tree(path)?;
    }
    let user_folder = path
        .parent()
        .expect("a session's folder sits in its user folder");
    // Another session's folder keeps the user folder.
    match files.remove_empty_folder(user_folder) {
        Err(error)
            if !matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Err(error)
        }
        Ok(()) | Err(_) => Ok(VolumeFolderRemoval::Removed),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{self, ErrorKind};
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_platforms::{
        VolumeId, create_private_folder, create_volume_folder, harness_test_name, read_volume,
        real_path, scratch_volume,
    };

    use super::{VolumeFolderFiles, VolumeFolderRemoval, remove_folder, remove_volume_folder};
    use crate::checkpoints::shadows::recorded_path;
    use crate::checkpoints::store::shadows::VolumeFolder;

    const RECORDED_VOLUME: &str = "recorded-volume";
    const SESSION_FOLDER: &str = "/volume/.ai-sidekicks-501/session";
    const USER_FOLDER: &str = "/volume/.ai-sidekicks-501";

    // What the fake's volume read answers.
    #[derive(Clone, Copy, Debug)]
    enum VolumeAnswer {
        Id(&'static str),
        Fails(ErrorKind),
    }

    // A removal the fake was asked for.
    #[derive(Debug, PartialEq, Eq)]
    enum Removal {
        Tree(PathBuf),
        EmptyFolder(PathBuf),
    }

    // Files where only `present` exist, every volume read answers `volume`, the user folder's
    // removal answers `user_folder_removal`, and each removal asked for is kept in `removals`.
    struct FakeFiles {
        present: Vec<PathBuf>,
        volume: VolumeAnswer,
        user_folder_removal: Option<ErrorKind>,
        removals: Vec<Removal>,
    }

    impl VolumeFolderFiles for FakeFiles {
        fn read_entry(&mut self, path: &Path) -> io::Result<()> {
            if self.present.iter().any(|present| present == path) {
                return Ok(());
            }
            Err(io::Error::from(ErrorKind::NotFound))
        }

        fn read_volume_id(&mut self, _path: &Path) -> io::Result<VolumeId> {
            match self.volume {
                VolumeAnswer::Id(id) => Ok(id.parse().expect("a volume id")),
                VolumeAnswer::Fails(kind) => Err(io::Error::from(kind)),
            }
        }

        fn remove_tree(&mut self, path: &Path) -> io::Result<()> {
            self.removals.push(Removal::Tree(path.to_path_buf()));
            Ok(())
        }

        fn remove_empty_folder(&mut self, path: &Path) -> io::Result<()> {
            self.removals.push(Removal::EmptyFolder(path.to_path_buf()));
            self.user_folder_removal
                .map_or(Ok(()), |kind| Err(io::Error::from(kind)))
        }
    }

    fn paths(paths: &[&str]) -> Vec<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    // Kills: a folder on an absent volume removed; a mounted volume's folder owed; the parent
    // removed as a tree, which would take other sessions' folders; `Unsupported`, or no ancestor
    // at all, read as a failure; a gone folder read as absent, which a purge run again would then
    // owe.
    #[rstest]
    #[case::present_on_the_recorded_volume(
        &[SESSION_FOLDER, USER_FOLDER, "/volume", "/"],
        VolumeAnswer::Id(RECORDED_VOLUME),
        None,
        Ok(VolumeFolderRemoval::Removed),
        vec![Removal::Tree(SESSION_FOLDER.into()), Removal::EmptyFolder(USER_FOLDER.into())],
    )]
    #[case::gone_with_its_ancestor_on_the_recorded_volume(
        &[USER_FOLDER, "/volume", "/"],
        VolumeAnswer::Id(RECORDED_VOLUME),
        None,
        Ok(VolumeFolderRemoval::Removed),
        vec![Removal::EmptyFolder(USER_FOLDER.into())],
    )]
    #[case::the_user_folder_holds_another_sessions_folder(
        &[SESSION_FOLDER, USER_FOLDER, "/volume", "/"],
        VolumeAnswer::Id(RECORDED_VOLUME),
        Some(ErrorKind::DirectoryNotEmpty),
        Ok(VolumeFolderRemoval::Removed),
        vec![Removal::Tree(SESSION_FOLDER.into()), Removal::EmptyFolder(USER_FOLDER.into())],
    )]
    #[case::the_nearest_ancestor_on_another_volume(
        &["/"],
        VolumeAnswer::Id("boot-volume"),
        None,
        Ok(VolumeFolderRemoval::VolumeAbsent),
        vec![],
    )]
    #[case::a_volume_with_no_id(
        &[SESSION_FOLDER, USER_FOLDER, "/volume", "/"],
        VolumeAnswer::Fails(ErrorKind::Unsupported),
        None,
        Ok(VolumeFolderRemoval::VolumeAbsent),
        vec![],
    )]
    #[case::no_ancestor(
        &[],
        VolumeAnswer::Id(RECORDED_VOLUME),
        None,
        Ok(VolumeFolderRemoval::VolumeAbsent),
        vec![],
    )]
    #[case::the_volume_read_fails(
        &[SESSION_FOLDER, USER_FOLDER, "/volume", "/"],
        VolumeAnswer::Fails(ErrorKind::PermissionDenied),
        None,
        Err(ErrorKind::PermissionDenied),
        vec![],
    )]
    fn a_folder_is_removed_only_on_its_mounted_volume(
        #[case] present: &[&str],
        #[case] volume: VolumeAnswer,
        #[case] user_folder_removal: Option<ErrorKind>,
        #[case] expected: Result<VolumeFolderRemoval, ErrorKind>,
        #[case] expected_removals: Vec<Removal>,
    ) {
        let mut files = FakeFiles {
            present: paths(present),
            volume,
            user_folder_removal,
            removals: Vec::new(),
        };
        let folder = VolumeFolder {
            volume_id: RECORDED_VOLUME.parse().expect("a volume id"),
            folder: FilesystemPath::new(SESSION_FOLDER.to_owned()).expect("a test path"),
        };

        let removal = remove_folder(&mut files, &folder).map_err(|error| error.kind());

        assert_eq!(removal, expected);
        assert_eq!(files.removals, expected_removals);
    }

    fn session_id() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a session id")
    }

    // Kills: the real `read_volume` wired to another path; the user folder left behind; the user
    // folder removed while another session's folder is in it; a gone ancestry read as mounted.
    #[test]
    fn a_folder_on_a_volume_that_is_not_there_is_owed_and_one_on_a_mounted_volume_goes() {
        let Some(volume) = scratch_volume(
            &harness_test_name(
                module_path!(),
                "a_folder_on_a_volume_that_is_not_there_is_owed_and_one_on_a_mounted_volume_goes",
            ),
            Path::new("volume"),
        ) else {
            return;
        };
        let mount = real_path(volume.mount_point()).expect("the mount point resolves");
        let root = real_path(volume.root()).expect("the root resolves");
        let checkout = mount.join("repo");
        fs::create_dir(&checkout).expect("the checkout is made");
        let scratch = read_volume(&mount).expect("the scratch volume reads");
        let user_folder = create_volume_folder(&scratch, &checkout)
            .expect("the user folder is made")
            .expect("the volume holds a place for it");
        let session_folder = |folder: &Path| VolumeFolder {
            volume_id: scratch.id.clone(),
            folder: recorded_path(folder).expect("the folder is recorded"),
        };
        let [first, second] = [session_id(), session_id()].map(|session_id| {
            let folder = user_folder.join(session_id.text().as_str());
            create_private_folder(&folder).expect("the session's folder is made");
            fs::write(folder.join("clone"), b"kept").expect("a clone is written");
            session_folder(&folder)
        });

        assert_eq!(
            remove_volume_folder(&first).expect("the first folder is removed"),
            VolumeFolderRemoval::Removed
        );
        assert!(!Path::new(first.folder.as_str()).exists());
        assert!(
            Path::new(second.folder.as_str()).join("clone").exists(),
            "the other session's folder keeps the user folder"
        );
        assert_eq!(
            remove_volume_folder(&second).expect("the second folder is removed"),
            VolumeFolderRemoval::Removed
        );
        assert!(!user_folder.exists(), "the emptied user folder goes");

        let user_folder_name = user_folder.file_name().expect("the user folder has a name");
        let gone = session_folder(
            &root
                .join("gone")
                .join(user_folder_name)
                .join(session_id().text().as_str()),
        );
        let root_entries = || {
            let mut entries: Vec<_> = fs::read_dir(&root)
                .expect("the root lists")
                .map(|entry| entry.expect("an entry lists").file_name())
                .collect();
            entries.sort();
            entries
        };
        let before = root_entries();

        assert_eq!(
            remove_volume_folder(&gone).expect("a gone mount point reads absent"),
            VolumeFolderRemoval::VolumeAbsent
        );
        assert_eq!(root_entries(), before, "nothing under the root is touched");
    }
}

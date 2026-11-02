//! The volume holding a path: the folder it is mounted at and the id that tells it from another
//! volume across mounts and restarts, each system's module reading both; and this user's own
//! folder on a volume, for what must sit on the same volume as a file but outside its checkout.

use std::fmt;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use crate::run_folder::RUN_FOLDER_NAME;

/// The volume holding a path, as [`read_volume`](crate::read_volume) reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Volume {
    /// The folder the volume is mounted at, in [`real_path`](crate::real_path)'s form.
    pub top: PathBuf,
    /// What tells this volume from another across mounts and restarts.
    pub id: VolumeId,
}

/// What tells one volume from another across mounts and restarts, as text a stored row keeps: on
/// macOS the volume's UUID, uppercase and hyphenated; on Linux the mount's source, root and file
/// system type as the mount table writes them, joined by spaces; on Windows the volume GUID path
/// (`\\?\Volume{…}\`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VolumeId(String);

impl VolumeId {
    /// The id a system's volume read wrote as `text`, never empty.
    pub(crate) fn new(text: String) -> Self {
        Self(text)
    }
}

/// Text that is no [`VolumeId`]: an empty one.
#[derive(Debug, thiserror::Error)]
#[error("a volume id is never empty")]
pub struct NotAVolumeId;

impl fmt::Display for VolumeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for VolumeId {
    type Err = NotAVolumeId;

    /// Reads an id back from its text; refuses empty text.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.is_empty() {
            return Err(NotAVolumeId);
        }
        Ok(Self(text.to_owned()))
    }
}

/// This user's own folder on `volume`, made or found, owner-only and hidden: `.ai-sidekicks-<user>`
/// in the volume's top where the user may make it there, else in the highest folder above
/// `checkout` that the user owns on the volume, below its top. `volume` was read from a file's real
/// path and `checkout` is the checkout's real path. Answers `None` where the volume holds no such
/// place, as when the checkout is the volume's top; fails with any error but a place that refuses
/// the make or holds a link, a file or another user's folder at the name.
pub fn create_volume_folder(volume: &Volume, checkout: &Path) -> io::Result<Option<PathBuf>> {
    choose_volume_folder(
        &volume.top,
        checkout,
        |folder| match crate::read_volume(folder) {
            Ok(read) => Ok(read.id == volume.id),
            Err(error) if error.kind() == ErrorKind::Unsupported => Ok(false),
            Err(error) => Err(error),
        },
        crate::is_owned_by_user,
        crate::create_user_folder_in,
    )
}

/// The name of this user's own folder on a volume, `.ai-sidekicks-<user>`, where `user` is the user
/// as the system writes it: the numeric id on macOS and Linux, the SID text on Windows.
pub(crate) fn user_folder_name(user: impl fmt::Display) -> String {
    format!(".{RUN_FOLDER_NAME}-{user}")
}

// The folder `create_volume_folder` answers for the volume's top `top` and the checkout, given its
// three reads: whether a folder outside the top's path is on the volume, whether the user owns a
// folder, and the make of the user's folder in a place, `None` where the place refuses it.
fn choose_volume_folder(
    top: &Path,
    checkout: &Path,
    mut is_on_volume: impl FnMut(&Path) -> io::Result<bool>,
    mut is_owned: impl FnMut(&Path) -> io::Result<bool>,
    mut create_in: impl FnMut(&Path) -> io::Result<Option<PathBuf>>,
) -> io::Result<Option<PathBuf>> {
    // A top at or inside the checkout leaves no place on the volume outside it.
    if top.starts_with(checkout) {
        return Ok(None);
    }
    if let Some(folder) = create_in(top)? {
        return Ok(Some(folder));
    }
    let mut highest_owned = None;
    for folder in checkout.ancestors().skip(1) {
        if folder == top {
            break;
        }
        // A folder under the top by its path is on the volume, since a deeper mount would be the
        // top itself; any other, as a firmlink shows one, is read.
        if !folder.starts_with(top) && !is_on_volume(folder)? {
            break;
        }
        if is_owned(folder)? {
            highest_owned = Some(folder);
        }
    }
    match highest_owned {
        Some(folder) => create_in(folder),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{self, ErrorKind};
    use std::path::{Path, PathBuf};

    use rstest::rstest;

    use super::{choose_volume_folder, create_volume_folder};
    use crate::{
        current_user_id, harness_test_name, is_superuser, make_unwritable, read_volume, real_path,
        scratch_volume,
    };

    // What the walk's three reads answer: the folders outside the top's path read as on the
    // volume, the folders the user owns, the places whose make is refused, and the one whose make
    // fails.
    struct Reads {
        top: &'static str,
        checkout: &'static str,
        on_volume: &'static [&'static str],
        owned: &'static [&'static str],
        refused: &'static [&'static str],
        failing: Option<&'static str>,
    }

    // The folders each read was asked about, in order.
    struct Calls {
        made: &'static [&'static str],
        volume_reads: &'static [&'static str],
        ownership_reads: &'static [&'static str],
    }

    fn paths(listed: &[&str]) -> Vec<PathBuf> {
        listed.iter().map(PathBuf::from).collect()
    }

    // Fails when the guard on a top at or inside the checkout goes, the lowest owned folder is
    // taken, the walk goes past a folder off the volume, the top or the checkout is taken as the
    // owned folder, a make's error is answered as no place, or every folder's volume is read.
    #[rstest]
    #[case::checkout_is_the_top(
        Reads { top: "/v", checkout: "/v", on_volume: &[], owned: &["/"], refused: &[], failing: None },
        Ok(None),
        Calls { made: &[], volume_reads: &[], ownership_reads: &[] }
    )]
    #[case::top_inside_the_checkout(
        Reads {
            top: "/w/proj/mnt", checkout: "/w/proj", on_volume: &[], owned: &["/w"], refused: &[],
            failing: None,
        },
        Ok(None),
        Calls { made: &[], volume_reads: &[], ownership_reads: &[] }
    )]
    #[case::top_makes(
        Reads {
            top: "/v", checkout: "/v/a/proj", on_volume: &[], owned: &["/v/a"], refused: &[],
            failing: None,
        },
        Ok(Some("/v")),
        Calls { made: &["/v"], volume_reads: &[], ownership_reads: &[] }
    )]
    #[case::highest_owned_below_the_top(
        Reads {
            top: "/v",
            checkout: "/v/a/b/c/proj",
            on_volume: &[],
            owned: &["/v", "/v/a", "/v/a/b", "/v/a/b/c/proj"],
            refused: &["/v"],
            failing: None,
        },
        Ok(Some("/v/a")),
        Calls {
            made: &["/v", "/v/a"],
            volume_reads: &[],
            ownership_reads: &["/v/a/b/c", "/v/a/b", "/v/a"],
        }
    )]
    #[case::firmlinked_folders(
        Reads {
            top: "/System/Volumes/Data",
            checkout: "/Users/u/proj",
            on_volume: &["/Users/u", "/Users"],
            owned: &["/Users/u", "/"],
            refused: &["/System/Volumes/Data"],
            failing: None,
        },
        Ok(Some("/Users/u")),
        Calls {
            made: &["/System/Volumes/Data", "/Users/u"],
            volume_reads: &["/Users/u", "/Users", "/"],
            ownership_reads: &["/Users/u", "/Users"],
        }
    )]
    #[case::no_owned_folder(
        Reads {
            top: "/v", checkout: "/v/a/proj", on_volume: &[], owned: &[], refused: &["/v"],
            failing: None,
        },
        Ok(None),
        Calls { made: &["/v"], volume_reads: &[], ownership_reads: &["/v/a"] }
    )]
    #[case::make_error(
        Reads {
            top: "/v", checkout: "/v/a/proj", on_volume: &[], owned: &["/v/a"], refused: &[],
            failing: Some("/v"),
        },
        Err(ErrorKind::StorageFull),
        Calls { made: &["/v"], volume_reads: &[], ownership_reads: &[] }
    )]
    fn the_folder_is_in_the_top_else_the_highest_owned_folder_on_the_volume(
        #[case] reads: Reads,
        #[case] expected: Result<Option<&str>, ErrorKind>,
        #[case] calls: Calls,
    ) {
        let is_listed =
            |listed: &[&str], folder: &Path| listed.iter().any(|entry| folder == Path::new(entry));
        let (mut made, mut volume_reads, mut ownership_reads) =
            (Vec::new(), Vec::new(), Vec::new());

        let chosen = choose_volume_folder(
            Path::new(reads.top),
            Path::new(reads.checkout),
            |folder| {
                volume_reads.push(folder.to_path_buf());
                Ok(is_listed(reads.on_volume, folder))
            },
            |folder| {
                ownership_reads.push(folder.to_path_buf());
                Ok(is_listed(reads.owned, folder))
            },
            |place| {
                made.push(place.to_path_buf());
                if reads
                    .failing
                    .is_some_and(|failing| place == Path::new(failing))
                {
                    Err(io::Error::from(ErrorKind::StorageFull))
                } else if is_listed(reads.refused, place) {
                    Ok(None)
                } else {
                    Ok(Some(place.to_path_buf()))
                }
            },
        );

        assert_eq!(
            chosen.map_err(|error| error.kind()),
            expected.map(|place| place.map(PathBuf::from))
        );
        assert_eq!(made, paths(calls.made));
        assert_eq!(volume_reads, paths(calls.volume_reads));
        assert_eq!(ownership_reads, paths(calls.ownership_reads));
    }

    // Fails when the top is read from the wrong mount, the lowest owned folder (`projects/team`) is
    // taken over the highest, or the guard on a checkout at the top goes.
    #[test]
    fn a_scratch_volume_folder_is_in_its_top_then_its_highest_owned_folder() {
        let Some(volume) = scratch_volume(
            &harness_test_name(
                module_path!(),
                "a_scratch_volume_folder_is_in_its_top_then_its_highest_owned_folder",
            ),
            Path::new("volume"),
        ) else {
            return;
        };
        let mount = real_path(volume.mount_point()).expect("the mount point resolves");
        let checkout = mount.join("projects").join("team").join("app");
        fs::create_dir_all(&checkout).expect("the checkout is made");
        let big = checkout.join("big");
        fs::write(&big, b"a large file").expect("the file is written");
        let user = current_user_id().expect("macOS and Linux name the user by a number");
        let name = format!(".ai-sidekicks-{user}");
        let listing = |folder: &Path| {
            let mut names: Vec<_> = fs::read_dir(folder)
                .expect("the folder lists")
                .map(|entry| entry.expect("the entry reads").file_name())
                .collect();
            names.sort();
            names
        };

        let read =
            read_volume(&real_path(&big).expect("the file resolves")).expect("the volume reads");
        assert_eq!(read.top, mount);
        let in_top = create_volume_folder(&read, &checkout).expect("the folder is made");
        assert_eq!(in_top, Some(mount.join(&name)));
        fs::remove_dir(mount.join(&name)).expect("the top's folder is removed");
        // Root makes a folder whatever the top's mode, and the Linux run's child is root.
        if !is_superuser() {
            let unwritable = make_unwritable(&mount).expect("the top is made unwritable");
            let below_top = create_volume_folder(&read, &checkout);
            drop(unwritable);
            assert_eq!(
                below_top.expect("the folder is made"),
                Some(mount.join("projects").join(&name))
            );
        }
        let before = listing(&mount);
        assert_eq!(
            create_volume_folder(&read, &mount).expect("a checkout at the top reads"),
            None
        );
        assert_eq!(listing(&mount), before);
    }
}

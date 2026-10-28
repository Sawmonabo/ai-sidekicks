//! The one recursive copy of a tree, and the progress of the copies across volumes. The copy walks
//! every entry under its source, nothing ignored and no link followed: each folder is made and
//! takes its source's mode once its entries are in, each file is cloned where the file system makes
//! one (its mode kept either way), and each link is made again pointing where it pointed. A setup's
//! copy into a tree keeps what the tree has; a kept or put-back copy goes into a folder of its own
//! and keeps each file's and link's times.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the setup's copy step, and the kept and put-back copies and their progress"
    )
)]

pub(crate) mod progress;

use std::fs::{self, FileTimes, Metadata, Permissions};
use std::io;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use sidekicks_platforms::recreate_link;
use sidekicks_std::file::clone_or_copy::clone_or_copy;

/// What a copy does with what its destination already has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TreeCopyPolicy {
    /// A setup's copy into a tree: an entry the tree already has is kept and logged, never copied
    /// over, and a folder both have is copied into.
    KeepExisting,
    /// A kept or put-back copy: the destination is made by the copy, every entry is new, and each
    /// file and link keeps its source's times; anything already there fails the copy.
    IntoEmpty,
}

/// What a copy tells its follower as it goes, so a progress figure can read how much of the file
/// under way has reached its destination.
pub(crate) trait TreeCopyFollower: Sync {
    /// The copy begins the file at `destination`.
    fn file_began(&self, destination: &Path);

    /// The file last begun is copied whole, `bytes` long as the source read when it began.
    fn file_copied(&self, bytes: u64);
}

/// Why a copy stopped; what it copied before stays where it is.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TreeCopyError {
    /// The walk of the source failed.
    #[error("the folder to copy could not be read")]
    Walk(#[source] ignore::Error),
    /// One entry could not be read or copied.
    #[error("{} could not be copied", .path.display())]
    Entry {
        /// The entry's source.
        path: PathBuf,
        /// The read's or the copy's failure.
        #[source]
        source: io::Error,
    },
}

// What became of one entry.
enum EntryCopy {
    // Copied, or for a folder both have, copied into.
    Copied,
    // The destination's own entry kept; a folder kept so is not copied into.
    Kept,
}

/// Copies `source`, a folder, a file or a link, to `destination` under `policy`, telling
/// `follower` of each file. Blocks on the file system, so it runs on a blocking thread. Fails with
/// the walk's failure or the first entry that could not be copied.
pub(crate) fn copy_tree(
    source: &Path,
    destination: &Path,
    policy: TreeCopyPolicy,
    follower: Option<&dyn TreeCopyFollower>,
) -> Result<(), TreeCopyError> {
    let entry_failure = |path: &Path| {
        let path = path.to_path_buf();
        move |source| TreeCopyError::Entry { path, source }
    };
    let root = fs::symlink_metadata(source).map_err(entry_failure(source))?;
    // The folders made, with their source's modes, set once their entries are in, so a folder
    // whose mode refuses writes still takes them.
    let mut made_folders: Vec<(PathBuf, Permissions)> = Vec::new();
    let root_copy = copy_entry(
        source,
        destination,
        &root,
        policy,
        follower,
        &mut made_folders,
    )
    .map_err(entry_failure(source))?;
    if root.is_dir() && matches!(root_copy, EntryCopy::Copied) {
        // Folders the destination kept as some other entry, whose entries are left out.
        let mut kept_folders: Vec<PathBuf> = Vec::new();
        let walk = WalkBuilder::new(source)
            .standard_filters(false)
            .follow_links(false)
            .build();
        for entry in walk {
            let entry = entry.map_err(TreeCopyError::Walk)?;
            let path = entry.path();
            if entry.depth() == 0 || kept_folders.iter().any(|kept| path.starts_with(kept)) {
                continue;
            }
            let entry_destination = destination.join(
                path.strip_prefix(source)
                    .expect("the walk yields only entries under its root"),
            );
            let metadata = fs::symlink_metadata(path).map_err(entry_failure(path))?;
            let copy = copy_entry(
                path,
                &entry_destination,
                &metadata,
                policy,
                follower,
                &mut made_folders,
            )
            .map_err(entry_failure(path))?;
            if metadata.is_dir() && matches!(copy, EntryCopy::Kept) {
                kept_folders.push(path.to_path_buf());
            }
        }
    }
    // Deepest first, so no folder's mode is set before its entries are in.
    for (folder, permissions) in made_folders.into_iter().rev() {
        fs::set_permissions(&folder, permissions).map_err(entry_failure(&folder))?;
    }
    Ok(())
}

// Copies the one entry at `source`, whose own metadata is `metadata`, to `destination`.
fn copy_entry(
    source: &Path,
    destination: &Path,
    metadata: &Metadata,
    policy: TreeCopyPolicy,
    follower: Option<&dyn TreeCopyFollower>,
    made_folders: &mut Vec<(PathBuf, Permissions)>,
) -> io::Result<EntryCopy> {
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        return match fs::create_dir(destination) {
            Ok(()) => {
                made_folders.push((destination.to_path_buf(), metadata.permissions()));
                Ok(EntryCopy::Copied)
            }
            Err(error)
                if policy == TreeCopyPolicy::KeepExisting
                    && error.kind() == io::ErrorKind::AlreadyExists =>
            {
                if fs::symlink_metadata(destination)?.is_dir() {
                    Ok(EntryCopy::Copied)
                } else {
                    Ok(keep(destination))
                }
            }
            Err(error) => Err(error),
        };
    }
    if file_type.is_symlink() {
        return match recreate_link(source, destination) {
            Ok(()) => {
                if policy == TreeCopyPolicy::IntoEmpty {
                    fs::set_times_nofollow(destination, times_of(metadata)?)?;
                }
                Ok(EntryCopy::Copied)
            }
            Err(error) => keep_or_fail(error, policy, destination),
        };
    }
    if !file_type.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the entry is neither a folder, a file nor a link",
        ));
    }
    if let Some(follower) = follower {
        follower.file_began(destination);
    }
    if let Err(error) = clone_or_copy(source, destination) {
        return keep_or_fail(error, policy, destination);
    }
    // Set through the path, so a copy that kept a read-only mode takes its times too.
    if policy == TreeCopyPolicy::IntoEmpty {
        fs::set_times(destination, times_of(metadata)?)?;
    }
    if let Some(follower) = follower {
        follower.file_copied(metadata.len());
    }
    Ok(EntryCopy::Copied)
}

// An entry the destination already has is kept under `KeepExisting`; every other failure stands.
fn keep_or_fail(
    error: io::Error,
    policy: TreeCopyPolicy,
    destination: &Path,
) -> io::Result<EntryCopy> {
    if policy == TreeCopyPolicy::KeepExisting && error.kind() == io::ErrorKind::AlreadyExists {
        Ok(keep(destination))
    } else {
        Err(error)
    }
}

// Logs that the destination's own entry was kept, so the person can tell why it was not copied.
fn keep(destination: &Path) -> EntryCopy {
    tracing::info!(
        path = %destination.display(),
        "A copy kept an entry the destination already has rather than copying over it"
    );
    EntryCopy::Kept
}

fn times_of(metadata: &Metadata) -> io::Result<FileTimes> {
    Ok(FileTimes::new()
        .set_accessed(metadata.accessed()?)
        .set_modified(metadata.modified()?))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime};

    use sidekicks_platforms::make_folder_link;

    use super::{TreeCopyError, TreeCopyFollower, TreeCopyPolicy, copy_tree};

    #[derive(Default)]
    struct RecordedFiles {
        began: Mutex<Vec<PathBuf>>,
        copied_bytes: Mutex<Vec<u64>>,
    }

    impl TreeCopyFollower for RecordedFiles {
        fn file_began(&self, destination: &Path) {
            self.began
                .lock()
                .expect("the record is not poisoned")
                .push(destination.to_path_buf());
        }

        fn file_copied(&self, bytes: u64) {
            self.copied_bytes
                .lock()
                .expect("the record is not poisoned")
                .push(bytes);
        }
    }

    #[test]
    fn a_copy_into_a_new_folder_keeps_every_entry_and_its_times_and_tells_each_file() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source = scratch.path().join("tree");
        fs::create_dir_all(source.join("nested/empty")).expect("the folders are made");
        fs::write(source.join("nested/file.txt"), b"twelve bytes").expect("the file is written");
        let an_hour_ago = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(source.join("nested/file.txt"))
            .expect("the file opens")
            .set_modified(an_hour_ago)
            .expect("its time is set");
        make_folder_link(Path::new("../gone"), &source.join("nested/link"))
            .expect("the link is made");
        let read_only = source.join("nested/read-only.txt");
        fs::write(&read_only, b"kept").expect("the file is written");
        let mut permissions = fs::metadata(&read_only)
            .expect("the file reads")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&read_only, permissions).expect("the file is made read-only");
        let destination = scratch.path().join("copy");
        let follower = RecordedFiles::default();

        copy_tree(
            &source,
            &destination,
            TreeCopyPolicy::IntoEmpty,
            Some(&follower),
        )
        .expect("the tree is copied");

        assert_eq!(
            fs::read(destination.join("nested/file.txt")).expect("the file is copied"),
            b"twelve bytes"
        );
        assert_eq!(
            fs::metadata(destination.join("nested/file.txt"))
                .and_then(|metadata| metadata.modified())
                .expect("the copy's time reads"),
            an_hour_ago
        );
        assert!(destination.join("nested/empty").is_dir());
        assert_eq!(
            fs::read(destination.join("nested/read-only.txt")).expect("the file is copied"),
            b"kept"
        );
        assert_eq!(
            fs::read_link(destination.join("nested/link")).expect("the link is made again"),
            Path::new("../gone")
        );
        let mut began = follower
            .began
            .lock()
            .expect("the record is not poisoned")
            .clone();
        began.sort();
        assert_eq!(
            began,
            [
                destination.join("nested/file.txt"),
                destination.join("nested/read-only.txt")
            ]
        );
        let mut copied_bytes = follower
            .copied_bytes
            .lock()
            .expect("the record is not poisoned")
            .clone();
        copied_bytes.sort_unstable();
        assert_eq!(copied_bytes, [4, 12]);

        let refusal = copy_tree(&source, &destination, TreeCopyPolicy::IntoEmpty, None)
            .expect_err("a copy into a folder already there fails");
        assert!(matches!(
            refusal,
            TreeCopyError::Entry { source, .. } if source.kind() == io::ErrorKind::AlreadyExists
        ));
    }
}

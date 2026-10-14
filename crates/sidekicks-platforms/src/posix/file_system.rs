//! Making, renaming and removing entries on macOS and Linux: `create_new_file` makes a file only
//! where nothing stands, `rename_replacing` renames over what is at the destination, and
//! `remove_tree` removes a path and everything under it, as `rm -rf` does.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Whether a rename of a folder replaces an empty folder already at its destination: yes, as
/// `rename(2)` does.
pub const CAN_RENAME_REPLACE_EMPTY_FOLDER: bool = true;

/// Makes a new file at `path`, open for writing, with `mode` less the process's umask. Fails with
/// `AlreadyExists` when anything is at `path`, a link included, or with the open's error.
pub fn create_new_file(path: &Path, mode: u32) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
}

/// Renames `from` to `to` in one step: a file at `to` is replaced, and a folder at `to` only when
/// it is empty. Fails with the rename's error: `CrossesDevices` across volumes, and
/// `DirectoryNotEmpty` or `AlreadyExists` for a folder at `to` that holds anything.
pub fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

/// Removes `path` and everything under it, as `rm -rf` does: a link is removed and never followed,
/// and a pipe or a socket inside goes without being opened. A path already gone is `Ok`; fails with
/// the first other error of the stat or the removal.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    // std's folder removal opens each folder with `O_NOFOLLOW | O_DIRECTORY` and unlinks every other
    // entry unopened; an entry of unknown type gets that same open, which a non-folder refuses at
    // once, before it is unlinked.
    let removed = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(failure) => Err(failure),
    };
    match removed {
        // Missing at the start, or removed meanwhile by another remover.
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::time::Duration;

    use nix::sys::stat::Mode;

    use super::{create_new_file, remove_tree};

    // A secret written at 0o600 must not be readable by others, and a second writer must never
    // open the first one's file.
    #[test]
    fn a_new_file_takes_its_mode_and_refuses_a_taken_name() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let path = scratch.path().join("secret");

        create_new_file(&path, 0o600).expect("the file is made");
        let mode = fs::metadata(&path)
            .expect("the file reads")
            .permissions()
            .mode();
        let refusal = create_new_file(&path, 0o600).expect_err("the name is taken");

        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(refusal.kind(), ErrorKind::AlreadyExists);
    }

    #[test]
    fn a_link_to_a_folder_is_removed_and_its_target_kept() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        fs::create_dir(&target).expect("the target is made");
        fs::write(target.join("kept"), b"kept").expect("the target's file is written");
        let link = scratch.path().join("link");
        std::os::unix::fs::symlink(&target, &link).expect("the link is made");

        remove_tree(&link).expect("the link is removed");

        assert!(
            fs::symlink_metadata(&link).is_err_and(|error| error.kind() == ErrorKind::NotFound)
        );
        assert!(target.join("kept").is_file());
    }

    #[test]
    fn a_missing_path_is_removed_already() {
        let scratch = tempfile::tempdir().expect("a scratch folder");

        remove_tree(&scratch.path().join("missing")).expect("a missing path is no failure");
    }

    // git leaves its file-system monitor's socket in a worktree's record folder; opening a pipe
    // would wait for a writer forever, so the removal runs on a thread the test waits on.
    #[test]
    fn a_folder_holding_a_pipe_and_a_bound_socket_is_removed() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        // Short names, so the socket's path fits the system's socket path limit.
        let folder = scratch.path().join("f");
        fs::create_dir(&folder).expect("the folder is made");
        nix::unistd::mkfifo(folder.join("p").as_path(), Mode::S_IRUSR | Mode::S_IWUSR)
            .expect("the pipe is made");
        let listener = UnixListener::bind(folder.join("s")).expect("the socket is bound");

        let (sender, receiver) = mpsc::channel();
        let removed_folder = folder.clone();
        std::thread::spawn(move || {
            sender
                .send(remove_tree(&removed_folder))
                .expect("the test waits for the removal");
        });
        let removed = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("the removal ends within 10 s");
        drop(listener);

        removed.expect("the folder is removed");
        assert!(!folder.exists());
    }
}

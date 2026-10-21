//! The link a service's advertised socket path is on macOS and Linux: read to the socket it names,
//! moved onto another socket in one step, and removed only while it is a link.

use std::io;
use std::path::{Path, PathBuf};

use crate::posix::file_system::rename_replacing;

/// The socket the link at `link` names, or `None` when `link` is missing or not a link. Fails with
/// the read's other errors.
pub fn read_socket_link(link: &Path) -> io::Result<Option<PathBuf>> {
    match std::fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => std::fs::read_link(link).map(Some),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Points the link at `link` to `target` in one step: a new link made beside it is renamed over
/// whatever stands at `link`, so a concurrent connect resolves the old target or the new one and
/// never finds the path missing. Fails with `InvalidInput` for a link that would name itself, and
/// with the link's or the rename's error; a failed rename leaves `link` as it was and removes the
/// new link.
pub fn replace_socket_link(link: &Path, target: &Path) -> io::Result<()> {
    if link == target {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a socket link cannot name itself",
        ));
    }
    let folder = link.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a socket link path names no folder",
        )
    })?;
    let mut fresh = tempfile::Builder::new()
        .prefix(".socket-link-")
        .make_in(folder, |path| std::os::unix::fs::symlink(target, path))?;
    rename_replacing(fresh.path(), link)?;
    fresh.disable_cleanup(true);
    Ok(())
}

/// Removes the link at `link`, never what it names; a missing path, or one that is not a link, is
/// left and answers `false`. Fails with the stat's or the removal's other errors.
pub fn remove_socket_link(link: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => match std::fs::remove_file(link) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        },
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::{UnixListener, UnixStream};

    use super::{read_socket_link, remove_socket_link, replace_socket_link};

    // Fails when the move points the link anywhere but the new socket, leaves a temporary link
    // behind, or when the removal takes a socket that is not a link.
    #[test]
    fn a_moved_socket_link_reaches_the_new_socket_and_only_a_link_is_removed() {
        let scratch = tempfile::tempdir_in("/tmp").expect("a scratch folder");
        let first = scratch.path().join("first");
        let second = scratch.path().join("second");
        let _first_listener = UnixListener::bind(&first).expect("the first socket binds");
        let second_listener = UnixListener::bind(&second).expect("the second socket binds");
        let link = scratch.path().join("link");
        std::os::unix::fs::symlink(&first, &link).expect("the link is made");

        replace_socket_link(&link, &second).expect("the link moves");
        UnixStream::connect(&link).expect("a connect through the link lands");
        second_listener
            .set_nonblocking(true)
            .expect("the listener reads without waiting");
        let accepted = second_listener.accept();
        let entries = std::fs::read_dir(scratch.path())
            .expect("the folder lists")
            .count();

        assert!(accepted.is_ok(), "the second socket took the connect");
        assert_eq!(
            read_socket_link(&link).expect("the link reads"),
            Some(second.clone())
        );
        assert_eq!(entries, 3, "no temporary link is left");
        assert!(!remove_socket_link(&second).expect("a socket is left"));
        assert!(second.exists());
        assert!(remove_socket_link(&link).expect("the link is removed"));
        assert_eq!(read_socket_link(&link).expect("a missing link reads"), None);
    }
}

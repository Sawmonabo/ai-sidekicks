//! A local socket's path checked against `sun_path` on macOS and Linux, and what stands there read,
//! before a bind.

use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::SocketAddr;
use std::path::Path;

use crate::socket::path::{SocketPathEntry, SocketPathRefused};

// The longest path a socket address holds: `sun_path`'s bytes less the NUL that ends it. Neither
// system pads the struct, so `sun_path` runs from its offset to the end: 104 bytes on macOS, 108 on
// Linux.
const SOCKET_PATH_LIMIT: usize =
    size_of::<libc::sockaddr_un>() - std::mem::offset_of!(libc::sockaddr_un, sun_path) - 1;

/// Checks that `path` names a local socket: no longer than the longest path a socket address holds
/// (103 bytes on macOS, 107 on Linux) and with no NUL. Fails with
/// [`SocketPathRefused::TooLong`] for a longer path, measured first, and with
/// [`SocketPathRefused::Invalid`] for any other refusal.
pub fn check_socket_path(path: &Path) -> Result<(), SocketPathRefused> {
    let observed = path.as_os_str().as_bytes().len();
    if observed > SOCKET_PATH_LIMIT {
        return Err(SocketPathRefused::TooLong {
            limit: SOCKET_PATH_LIMIT,
            observed,
        });
    }
    SocketAddr::from_pathname(path).map_err(SocketPathRefused::Invalid)?;
    Ok(())
}

/// What stands at `path`, read with one `lstat` that never follows a link. Fails with the stat's
/// error other than `NotFound`.
pub fn read_socket_path_entry(path: &Path) -> io::Result<SocketPathEntry> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => Ok(SocketPathEntry::Socket),
        Ok(_) => Ok(SocketPathEntry::Other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SocketPathEntry::Absent),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::UnixListener;

    use super::{check_socket_path, read_socket_path_entry};
    use crate::socket::path::{SocketPathEntry, SocketPathRefused};

    // Written out rather than read from the struct, so a wrong measure of `sun_path` fails here.
    const EXPECTED_LIMIT: usize = if cfg!(target_os = "macos") { 103 } else { 107 };

    #[test]
    fn a_path_at_the_limit_binds_and_one_byte_more_is_too_long() {
        // Under `/tmp`, so the scratch folder leaves room for a name before the limit.
        let scratch = tempfile::tempdir_in("/tmp").expect("a scratch folder");
        let folder_bytes = scratch.path().as_os_str().as_bytes().len();
        let name_bytes = EXPECTED_LIMIT - folder_bytes - 1;
        let at_limit = scratch.path().join("s".repeat(name_bytes));
        let past_limit = scratch.path().join("s".repeat(name_bytes + 1));

        check_socket_path(&at_limit).expect("a path at the limit is a socket address");
        UnixListener::bind(&at_limit).expect("a listener binds at the limit");
        let refusal = check_socket_path(&past_limit).expect_err("one byte more is refused");

        assert!(
            matches!(
                refusal,
                SocketPathRefused::TooLong { limit: EXPECTED_LIMIT, observed }
                    if observed == EXPECTED_LIMIT + 1
            ),
            "{refusal:?}"
        );
    }

    // Fails when the connect probe reads the path unchecked: Linux answers a regular file as
    // refused, which would remove it, and a dangling link as absent, which would fail every bind.
    #[test]
    fn only_a_socket_reads_as_a_socket_and_a_file_or_a_dangling_link_as_something_else() {
        let scratch = tempfile::tempdir_in("/tmp").expect("a scratch folder");
        let socket = scratch.path().join("socket");
        let _listener = UnixListener::bind(&socket).expect("a listener binds");
        let file = scratch.path().join("file");
        std::fs::write(&file, b"").expect("the file is written");
        let link = scratch.path().join("link");
        std::os::unix::fs::symlink(scratch.path().join("missing"), &link)
            .expect("the link is made");

        let read = |name: &str| {
            read_socket_path_entry(&scratch.path().join(name)).expect("the path's entry reads")
        };

        assert_eq!(read("socket"), SocketPathEntry::Socket);
        assert_eq!(read("file"), SocketPathEntry::Other);
        assert_eq!(read("link"), SocketPathEntry::Other);
        assert_eq!(read("missing"), SocketPathEntry::Absent);
    }
}

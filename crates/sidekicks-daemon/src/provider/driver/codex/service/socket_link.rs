//! The home's control socket link, which a terminal's plain `codex` connects through: cleared at
//! a start when it blocks a plain `codex`, pointed at a second service's real socket in a planned
//! restart, and never left pointing at a stopped service. Codex binds each service's real socket
//! elsewhere and makes the path it was given a link to it; it removes only its own link and only
//! while that link names its own socket, so once the daemon moves the link, the link is the
//! daemon's to keep right. On Windows the path is the socket itself and there is no link.

use std::io;
use std::path::Path;

use sidekicks_platforms::{
    connect_unix_domain_socket, read_socket_link, remove_socket_link, replace_socket_link,
};

/// Removes the link at `home_link` when a connect through it fails because it names nothing or a
/// leftover socket file no service listens on, either of which a plain `codex` refuses to start
/// over. A link whose connect succeeds, and anything that is not a link, is left. Answers whether
/// it was removed; fails with the link's read or removal error.
pub(crate) async fn clear_blocking_socket_link(home_link: &Path) -> io::Result<bool> {
    if read_socket_link(home_link)?.is_none() {
        return Ok(false);
    }
    match connect_unix_domain_socket(home_link).await {
        Ok(_listening) => Ok(false),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            remove_socket_link(home_link)
        }
        Err(_other) => Ok(false),
    }
}

/// Points `home_link` at the real socket the link at `service_socket` names, never at that link,
/// so the home's path outlives the second service's own link. Fails when `service_socket` is no
/// link or the move fails.
pub(crate) fn point_socket_link_at_service(
    home_link: &Path,
    service_socket: &Path,
) -> io::Result<()> {
    let Some(real_socket) = read_socket_link(service_socket)? else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "the service's socket path {} is no link to a real socket",
                service_socket.display()
            ),
        ));
    };
    replace_socket_link(home_link, &real_socket)
}

/// Removes `home_link` when it names the real socket the link at `service_socket` names, read
/// before that service stopped; a link naming another service's socket is left. Answers whether it
/// was removed.
pub(crate) fn clear_socket_link_of(
    home_link: &Path,
    service_real_socket: &Path,
) -> io::Result<bool> {
    if read_socket_link(home_link)?.as_deref() != Some(service_real_socket) {
        return Ok(false);
    }
    remove_socket_link(home_link)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use sidekicks_platforms::read_socket_link;

    use super::{clear_socket_link_of, point_socket_link_at_service};

    // Fails when a planned restart leaves the home's link on the first service, points it at the
    // second service's own link (gone once that service exits), or a stop leaves it dangling or
    // removes a link that names another service.
    #[test]
    fn a_planned_restart_moves_the_link_and_a_stop_clears_it() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let home_link = folder.path().join("app-server-control.sock");
        let first_socket = folder.path().join("first-real.sock");
        let second_link = folder.path().join("sidekicks-0a.sock");
        let second_socket = folder.path().join("second-real.sock");
        symlink(&first_socket, &home_link).expect("the first service's link is made");
        symlink(&second_socket, &second_link).expect("the second service's link is made");

        point_socket_link_at_service(&home_link, &second_link).expect("the link moves");
        std::fs::remove_file(&second_link).expect("the second service's own link goes");
        let after_move = read_socket_link(&home_link).expect("the link reads");
        let is_cleared_for_first =
            clear_socket_link_of(&home_link, &first_socket).expect("the first's stop reads");
        let is_cleared_for_second =
            clear_socket_link_of(&home_link, &second_socket).expect("the second's stop reads");
        let after_stop = read_socket_link(&home_link).expect("the link reads");

        assert_eq!(after_move, Some(second_socket));
        assert!(!is_cleared_for_first);
        assert!(is_cleared_for_second);
        assert_eq!(after_stop, None);
        assert!(!home_link.exists() && std::fs::symlink_metadata(&home_link).is_err());
    }
}

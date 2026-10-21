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

/// Removes `home_link` when it names `service_real_socket`, where the service's socket really is,
/// as its start recorded it; a link naming another service's socket is left. Blocking. Answers
/// whether it was removed; fails with the link's read or removal error.
pub(crate) fn clear_socket_link_of(
    home_link: &Path,
    service_real_socket: &Path,
) -> io::Result<bool> {
    if read_socket_link(home_link)?.as_deref() != Some(service_real_socket) {
        return Ok(false);
    }
    remove_socket_link(home_link)
}

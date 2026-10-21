//! The home's control socket link, which a terminal's plain `codex` connects through: cleared at
//! a start when it blocks a plain `codex`, pointed at a second service's real socket in a planned
//! restart, at that service's again when it comes back from a crash, and at a former daemon's
//! running service when the service holding it is gone, and never left pointing at a stopped
//! service. Codex binds each service's real socket elsewhere and makes the path it was given a link
//! to it; it removes only its own link and only while that link names its own socket, so once the
//! daemon moves the link, the link is the daemon's to keep right. On Windows the path is the
//! socket itself and there is no link.

use std::io;
use std::path::Path;

use sidekicks_platforms::{
    connect_unix_domain_socket, read_socket_link, remove_socket_link, replace_socket_link,
};

/// Whether a service listens on `socket`: nothing there, and a socket file or link no one listens
/// on, answer `false`. Fails with any other failure of the connect, which tells nothing either way.
pub(crate) async fn is_listening(socket: &Path) -> io::Result<bool> {
    match connect_unix_domain_socket(socket).await {
        Ok(_listening) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// Removes the link at `home_link` when a connect through it fails because it names nothing or a
/// leftover socket file no service listens on, either of which a plain `codex` refuses to start
/// over. A link whose connect succeeds, and anything that is not a link, is left. Answers whether
/// it was removed; fails with the link's read or removal error and the connect's other failures.
pub(crate) async fn clear_blocking_socket_link(home_link: &Path) -> io::Result<bool> {
    if read_socket_link(home_link)?.is_none() || is_listening(home_link).await? {
        return Ok(false);
    }
    remove_socket_link(home_link)
}

/// Points `home_link` at `real_socket`, where a service's socket really is, unless another service
/// answers through it: a link naming nothing, an ended socket or `real_socket` itself ends up
/// naming `real_socket`. Answers whether it names `real_socket` once done; fails with the link's
/// read error, the connect's other failures and the move's error.
pub(crate) async fn restore_socket_link(home_link: &Path, real_socket: &Path) -> io::Result<bool> {
    if read_socket_link(home_link)?.as_deref() == Some(real_socket) {
        return Ok(true);
    }
    if is_listening(home_link).await? {
        return Ok(false);
    }
    let home_link = home_link.to_owned();
    let real_socket = real_socket.to_owned();
    tokio::task::spawn_blocking(move || replace_socket_link(&home_link, &real_socket))
        .await
        .map_err(io::Error::other)??;
    Ok(true)
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

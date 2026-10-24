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
    ProcessRecord, connect_unix_domain_socket, read_socket_link, remove_socket_link,
    replace_socket_link, unix_domain_listener_process,
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
/// answers through it: a link naming nothing, a socket no one listens on or `real_socket` itself
/// ends up naming `real_socket`. The listener is read through a connect, since a later Codex binds
/// the same socket path, and a listener that is one of `ended_services`, the processes of services
/// the caller found ended, is moved off as if none listened. Answers whether it names
/// `real_socket` once done; fails with the link's read error, the listener's read error and the
/// move's error.
pub(crate) async fn restore_socket_link(
    home_link: &Path,
    real_socket: &Path,
    ended_services: &[ProcessRecord],
) -> io::Result<bool> {
    if read_socket_link(home_link)?.as_deref() == Some(real_socket) {
        return Ok(true);
    }
    if let Some(listener) = unix_domain_listener_process(home_link).await? {
        let is_ended = listener
            .record()?
            .is_none_or(|listener| ended_services.contains(&listener));
        if !is_ended {
            return Ok(false);
        }
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

#[cfg(all(test, unix))]
mod tests {
    use sidekicks_platforms::{
        ExistingSocket, ProcessRecord, bind_socket_listener, pin_running_process, read_socket_link,
        replace_socket_link,
    };

    use super::restore_socket_link;

    // Fails when the link is moved off a live listener of another identity, which takes a later
    // Codex's socket from it, as a compare by process id alone does; when the identity check is
    // dropped, which leaves the link on the listener of a service found ended; or when a link
    // whose listener is gone is left.
    #[tokio::test]
    async fn the_link_moves_only_off_an_ended_service_or_a_socket_no_one_listens_on() {
        // The socket paths must fit the system's bound on socket paths.
        let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder");
        let home_link = folder.path().join("home.sock");
        let held_socket = folder.path().join("held.sock");
        let real_socket = folder.path().join("real.sock");
        let listener =
            bind_socket_listener(&held_socket, ExistingSocket::Refuse).expect("the listener binds");
        replace_socket_link(&home_link, &held_socket).expect("the link names the held socket");
        let own = pin_running_process(std::process::id())
            .expect("this process reads")
            .expect("this process runs")
            .record()
            .expect("this process's record reads")
            .expect("this process has a record");
        // The same id under another start: another process, which a compare by id alone takes.
        let other: ProcessRecord = serde_json::from_value(serde_json::json!({
            "id": own.id(),
            "start": own.start().wrapping_add(1),
            "boot": "another boot",
        }))
        .expect("another record reads");

        let kept = restore_socket_link(&home_link, &real_socket, &[other])
            .await
            .expect("a held link reads");
        let kept_target = read_socket_link(&home_link).expect("the link reads");
        let moved_off_ended = restore_socket_link(&home_link, &real_socket, &[own])
            .await
            .expect("a link held by an ended service reads");
        let moved_off_ended_target = read_socket_link(&home_link).expect("the link reads");
        replace_socket_link(&home_link, &held_socket).expect("the link names the held socket");
        drop(listener);
        let moved_off_nothing = restore_socket_link(&home_link, &real_socket, &[])
            .await
            .expect("a link no one listens on reads");
        let moved_off_nothing_target = read_socket_link(&home_link).expect("the link reads");

        assert!(!kept, "the link was moved off a live listener");
        assert_eq!(kept_target, Some(held_socket.clone()));
        assert!(moved_off_ended, "the link was left on an ended service");
        assert_eq!(moved_off_ended_target, Some(real_socket.clone()));
        assert!(
            moved_off_nothing,
            "the link was left on a socket no one listens on"
        );
        assert_eq!(moved_off_nothing_target, Some(real_socket));
    }
}

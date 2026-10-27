//! What a local socket's connect and path check share on every system: what a failed connect says
//! and why a path cannot name a socket.

pub(crate) mod connection;
pub(crate) mod path;

#[cfg(test)]
mod tests {
    use crate::{CAN_BIND_A_SOCKET_LISTENER, bind_socket_listener, short_socket_folder};

    // Fails when the value a test skips by says a listener binds where it does not, or the
    // reverse. Mutation: flip `CAN_BIND_A_SOCKET_LISTENER` in this system's arm.
    #[tokio::test]
    async fn a_listener_binds_exactly_where_the_system_says_it_can() {
        let folder = short_socket_folder().expect("a scratch folder is made");

        let bound = bind_socket_listener(&folder.path().join("s.sock"));

        assert_eq!(
            bound.is_ok(),
            CAN_BIND_A_SOCKET_LISTENER,
            "{:?}",
            bound.err()
        );
    }
}

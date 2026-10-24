//! The connect to the daemon on this machine, over its local socket: a socket file on macOS and
//! Linux, the person's own named pipe on Windows, which the platforms crate opens. There is no
//! fallback, so a socket nobody answers on fails as unavailable rather than trying another address.

use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_platforms::{connect_socket, found_no_listener};

use crate::error::{ClientError, LinkFault};

/// The stream a daemon connection runs over.
pub type LocalSocketStream = interprocess::local_socket::tokio::Stream;

/// Connects to the daemon's socket at `socket_path`; fails with `ClientError::Unavailable`, its
/// reason `NotListening` when no socket or no listener is there, `AccessDenied` when the socket
/// may not be opened or another account's process serves the Windows pipe, and `Unreachable` for
/// any other failure.
pub async fn connect_local_socket(socket_path: &Path) -> Result<LocalSocketStream, ClientError> {
    connect_socket(socket_path).await.map_err(unavailable)
}

/// The unavailable error a failed connect is, its reason read from the failure's kind.
fn unavailable(error: io::Error) -> ClientError {
    let reason = if found_no_listener(&error) {
        ConnectionUnavailableReason::NotListening
    } else if error.kind() == io::ErrorKind::PermissionDenied {
        ConnectionUnavailableReason::AccessDenied
    } else {
        ConnectionUnavailableReason::Unreachable
    };
    ClientError::Unavailable {
        reason,
        cause: LinkFault::Io(Arc::new(error)),
    }
}

//! The connect to the daemon on this machine, over its local socket. There is no fallback, so a
//! socket nobody answers on fails as unavailable rather than trying another address.

use std::io;
use std::path::Path;
use std::sync::Arc;

use interprocess::local_socket::traits::tokio::Stream as _;
use interprocess::local_socket::{GenericFilePath, ToFsName};
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;

use crate::error::{ClientError, LinkFault};

/// The stream a daemon connection runs over.
pub type LocalSocketStream = interprocess::local_socket::tokio::Stream;

/// Connects to the daemon's socket at `socket_path`; fails with `ClientError::Unavailable`, its
/// reason `NotListening` when no socket or no listener is there, `AccessDenied` when the socket
/// may not be opened, and `Unreachable` for any other failure.
pub async fn connect_local_socket(socket_path: &Path) -> Result<LocalSocketStream, ClientError> {
    let name = socket_path
        .to_fs_name::<GenericFilePath>()
        .map_err(unavailable)?;
    LocalSocketStream::connect(name).await.map_err(unavailable)
}

/// The unavailable error a failed connect is, its reason read from the failure's kind.
fn unavailable(error: io::Error) -> ClientError {
    let kind = error.kind();
    let reason = if kind == io::ErrorKind::NotFound || kind == io::ErrorKind::ConnectionRefused {
        ConnectionUnavailableReason::NotListening
    } else if kind == io::ErrorKind::PermissionDenied {
        ConnectionUnavailableReason::AccessDenied
    } else {
        ConnectionUnavailableReason::Unreachable
    };
    ClientError::Unavailable {
        reason,
        cause: LinkFault::Io(Arc::new(error)),
    }
}

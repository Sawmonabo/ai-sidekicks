//! What a daemon call can fail with: the connection, the daemon's own answer, a reply that does not
//! read as its method's type, a call the caller canceled before it was sent, and the run folder
//! and token checks a connect makes.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::daemon::recovery::DaemonRepairingDetails;
use sidekicks_contracts::jsonrpc::framing::FramingError;
use sidekicks_contracts::jsonrpc::message::{
    ConnectionUnavailableReason, JsonRpcError, JsonRpcErrorData, MessageError,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::attachment::AttachmentError;
use sidekicks_platforms::RunFolderRefused;

/// Why a connection to the daemon ended or never opened. Every call and stream on the connection
/// shares it, so each kind's cause is held behind an `Arc`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum LinkFault {
    /// The socket failed: the connect, a read or a write.
    #[error("the socket failed")]
    Io(#[source] Arc<io::Error>),
    /// The daemon broke the frame codec.
    #[error("the daemon broke the frame codec")]
    Framing(#[source] Arc<FramingError>),
    /// The daemon sent a message that is not a JSON-RPC 2.0 message.
    #[error("the daemon sent a message that is not JSON-RPC")]
    Message(#[source] Arc<MessageError>),
    /// The daemon ended the connection: the service stopped or exited.
    #[error("the service ended it")]
    PeerClosed,
    /// This side closed the connection.
    #[error("this client closed it")]
    Closed,
    /// No frame came from the daemon for as long as the link watch allows.
    #[error("the service stopped answering")]
    Silent,
}

/// An error response from the daemon, as it sent it: switch on `data.refusal` (the wire's
/// `data.type`), never on the message.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct RemoteError {
    /// The JSON-RPC numeric code.
    pub code: i64,
    /// The daemon's sentence for a person.
    pub message: String,
    /// The refusal's code, category and detail; absent on a bare protocol error.
    pub data: Option<JsonRpcErrorData>,
}

impl From<JsonRpcError> for RemoteError {
    fn from(error: JsonRpcError) -> Self {
        Self {
            code: error.code.get(),
            message: error.message,
            data: error.data,
        }
    }
}

impl RemoteError {
    /// Whether the daemon refused with `code`.
    pub fn is_refusal(&self, code: RefusalCode) -> bool {
        self.data
            .as_ref()
            .is_some_and(|data| data.refusal == code.as_str())
    }

    /// The `daemon.repairing` refusal's details, `None` for any other answer; fields that do not
    /// read as the refusal's read as a repair with no count.
    pub fn repairing_details(&self) -> Option<DaemonRepairingDetails> {
        self.is_refusal(RefusalCode::DaemonRepairing)
            .then(|| self.read_repairing_details())
    }

    /// This refusal's fields read as the `daemon.repairing` refusal's, with no count where they
    /// do not read so.
    pub(crate) fn read_repairing_details(&self) -> DaemonRepairingDetails {
        let fields = self.data.as_ref().and_then(|data| data.fields.as_ref());
        fields
            .and_then(|fields| serde_json::to_value(fields).ok())
            .and_then(|fields| serde_json::from_value(fields).ok())
            .unwrap_or(DaemonRepairingDetails { progress: None })
    }
}

/// Why a reply, an acknowledgment or a stream value did not read as its method's type.
#[derive(Debug, thiserror::Error)]
pub enum ReplyError {
    /// The JSON or its attachments do not read as the type.
    #[error("it does not read as its type")]
    Read(#[from] AttachmentError),
    /// It read but breaks a rule of its contract.
    #[error("it breaks a rule of its contract")]
    Rule(#[from] garde::Report),
}

/// Why a call's request could not be written for the wire.
#[derive(Debug, thiserror::Error)]
pub enum RequestError {
    /// The params' own `Serialize` failed.
    #[error("the params could not be written as JSON")]
    Json(#[from] serde_json::Error),
    /// The message passed its JSON or attachment cap.
    #[error(transparent)]
    Framing(#[from] FramingError),
}

/// A daemon call's failure.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// No daemon answers at the socket, or the link to it is down (`connection.unavailable`).
    #[error("The background service is not answering")]
    Unavailable {
        /// Why, as `connection.unavailable`'s `fields.reason` names it.
        reason: ConnectionUnavailableReason,
        /// The connect's or the link's failure.
        #[source]
        cause: LinkFault,
    },
    /// The daemon answered with an error.
    #[error(transparent)]
    Remote(#[from] RemoteError),
    /// The daemon's reply to `method` did not read as its contract.
    #[error("The background service's reply to {method} does not read as its contract")]
    Reply {
        /// The method called.
        method: String,
        /// Why it did not read.
        #[source]
        source: ReplyError,
    },
    /// The request for `method` could not be written.
    #[error("The request for {method} could not be written")]
    Request {
        /// The method called.
        method: String,
        /// Why it could not be written.
        #[source]
        source: RequestError,
    },
    /// The caller canceled a call the client still held behind the call cap, so nothing was sent.
    #[error("The call was canceled before it was sent")]
    Canceled,
    /// The run folder is not this account's alone, so its socket and token prove nothing.
    #[error(transparent)]
    RunFolder(#[from] RunFolderRefused),
    /// The daemon's session token file could not be read; `NotFound` while a daemon that has bound
    /// its socket has not yet written its token.
    #[error("The background service's token file {} could not be read", path.display())]
    Token {
        /// The token file.
        path: PathBuf,
        /// The read's failure.
        #[source]
        source: io::Error,
    },
}

impl ClientError {
    /// The failure every call on a link that went down settles with.
    pub fn link_down(cause: LinkFault) -> Self {
        Self::Unavailable {
            reason: ConnectionUnavailableReason::Unreachable,
            cause,
        }
    }
}

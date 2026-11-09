//! Why the daemon's start could not build the method tables' services.

use std::path::PathBuf;

use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_ipc::registry::RegistrationError;
use sidekicks_mcp::client::McpClientError;
use sidekicks_std::port_registration::PortRegistrationError;

use crate::daemon::process::session_services::SessionServiceStartError;
use crate::daemon::process::shell_table::ShellTableStartError;

/// Why the method tables' services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MethodInputsError {
    /// A driver port was registered already.
    #[error(transparent)]
    PortRegistration(#[from] PortRegistrationError),
    /// The session services could not be built.
    #[error(transparent)]
    SessionServices(#[from] SessionServiceStartError),
    /// The terminals' table could not be built.
    #[error(transparent)]
    ShellTable(#[from] ShellTableStartError),
    /// The tool servers' client could not be built.
    #[error(transparent)]
    McpClient(#[from] McpClientError),
    /// The filtered HTTP pools the MCP server sign-ins' OAuth calls go through could not be built.
    #[error("the MCP server sign-ins' HTTP pools could not be built")]
    McpSignInPools(#[source] reqwest::Error),
    /// A method was registered twice.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
    /// This machine's stored id is no device id, so neither the served socket nor a run's hold
    /// can name it.
    #[error("this computer's id {} is not a device id", machine_id.as_str())]
    MachineDeviceId {
        /// The stored id.
        machine_id: MachineId,
    },
    /// The socket's path is too long for the status read to report.
    #[error("the socket path {} cannot be reported", path.display())]
    SocketPathText {
        /// The socket's path.
        path: PathBuf,
    },
    /// A folder's path cannot be reported on the wire.
    #[error("the folder path {} cannot be reported", path.display())]
    FolderPathText {
        /// The folder's path.
        path: PathBuf,
        /// Why its text was refused.
        #[source]
        source: TextError,
    },
}

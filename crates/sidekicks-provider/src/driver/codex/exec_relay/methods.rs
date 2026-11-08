//! The methods the relay and its executor exchange: the one table of the methods a client may send,
//! as the executor's router serves them, each with how the relay carries it, and the names of the
//! executor's own messages the relay reads.

/// The handshake every executor connection opens with.
pub(super) const INITIALIZE_METHOD: &str = "initialize";
pub(super) const INITIALIZED_METHOD: &str = "initialized";

/// The write the relay sends itself for the person's input.
pub(super) const PROCESS_WRITE_METHOD: &str = "process/write";

/// The executor's notifications of a process's end.
pub(super) const PROCESS_EXITED_METHOD: &str = "process/exited";
pub(super) const PROCESS_CLOSED_METHOD: &str = "process/closed";

/// The executor's ask about a process's network access, which only the connection that started
/// the process answers.
pub(super) const NETWORK_POLICY_REQUEST_METHOD: &str = "network/policyRequest";

/// Whether `method` is one of the executor's notifications about one process, which reach only the
/// connection that started it.
pub(super) fn is_process_notification(method: &str) -> bool {
    matches!(
        method,
        "process/output" | PROCESS_EXITED_METHOD | PROCESS_CLOSED_METHOD | "network/policyDecision"
    )
}

/// How the relay carries one method a client sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClientMethod {
    /// `initialize`, answered from the relay's own, since the executor takes one per connection.
    Initialize,
    /// `initialized`, which the relay already sent.
    Initialized,
    /// `process/start`, run under a process id the relay mints and rewritten to run under the
    /// command wrapper; its answer names the connection's own id again.
    ProcessStart,
    /// `process/terminate`, under the relay's id for the process, held until the wrapper ended its
    /// command.
    ProcessTerminate,
    /// A method that names one of the connection's processes, passed on under the relay's id for
    /// it.
    ProcessNamed,
    /// Any other method the executor serves, passed on under the relay's request id.
    Passed,
}

impl ClientMethod {
    /// Whether the method names a process by the connection's own id.
    pub(super) fn names_process(self) -> bool {
        matches!(
            self,
            Self::ProcessStart | Self::ProcessTerminate | Self::ProcessNamed
        )
    }

    /// How the relay carries `method`; `None` for a method the executor does not serve.
    pub(super) fn of(method: &str) -> Option<Self> {
        Some(match method {
            INITIALIZE_METHOD => Self::Initialize,
            INITIALIZED_METHOD => Self::Initialized,
            "process/start" => Self::ProcessStart,
            "process/terminate" => Self::ProcessTerminate,
            "process/read" | PROCESS_WRITE_METHOD | "process/signal" => Self::ProcessNamed,
            "environment/info"
            | "environment/status"
            | "environmentConfig/read"
            | "capabilityRoots/discoverV1"
            | "capabilities/discoverV2"
            | "http/request"
            | "fs/readFile"
            | "fs/open"
            | "fs/readBlock"
            | "fs/writeBlock"
            | "fs/close"
            | "fs/writeFile"
            | "fs/createDirectory"
            | "fs/watchMissing"
            | "fs/getMetadata"
            | "fs/canonicalize"
            | "fs/readDirectory"
            | "fs/walk"
            | "fs/remove"
            | "fs/copy" => Self::Passed,
            _ => return None,
        })
    }
}

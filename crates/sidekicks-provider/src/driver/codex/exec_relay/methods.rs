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

/// How the relay carries one method a client sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClientMethod {
    /// `initialize`, answered from the relay's own, since the executor takes one per connection.
    Initialize,
    /// `initialized`, which the relay already sent.
    Initialized,
    /// `process/start`, rewritten to run under the command wrapper.
    ProcessStart,
    /// `process/terminate`, held until the wrapper ended its command.
    ProcessTerminate,
    /// Any other method the executor serves, passed on under the relay's request id.
    Passed,
}

impl ClientMethod {
    /// How the relay carries `method`; `None` for a method the executor does not serve.
    pub(super) fn of(method: &str) -> Option<Self> {
        Some(match method {
            INITIALIZE_METHOD => Self::Initialize,
            INITIALIZED_METHOD => Self::Initialized,
            "process/start" => Self::ProcessStart,
            "process/terminate" => Self::ProcessTerminate,
            "process/read"
            | PROCESS_WRITE_METHOD
            | "process/signal"
            | "environment/info"
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

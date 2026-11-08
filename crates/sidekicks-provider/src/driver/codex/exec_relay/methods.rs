//! The methods the relay and its executor exchange: the one table of the methods a client may send,
//! as the executor's router serves them, each with how the relay carries it, and the names of the
//! executor's own messages the relay reads.

/// The handshake every executor connection opens with.
pub(super) const INITIALIZE_METHOD: &str = "initialize";
pub(super) const INITIALIZED_METHOD: &str = "initialized";

/// The write the relay sends itself for the person's input.
pub(super) const PROCESS_WRITE_METHOD: &str = "process/write";

/// The close of an open file, which the relay also sends itself for a dropped connection's files.
pub(super) const FS_CLOSE_METHOD: &str = "fs/close";

/// A client's missing-path watch, which the relay joins into one and sends itself.
pub(super) const FS_WATCH_MISSING_METHOD: &str = "fs/watchMissing";

/// The executor's notification that its missing-path watch fired.
pub(super) const FS_MISSING_CHANGED_METHOD: &str = "fs/missingChanged";

/// The executor's notification carrying part of a streamed http body.
pub(super) const HTTP_REQUEST_BODY_DELTA_METHOD: &str = "http/request/bodyDelta";

/// The executor's notification carrying a chunk of a process's output.
pub(super) const PROCESS_OUTPUT_METHOD: &str = "process/output";

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
        PROCESS_OUTPUT_METHOD
            | PROCESS_EXITED_METHOD
            | PROCESS_CLOSED_METHOD
            | "network/policyDecision"
    )
}

/// The kind of id a client's method names, each kept in a table of its own: a process, an open
/// file's handle or an http request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RelayIdKind {
    /// A process's `processId`.
    Process,
    /// An open file's `handleId`.
    FileHandle,
    /// An http request's `requestId`.
    HttpRequest,
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
    /// `fs/open`, under a file handle the relay mints; its answer names the connection's own
    /// handle again.
    FileOpen,
    /// `fs/readBlock` and `fs/writeBlock`, under the relay's handle for the connection's file.
    FileNamed,
    /// `fs/close`, under the relay's handle for the connection's file, whose answer forgets it.
    FileClose,
    /// `http/request`, under a request id the relay mints, which a streamed body's deltas name.
    HttpRequest,
    /// `fs/watchMissing`, joined into the one watch the relay keeps on the executor and answered
    /// by the relay.
    WatchMissing,
    /// Any other method the executor serves, passed on under the relay's request id.
    Passed,
}

/// The id a client's method names by the connection's own id: its kind, read from the params'
/// member of that kind, and whether the method mints a relay id for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NamedId {
    /// The kind of id, which picks its table and its params' member.
    pub(super) kind: RelayIdKind,
    /// Whether the method mints a relay id, where any other takes the one already minted.
    pub(super) mints: bool,
}

impl ClientMethod {
    /// The id the method names by the connection's own id; `None` for one that names none.
    pub(super) fn named_id(self) -> Option<NamedId> {
        let (kind, mints) = match self {
            Self::ProcessStart => (RelayIdKind::Process, true),
            Self::ProcessTerminate | Self::ProcessNamed => (RelayIdKind::Process, false),
            Self::FileOpen => (RelayIdKind::FileHandle, true),
            Self::FileNamed | Self::FileClose => (RelayIdKind::FileHandle, false),
            Self::HttpRequest => (RelayIdKind::HttpRequest, true),
            Self::Initialize | Self::Initialized | Self::WatchMissing | Self::Passed => {
                return None;
            }
        };
        Some(NamedId { kind, mints })
    }

    /// How the relay carries `method`; `None` for a method the executor does not serve.
    pub(super) fn of(method: &str) -> Option<Self> {
        Some(match method {
            INITIALIZE_METHOD => Self::Initialize,
            INITIALIZED_METHOD => Self::Initialized,
            "process/start" => Self::ProcessStart,
            "process/terminate" => Self::ProcessTerminate,
            "process/read" | PROCESS_WRITE_METHOD | "process/signal" => Self::ProcessNamed,
            "fs/open" => Self::FileOpen,
            "fs/readBlock" | "fs/writeBlock" => Self::FileNamed,
            FS_CLOSE_METHOD => Self::FileClose,
            "http/request" => Self::HttpRequest,
            FS_WATCH_MISSING_METHOD => Self::WatchMissing,
            "environment/info"
            | "environment/status"
            | "environmentConfig/read"
            | "capabilityRoots/discoverV1"
            | "capabilities/discoverV2"
            | "fs/readFile"
            | "fs/writeFile"
            | "fs/createDirectory"
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

//! The service's lifecycle verbs: stop, restart, the flush at quit and the ping on a quiet link.
//! There is no start verb: a stopped service has no socket, so a start is the supervisor or the
//! command line spawning the process. A quit flushes and leaves every run and shell running; only
//! stop and restart end work.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::True;

/// How long a stopping service gives its terminals, all at once, to exit before it kills them, in
/// milliseconds.
pub const DAEMON_STOP_TERMINAL_DRAIN_MS: u64 = 2_000;

ts_constants! {
    /// The words the service's ready line carries, written once it answers on its socket;
    /// whoever started the process waits for a line that holds them.
    pub const DAEMON_READY_LINE: &str = "The daemon is ready";

    /// The longest a stopping service's drain runs, in milliseconds: its terminals' drain and
    /// time beside it for a write still running to finish rather than roll back. A client that saw
    /// a stop or restart taken waits this long for the service to exit before it signals it, so no
    /// signal cuts the drain short.
    pub const DAEMON_STOP_DRAIN_BOUND_MS: u64 = 4_000;
}

/// The service took the stop or restart.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonLifecycleAccepted {
    /// Always `true`.
    pub accepted: True,
}

/// Every write pending when the flush arrived is durable.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonFlushResponse {
    /// Always `true`.
    pub flushed: True,
}

methods! {
    /// The lifecycle verbs. Every verb takes an empty request; none is ever refused, so the
    /// service can always be stopped, restarted or flushed.
    pub const DAEMON_LIFECYCLE_METHOD_DESCRIPTORS = [
        /// A confirmed stop goes ahead at once, with no wait for the other connected clients.
        DaemonStop = mutation "daemon.stop" {
            mutating: true,
            takes_call_slot: false,
            params: EmptyPayload,
            result: DaemonLifecycleAccepted,
            refusals: [],
        },
        /// A restart goes ahead as a stop does.
        DaemonRestart = mutation "daemon.restart" {
            mutating: true,
            params: EmptyPayload,
            result: DaemonLifecycleAccepted,
            refusals: [],
        },
        /// Everything pending is made durable.
        DaemonFlush = mutation "daemon.flush" {
            mutating: true,
            params: EmptyPayload,
            result: DaemonFlushResponse,
            refusals: [],
        },
        /// Answers nothing: the answer arriving is the whole of it. The main process sends one
        /// only after 5 s with no frame from the service, so a busy link carries none.
        DaemonPing = query "daemon.ping" {
            mutating: false,
            takes_call_slot: false,
            params: EmptyPayload,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/lifecycle",
    doc: "The service's lifecycle verbs: stop, restart, the flush at quit and the ping on a quiet \
          link.",
    definitions: &[
        Definition::read::<DaemonLifecycleAccepted>().checked(),
        Definition::read::<DaemonFlushResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DAEMON_LIFECYCLE_METHOD_DESCRIPTORS],
};

//! What the relay owes each connection once the executor ends. Every request a connection sent
//! that the executor had not answered, and every later one, is answered with an error naming the
//! end, and every process of the connection's the executor reported and had not closed is reported
//! ended under the connection's own id: the error's text as its last output, then its exit and its
//! close, each numbered after the last event the connection got of it, as the client publishes a
//! process's events only in order. Each streamed http body gets a last delta carrying the error,
//! and each missing-path watch is told its watch changed, since nothing watches it any more. So
//! Codex's turn settles on its own, and no call waits on the executor while its connections stay
//! open.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

use super::executor::RelayConnectionId;
use super::methods::{
    HTTP_REQUEST_BODY_DELTA_METHOD, PROCESS_CLOSED_METHOD, PROCESS_EXITED_METHOD,
    PROCESS_OUTPUT_METHOD,
};

/// The JSON-RPC code of the answer a request gets once the executor ended: the internal error,
/// which Codex's own executor answers with when it fails to carry out a request.
const EXECUTOR_ENDED_ERROR_CODE: i64 = -32603;

/// The error's text, also each running process's last output.
pub(super) const EXECUTOR_ENDED_MESSAGE: &str = "The Codex executor running this service's commands ended; \
                                      the service starts a new one.";

/// The exit code a process the executor's end took is reported with, the one Codex's executor
/// reports for a process whose exit it could not read.
const EXECUTOR_ENDED_EXIT_CODE: i32 = -1;

/// A process event the executor reported, by its method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProcessEventKind {
    /// A chunk of the process's output.
    Output,
    /// The process's exit.
    Exited,
    /// The end of the process's output, its last event.
    Closed,
}

impl ProcessEventKind {
    /// The kind of event `method` reports; `None` for any other method.
    pub(super) fn from_method(method: &str) -> Option<Self> {
        match method {
            PROCESS_OUTPUT_METHOD => Some(Self::Output),
            PROCESS_EXITED_METHOD => Some(Self::Exited),
            PROCESS_CLOSED_METHOD => Some(Self::Closed),
            _ => None,
        }
    }
}

/// The stream an output chunk came on.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum OutputStream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
    /// The process's terminal.
    Pty,
}

/// One process as its connection knows it: its last event's number and how far it got.
#[derive(Default)]
struct ReportedProcess {
    last_seq: u64,
    has_exited: bool,
    is_on_terminal: bool,
}

/// The processes the executor has not closed, by their relay ids, which the relay reports ended
/// itself once the executor ended.
#[derive(Default)]
pub(super) struct ProcessLedger {
    processes: HashMap<String, ReportedProcess>,
}

impl ProcessLedger {
    /// Keeps the process `relay_id`, whose start the executor took.
    pub(super) fn open_process(&mut self, relay_id: &str) {
        self.processes.entry(relay_id.to_owned()).or_default();
    }

    /// Records an event of `kind`, numbered `seq`, the executor reported of the process
    /// `relay_id`; a close forgets the process.
    pub(super) fn record_event(
        &mut self,
        relay_id: &str,
        kind: ProcessEventKind,
        seq: Option<u64>,
        stream: Option<OutputStream>,
    ) {
        if kind == ProcessEventKind::Closed {
            self.processes.remove(relay_id);
            return;
        }
        let process = self.processes.entry(relay_id.to_owned()).or_default();
        process.last_seq = process.last_seq.max(seq.unwrap_or_default());
        process.has_exited |= kind == ProcessEventKind::Exited;
        process.is_on_terminal |= stream == Some(OutputStream::Pty);
    }

    /// The lines each connection is owed for its processes since the executor ended, each composed
    /// once under the connection and own id `owner_of` reads for its relay id; a process no
    /// connection holds any more is owed to no one.
    pub(super) fn take_owed_lines(
        &mut self,
        mut owner_of: impl FnMut(&str) -> Option<(RelayConnectionId, String)>,
    ) -> Vec<(RelayConnectionId, String)> {
        let mut lines = Vec::new();
        for (relay_id, process) in self.processes.drain() {
            let Some((connection, process_id)) = owner_of(&relay_id) else {
                continue;
            };
            let mut seq = process.last_seq;
            let mut next_seq = || {
                seq += 1;
                seq
            };
            if !process.has_exited {
                let stream = if process.is_on_terminal {
                    "pty"
                } else {
                    "stderr"
                };
                let output = json!({ "method": PROCESS_OUTPUT_METHOD, "params": {
                    "processId": process_id,
                    "seq": next_seq(),
                    "stream": stream,
                    "chunk": STANDARD.encode(format!("{EXECUTOR_ENDED_MESSAGE}\n")),
                }});
                let exited = json!({ "method": PROCESS_EXITED_METHOD, "params": {
                    "processId": process_id,
                    "seq": next_seq(),
                    "exitCode": EXECUTOR_ENDED_EXIT_CODE,
                    "sandboxDenied": false,
                }});
                lines.extend([
                    (connection, output.to_string()),
                    (connection, exited.to_string()),
                ]);
            }
            let closed = json!({ "method": PROCESS_CLOSED_METHOD, "params": {
                "processId": process_id,
                "seq": next_seq(),
            }});
            lines.push((connection, closed.to_string()));
        }
        lines
    }
}

/// The answer to a connection's request `id`, its own id as compact JSON, once the executor ended.
/// The last body delta of the streamed http request its connection calls `own_request_id`,
/// numbered `seq`, carrying the error that names the end, so the body's reader stops.
pub(super) fn compose_executor_ended_body_delta(own_request_id: &str, seq: u64) -> String {
    json!({ "method": HTTP_REQUEST_BODY_DELTA_METHOD, "params": {
        "requestId": own_request_id,
        "seq": seq,
        "deltaBase64": "",
        "done": true,
        "error": EXECUTOR_ENDED_MESSAGE,
    }})
    .to_string()
}

pub(super) fn compose_executor_ended_answer(id: &str) -> String {
    let id = RawValue::from_string(id.to_owned()).expect("a request's id was read as JSON");
    json!({ "id": id, "error": {
        "code": EXECUTOR_ENDED_ERROR_CODE,
        "message": EXECUTOR_ENDED_MESSAGE,
    }})
    .to_string()
}

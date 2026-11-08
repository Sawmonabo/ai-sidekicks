//! What the relay owes its client once the executor ends. Every request the client sent that the
//! executor had not answered, and every later one, is answered with an error naming the end, and
//! every process the executor reported and had not closed is reported ended: the error's text as
//! its last output, then its exit and its close, each numbered after the last event the client
//! got of it, as the client publishes a process's events only in order. So Codex's turn settles
//! on its own, and no call waits on the executor while its connection stays open.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

/// The JSON-RPC code of the answer a request gets once the executor ended: the internal error,
/// which Codex's own executor answers with when it fails to carry out a request.
const EXECUTOR_ENDED_ERROR_CODE: i64 = -32603;

/// The error's text, also each running process's last output.
const EXECUTOR_ENDED_MESSAGE: &str = "The Codex executor running this service's commands ended; \
                                      the service starts a new one.";

/// The exit code a process the executor's end took is reported with, the one Codex's executor
/// reports for a process whose exit it could not read.
const EXECUTOR_ENDED_EXIT_CODE: i32 = -1;

const PROCESS_OUTPUT_METHOD: &str = "process/output";
const PROCESS_EXITED_METHOD: &str = "process/exited";
const PROCESS_CLOSED_METHOD: &str = "process/closed";

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

/// One process as the client knows it: its last event's number and how far it got.
#[derive(Default)]
struct ReportedProcess {
    last_seq: u64,
    has_exited: bool,
    is_on_terminal: bool,
}

/// The client's requests the executor has not answered and the processes it has not closed, which
/// the relay settles itself once the executor ended.
#[derive(Default)]
pub(super) struct ClientLedger {
    is_ended: bool,
    // Each request by its id as compact JSON, with the process a start names.
    requests: HashMap<String, Option<String>>,
    processes: HashMap<String, ReportedProcess>,
}

impl ClientLedger {
    /// Keeps the client's request `id`, a start of `started_process` where it is one, until the
    /// executor answers it. Answers false once the executor ended, nothing then kept.
    pub(super) fn open_request(&mut self, id: &str, started_process: Option<String>) -> bool {
        if self.is_ended {
            return false;
        }
        self.requests.insert(id.to_owned(), started_process);
        true
    }

    /// Forgets the request `id` the executor answered; a start it took makes its process known.
    pub(super) fn answer_request(&mut self, id: &str, is_refused: bool) {
        if let Some(Some(process_id)) = self.requests.remove(id)
            && !is_refused
        {
            self.processes.entry(process_id).or_default();
        }
    }

    /// Records an event of `kind`, numbered `seq`, the executor reported of `process_id`; a close
    /// forgets the process.
    pub(super) fn record_event(
        &mut self,
        process_id: &str,
        kind: ProcessEventKind,
        seq: Option<u64>,
        stream: Option<OutputStream>,
    ) {
        if kind == ProcessEventKind::Closed {
            self.processes.remove(process_id);
            return;
        }
        let process = self.processes.entry(process_id.to_owned()).or_default();
        process.last_seq = process.last_seq.max(seq.unwrap_or_default());
        process.has_exited |= kind == ProcessEventKind::Exited;
        process.is_on_terminal |= stream == Some(OutputStream::Pty);
    }

    /// Marks the executor ended, so no request is kept after it.
    pub(super) fn end(&mut self) {
        self.is_ended = true;
    }

    /// The lines the client is owed since the executor ended, each composed once: an error answer
    /// for each request, then each process's end.
    pub(super) fn take_owed_lines(&mut self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .requests
            .drain()
            .map(|(id, _started_process)| compose_executor_ended_answer(&id))
            .collect();
        for (process_id, process) in self.processes.drain() {
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
                lines.extend([output.to_string(), exited.to_string()]);
            }
            let closed = json!({ "method": PROCESS_CLOSED_METHOD, "params": {
                "processId": process_id,
                "seq": next_seq(),
            }});
            lines.push(closed.to_string());
        }
        lines
    }
}

/// The answer to the client's request `id`, its id as compact JSON, once the executor ended.
pub(super) fn compose_executor_ended_answer(id: &str) -> String {
    let id = RawValue::from_string(id.to_owned()).expect("a request's id was read as JSON");
    json!({ "id": id, "error": {
        "code": EXECUTOR_ENDED_ERROR_CODE,
        "message": EXECUTOR_ENDED_MESSAGE,
    }})
    .to_string()
}

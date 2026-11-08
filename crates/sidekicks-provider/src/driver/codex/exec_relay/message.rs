//! One JSON-RPC message as the relay reads it, from a client or from the executor: the members it
//! routes by, read once per line and borrowed from it, and the splice that puts the relay's ids in
//! place of a line's own without parsing or re-serializing the rest.

use std::borrow::Cow;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::exec_relay::executor_end::OutputStream;
use crate::driver::codex::exec_relay::methods::RelayIdKind;

/// The members of a message the relay routes by; the rest passes on as it came.
#[derive(Deserialize)]
pub(super) struct RoutedMessage<'line> {
    /// The request's or the answer's id, as raw JSON.
    #[serde(borrow, default)]
    pub(super) id: Option<&'line RawValue>,
    /// The request's or the notification's method.
    #[serde(borrow, default)]
    pub(super) method: Option<Cow<'line, str>>,
    /// The members of its params the relay reads.
    #[serde(borrow, default)]
    pub(super) params: Option<RoutedParams<'line>>,
    /// An answer's result, as raw JSON.
    #[serde(borrow, default)]
    pub(super) result: Option<&'line RawValue>,
    /// An answer's refusal.
    #[serde(default)]
    pub(super) error: Option<RefusedRequest>,
}

impl<'line> RoutedMessage<'line> {
    /// `line` read as one message; `None` for a line that is no JSON object.
    pub(super) fn read(line: &'line str) -> Option<Self> {
        // A struct also reads from a JSON array, which no message is.
        if !line.trim_start().starts_with('{') {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}

/// The members of a message's params, or of an answer's result, the relay reads.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct RoutedParams<'line> {
    /// The process the message names, as raw JSON.
    #[serde(borrow)]
    pub(super) process_id: Option<&'line RawValue>,
    /// The open file the message names by its handle, as raw JSON.
    #[serde(borrow)]
    pub(super) handle_id: Option<&'line RawValue>,
    /// The http request the message names, as raw JSON.
    #[serde(borrow)]
    pub(super) request_id: Option<&'line RawValue>,
    /// The number of a process's event, which orders its events.
    pub(super) seq: Option<u64>,
    /// The exit code a `process/exited` reports.
    pub(super) exit_code: Option<i32>,
    /// The stream a `process/output` chunk came on.
    pub(super) stream: Option<OutputStream>,
    /// A missing-path watch's own id, a number.
    pub(super) watch_id: Option<u64>,
    /// The paths a missing-path watch waits to see appear, as raw JSON.
    #[serde(borrow)]
    pub(super) missing: Option<&'line RawValue>,
    /// The one path a missing-path watch waits to stay, as raw JSON.
    #[serde(borrow)]
    pub(super) present: Option<&'line RawValue>,
    /// Whether an http request streams its body as deltas after its answer.
    pub(super) stream_response: bool,
    /// Whether a body delta is its request's last.
    pub(super) done: bool,
    /// A body delta's failure, which also makes it its request's last, as raw JSON.
    #[serde(borrow)]
    pub(super) error: Option<&'line RawValue>,
}

impl<'line> RoutedParams<'line> {
    /// The member that names an id of `kind`, as raw JSON.
    pub(super) fn id_of(&self, kind: RelayIdKind) -> Option<&'line RawValue> {
        match kind {
            RelayIdKind::Process => self.process_id,
            RelayIdKind::FileHandle => self.handle_id,
            RelayIdKind::HttpRequest => self.request_id,
        }
    }
}

/// An answer's refusal, as far as the relay reads it.
#[derive(Deserialize)]
pub(super) struct RefusedRequest {
    /// The refusal in words.
    pub(super) message: Option<String>,
}

/// The text of `field`, a raw JSON value; `None` for one that is no string.
pub(super) fn text_of(field: &RawValue) -> Option<String> {
    serde_json::from_str(field.get()).ok()
}

/// `line` with each field's replacement, raw JSON, in its place, every field a slice of `line` its
/// parse borrowed, so the rest of the line is copied once and never parsed again.
pub(super) fn splice<'field>(
    line: &str,
    fields: impl IntoIterator<Item = (&'field RawValue, &'field str)>,
) -> String {
    let mut spans: Vec<(usize, usize, &str)> = fields
        .into_iter()
        .map(|(field, replacement)| {
            let start = field.get().as_ptr().addr() - line.as_ptr().addr();
            (start, start + field.get().len(), replacement)
        })
        .collect();
    spans.sort_unstable_by_key(|(start, _end, _replacement)| *start);
    let mut spliced = String::with_capacity(line.len());
    let mut copied = 0;
    for (start, end, replacement) in spans {
        spliced.push_str(&line[copied..start]);
        spliced.push_str(replacement);
        copied = end;
    }
    spliced.push_str(&line[copied..]);
    spliced
}

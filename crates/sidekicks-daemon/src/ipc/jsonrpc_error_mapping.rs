//! The error response for every call the daemon answers with a failure: the numeric code, a
//! message for a person and the refusal's code and fields. Both text channels are sanitized on the
//! way out: absolute paths are redacted and every value is capped, so neither a stack-shaped
//! message nor a wide detail reaches the wire. A refusal of received input sends fixed words and
//! names each fault only by its path in the wire's names, never quoting the value.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::LazyLock;

use regex::{Captures, NoExpand, Regex};
use serde_json::error::Category;
use serde_json::{Map, Value};
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::issue::{Issue, IssuePathSegment};
use sidekicks_contracts::jsonrpc::message::{
    JsonRpcError, JsonRpcErrorData, JsonRpcId, JsonRpcMessage, MessageError,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::event_cursor::EventCursorUnresolvable;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::attachment::ReceivedError;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::{
    NODE_ID_DUPLICATE_MESSAGE, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
use crate::ipc::registry::{DispatchError, HandlerError};
use crate::issue_path::resolve_issue_path;
use crate::text_cut::cut_to_code_points;

/// What replaces an absolute path in a message or a field.
const REDACTED_PATH: &str = "<redacted-path>";

/// What a capped message or field value ends with.
const TRUNCATION_MARKER: &str = "…[truncated]";

/// Longest string kept in a field, in code points, so one long string cannot balloon the reply.
const FIELDS_VALUE_MAX_LEN: usize = 512;

/// Most members kept per object.
const FIELDS_MAX_KEYS: usize = 32;

/// Most elements kept per array.
const FIELDS_MAX_ARRAY_LEN: usize = 32;

/// Deepest nesting the walk follows.
const FIELDS_MAX_DEPTH: usize = 6;

/// Most members and elements the walk keeps in all; the per-level caps alone allow a billion.
const FIELDS_MAX_NODES: usize = 1024;

/// The member that says how much of an object was left out.
const TRUNCATED_KEYS_KEY: &str = "<truncated>";

/// What stands for a value nested past [`FIELDS_MAX_DEPTH`].
const TRUNCATED_DEPTH: &str = "<truncated:max-depth>";

/// What stands for the rest once [`FIELDS_MAX_NODES`] are kept.
const TRUNCATED_NODES: &str = "<truncated:max-nodes>";

/// Member names a JavaScript reader treats as an object's prototype machinery, left out at every
/// depth.
const RESERVED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// The message of a message whose JSON does not parse.
const UNPARSEABLE_MESSAGE: &str = "the message is not JSON";

/// The message of JSON that is no JSON-RPC 2.0 message.
const NOT_A_MESSAGE: &str = "the JSON is not a JSON-RPC 2.0 message";

/// The message of a message over its size cap.
const MESSAGE_TOO_LARGE: &str = "the message is over its size limit";

/// The issue of a value the schema accepts but its type refuses.
const UNREADABLE_VALUE: &str = "this value does not read as its type";

/// A Unix path at a token boundary, with an optional `:line:col`; the leading group stands for
/// the boundary (`regex` has no look-behind) and is written back, so `feature/login` stays.
static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9_.-])(?:/[A-Za-z0-9_.-]+)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// A UNC path: the host has no spaces, the share and path segments may.
static UNC_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_. -]+)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// A Windows drive path, whose segments may hold spaces.
static DRIVE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+(?::[0-9]+(?::[0-9]+)?)?")
        .expect("the pattern is a valid regex")
});

/// Why a message gets an error response: its call's dispatch failed, its JSON is no JSON-RPC 2.0
/// message, or it passed its size cap.
#[derive(Debug)]
pub(crate) enum CallFailure {
    /// The call reached the dispatch and produced no reply.
    Dispatch(DispatchError),
    /// The message's JSON does not parse or is no JSON-RPC 2.0 message.
    Message(MessageError),
    /// The message passed its cap, in bytes.
    MessageTooLarge {
        /// The cap.
        limit: usize,
        /// The size seen, or as much as arrived before the cap was passed.
        observed: usize,
    },
}

/// The error response answering `failure` under `id`, the id the gateway read from the message
/// (`null` where it could not). A daemon fault is logged here, once; a refusal of received input
/// never is, since its sources can quote the value.
pub(crate) fn map_json_rpc_error(failure: CallFailure, id: JsonRpcId) -> JsonRpcMessage {
    JsonRpcMessage::ErrorResponse {
        id,
        error: json_rpc_error_of(failure),
    }
}

/// The JSON-RPC error answering `failure`, for an error response or a subscription's refused end
/// frame; logged as [`map_json_rpc_error`] logs it.
pub(crate) fn json_rpc_error_of(failure: CallFailure) -> JsonRpcError {
    match failure {
        CallFailure::Dispatch(error) => map_dispatch_error(error),
        // serde's own message can quote the JSON, so each kind answers fixed words.
        CallFailure::Message(MessageError::Json(error)) => {
            let (code, message) = match error.classify() {
                Category::Syntax | Category::Eof => {
                    (JsonRpcErrorCode::ParseError, UNPARSEABLE_MESSAGE)
                }
                Category::Data | Category::Io => (JsonRpcErrorCode::InvalidRequest, NOT_A_MESSAGE),
            };
            json_rpc_error(code, message, None)
        }
        CallFailure::Message(MessageError::NotAMessage) => {
            json_rpc_error(JsonRpcErrorCode::InvalidRequest, NOT_A_MESSAGE, None)
        }
        CallFailure::MessageTooLarge { limit, observed } => {
            let fields: Map<String, Value> = [
                ("limit".to_owned(), Value::from(limit)),
                ("observed".to_owned(), Value::from(observed)),
            ]
            .into_iter()
            .collect();
            json_rpc_error(
                JsonRpcErrorCode::InvalidRequest,
                MESSAGE_TOO_LARGE,
                Some(refusal_data(
                    RefusalCode::TransportMessageTooLarge,
                    Some(fields),
                )),
            )
        }
    }
}

/// The error response of one dispatch failure.
fn map_dispatch_error(error: DispatchError) -> JsonRpcError {
    let message = error.to_string();
    match error {
        DispatchError::MethodNotFound => json_rpc_error(
            JsonRpcErrorCode::MethodNotFound,
            &message,
            Some(refusal_data(RefusalCode::MethodNotFound, None)),
        ),
        DispatchError::InvalidParams(refusal) => {
            let issues = match &refusal {
                ReceivedError::Check(check_error) => return internal_failure(check_error),
                ReceivedError::Json(_) => Vec::new(),
                ReceivedError::Shape { faults } => faults
                    .iter()
                    .map(|fault| Issue {
                        path: fault.path.clone(),
                        message: format!("breaks the schema's \"{}\" rule", fault.keyword),
                        params: None,
                    })
                    .collect(),
                ReceivedError::Read { path, .. } => vec![Issue {
                    path: path.clone(),
                    message: UNREADABLE_VALUE.to_owned(),
                    params: None,
                }],
                ReceivedError::Unreferenced { index } => vec![Issue {
                    path: Vec::new(),
                    message: format!("attachment {index} is named by no placeholder"),
                    params: None,
                }],
                ReceivedError::Rule { report, received } => rule_issues(report, received),
            };
            json_rpc_error(
                JsonRpcErrorCode::InvalidParams,
                &message,
                Some(refusal_data(
                    RefusalCode::InvalidParams,
                    issue_fields(&issues),
                )),
            )
        }
        DispatchError::Refused(refusal) => {
            if refusal.source.is_some() {
                tracing::warn!(
                    error = &refusal as &(dyn Error + 'static),
                    "A refusal carries a failure underneath"
                );
            }
            let code = JsonRpcErrorCode::from(refusal.json_rpc_code);
            json_rpc_error(
                code,
                &message,
                Some(refusal_data(refusal.code, refusal.detail)),
            )
        }
        DispatchError::Canceled => JsonRpcError::request_canceled(),
        DispatchError::Internal(fault) => internal_failure(&*fault),
        DispatchError::InvalidResult { report, value } => {
            tracing::error!(
                error = &report as &(dyn Error + 'static),
                "The daemon's answer breaks its contract"
            );
            let issues = rule_issues(&report, &value);
            json_rpc_error(
                JsonRpcErrorCode::InternalError,
                &message,
                Some(refusal_data(
                    RefusalCode::InvalidResult,
                    issue_fields(&issues),
                )),
            )
        }
    }
}

/// The answer to a fault inside the daemon: `-32603` with its sanitized message and no `data`,
/// logged once.
fn internal_failure(fault: &(dyn Error + 'static)) -> JsonRpcError {
    tracing::error!(error = fault, "A call failed inside the daemon");
    json_rpc_error(JsonRpcErrorCode::InternalError, &fault.to_string(), None)
}

/// Each broken rule of `report` at its path resolved against `checked`, the JSON the value was
/// read from or written as, with garde's message. A repeated workflow node id also carries its
/// `node_id_duplicate` finding over the id at that path.
fn rule_issues(report: &garde::Report, checked: &Value) -> Vec<Issue> {
    report
        .iter()
        .map(|(check_path, rule_error)| {
            let path = resolve_issue_path(check_path, checked);
            let params = (rule_error.message() == NODE_ID_DUPLICATE_MESSAGE)
                .then(|| node_id_duplicate_finding(&path, checked))
                .flatten();
            Issue {
                path,
                message: rule_error.message().to_owned(),
                params,
            }
        })
        .collect()
}

/// The `node_id_duplicate` finding over the node id `checked` holds at `path`; `None` where the
/// path stops short of the id.
fn node_id_duplicate_finding(path: &[IssuePathSegment], checked: &Value) -> Option<Value> {
    let node_id = path
        .iter()
        .try_fold(checked, |at, segment| match segment {
            IssuePathSegment::Member(name) => at.get(name),
            IssuePathSegment::Index(index) => at.get(usize::try_from(index.get()).ok()?),
        })
        .and_then(Value::as_str)
        .and_then(|text| WorkflowNodeId::new(text.to_owned()))?;
    let finding = WorkflowDefinitionFinding::NodeIdDuplicate {
        node_ids: vec![node_id],
    };
    Some(serde_json::to_value(finding).expect("a finding is plain text and lists"))
}

/// The `{issues}` fields of an `invalid_params` or `invalid_result` refusal, the first
/// [`FIELDS_MAX_ARRAY_LEN`] of them, so the sanitizer never adds its text marker to a list of
/// issues; none when the list is empty.
fn issue_fields(issues: &[Issue]) -> Option<Map<String, Value>> {
    (!issues.is_empty()).then(|| {
        let kept = &issues[..issues.len().min(FIELDS_MAX_ARRAY_LEN)];
        let issues = serde_json::to_value(kept).expect("an issue is plain text and lists");
        [("issues".to_owned(), issues)].into_iter().collect()
    })
}

/// A refusal's `data`: its code, and its fields once sanitized.
fn refusal_data(code: RefusalCode, fields: Option<Map<String, Value>>) -> JsonRpcErrorData {
    JsonRpcErrorData {
        refusal: code.as_str().to_owned(),
        fields: fields.map(|fields| {
            let members: BTreeMap<String, AnyValue> = sanitize_fields(fields)
                .into_iter()
                .map(|(key, value)| (key, AnyValue(value)))
                .collect();
            Record::new(members).expect("the sanitizer leaves out the member __proto__")
        }),
    }
}

/// A JSON-RPC error with `message` sanitized.
fn json_rpc_error(
    code: JsonRpcErrorCode,
    message: &str,
    data: Option<JsonRpcErrorData>,
) -> JsonRpcError {
    JsonRpcError {
        code: SafeSignedInt::new(i64::from(code.code()))
            .expect("a JSON-RPC error code is a safe integer"),
        message: cap_text(redact_paths(message), ERROR_MESSAGE_MAX_LEN),
        data,
    }
}

/// `text` with each Unix, UNC and Windows-drive path, and its `:line:col`, replaced by
/// `<redacted-path>`. A Windows segment may hold spaces, so prose right after such a path can be
/// redacted with it, the safe direction.
fn redact_paths(text: &str) -> String {
    let text = UNIX_PATH.replace_all(text, |captures: &Captures<'_>| {
        format!("{}{REDACTED_PATH}", &captures[1])
    });
    let text = UNC_PATH.replace_all(&text, NoExpand(REDACTED_PATH));
    DRIVE_PATH
        .replace_all(&text, NoExpand(REDACTED_PATH))
        .into_owned()
}

/// `text` cut to `max_code_points` code points, its end replaced by the truncation marker when
/// cut.
fn cap_text(text: String, max_code_points: usize) -> String {
    if cut_to_code_points(&text, max_code_points).len() == text.len() {
        return text;
    }
    let kept = cut_to_code_points(&text, max_code_points - TRUNCATION_MARKER.chars().count());
    format!("{kept}{TRUNCATION_MARKER}")
}

/// A refusal's fields made safe to send: strings path-redacted and capped, and objects, arrays,
/// depth and the whole walk held to their caps, each cut marked where it falls.
fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    let mut budget = FIELDS_MAX_NODES;
    sanitize_members(fields, 0, &mut budget)
}

fn sanitize_value(value: Value, depth: usize, budget: &mut usize) -> Value {
    if depth > FIELDS_MAX_DEPTH {
        return Value::from(TRUNCATED_DEPTH);
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value,
        Value::String(text) => Value::String(cap_text(redact_paths(&text), FIELDS_VALUE_MAX_LEN)),
        Value::Array(elements) => Value::Array(sanitize_elements(elements, depth, budget)),
        Value::Object(members) => Value::Object(sanitize_members(members, depth, budget)),
    }
}

fn sanitize_members(
    members: Map<String, Value>,
    depth: usize,
    budget: &mut usize,
) -> Map<String, Value> {
    let member_count = members.len();
    let mut kept = Map::new();
    let mut kept_count = 0;
    for (key, child) in members {
        if kept_count >= FIELDS_MAX_KEYS {
            let left_out = format!("{}-more-keys", member_count - FIELDS_MAX_KEYS);
            kept.insert(TRUNCATED_KEYS_KEY.to_owned(), Value::String(left_out));
            break;
        }
        if RESERVED_KEYS.contains(&key.as_str()) {
            continue;
        }
        if *budget == 0 {
            kept.insert(TRUNCATED_KEYS_KEY.to_owned(), Value::from(TRUNCATED_NODES));
            break;
        }
        *budget -= 1;
        let child = sanitize_value(child, depth + 1, budget);
        kept.insert(key, child);
        kept_count += 1;
    }
    kept
}

fn sanitize_elements(elements: Vec<Value>, depth: usize, budget: &mut usize) -> Vec<Value> {
    let element_count = elements.len();
    let mut kept = Vec::with_capacity(element_count.min(FIELDS_MAX_ARRAY_LEN + 1));
    for element in elements.into_iter().take(FIELDS_MAX_ARRAY_LEN) {
        if *budget == 0 {
            kept.push(Value::from(TRUNCATED_NODES));
            return kept;
        }
        *budget -= 1;
        kept.push(sanitize_value(element, depth + 1, budget));
    }
    if element_count > FIELDS_MAX_ARRAY_LEN {
        let left_out = element_count - FIELDS_MAX_ARRAY_LEN;
        kept.push(Value::String(format!("<truncated:{left_out}-more>")));
    }
    kept
}

/// A cursor naming no log position is a bad parameter; the refusal sends no fields, so the
/// client's cursor is never echoed.
impl From<EventCursorUnresolvable> for DomainError {
    fn from(error: EventCursorUnresolvable) -> Self {
        Self::new(
            error.to_string(),
            RefusalCode::EventCursorUnresolvable,
            DomainErrorJsonRpcCode::InvalidParams,
        )
    }
}

/// A handler refuses an unresolvable cursor with `?`.
impl From<EventCursorUnresolvable> for HandlerError {
    fn from(error: EventCursorUnresolvable) -> Self {
        Self::Refused(error.into())
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use schemars::JsonSchema;
    use serde::Deserialize;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::jsonrpc::message::JsonRpcId;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::wire::attachment::parse_received;
    use sidekicks_contracts::wire::integer::BoundedInt;

    use super::{
        CallFailure, FIELDS_MAX_ARRAY_LEN, FIELDS_MAX_DEPTH, FIELDS_MAX_KEYS, FIELDS_MAX_NODES,
        FIELDS_VALUE_MAX_LEN, map_json_rpc_error,
    };
    use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
    use crate::ipc::registry::DispatchError;

    /// The received value the refusals below must never quote.
    const SECRET_DIGITS: &str = "7340251";

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lookup {
        #[garde(skip)]
        run_sequence: BoundedInt<0, 9>,
        #[garde(length(max = 4))]
        display_label: String,
    }

    /// The whole response `failure` answers, as JSON.
    fn answer(failure: CallFailure) -> Value {
        let response = map_json_rpc_error(failure, JsonRpcId::Number(1.into()));
        let json = response.to_vec().expect("an error response writes");
        serde_json::from_slice(&json).expect("an error response is JSON")
    }

    fn refused(message: &str, detail: Option<Map<String, Value>>) -> Value {
        let refusal = DomainError::new(
            message,
            RefusalCode::SystemInternalError,
            DomainErrorJsonRpcCode::InternalError,
        );
        let refusal = match detail {
            Some(detail) => refusal.with_detail(detail),
            None => refusal,
        };
        answer(CallFailure::Dispatch(DispatchError::Refused(refusal)))
    }

    // serde's refusal of the sequence reads "7340251 is outside 0..=9"; the rule's path is garde's
    // `display_label`, sent in the wire's name.
    #[rstest]
    #[case::read(r#"{"runSequence": 7340251, "displayLabel": "ok"}"#, "runSequence")]
    #[case::rule(r#"{"runSequence": 3, "displayLabel": "7340251"}"#, "displayLabel")]
    fn a_refused_value_is_never_quoted(#[case] params: &str, #[case] member: &str) {
        let refusal = parse_received::<Lookup>(params.as_bytes(), Vec::new())
            .expect_err("the params are refused");
        let response = answer(CallFailure::Dispatch(DispatchError::InvalidParams(refusal)));
        assert_eq!(response["error"]["code"], -32_602);
        assert_eq!(response["error"]["data"]["type"], "invalid_params");
        let issues = response["error"]["data"]["fields"]["issues"]
            .as_array()
            .expect("the refusal lists its issues");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["path"], json!([member]));
        assert!(!response.to_string().contains(SECRET_DIGITS), "{response}");
    }

    #[rstest]
    #[case::unix(
        "cannot open /Users/someone/notes.json now",
        "cannot open <redacted-path> now"
    )]
    #[case::unc(
        r"cannot read \\files\Shared Drive\a.json",
        "cannot read <redacted-path>"
    )]
    #[case::drive_with_spaces(
        r"cannot run C:\Program Files\tool.exe",
        "cannot run <redacted-path>"
    )]
    #[case::line_and_column("at /src/main.rs:12:7 (main)", "at <redacted-path> (main)")]
    #[case::branch_kept(
        "branch feature/login is checked out",
        "branch feature/login is checked out"
    )]
    fn absolute_paths_are_redacted_from_the_message(#[case] message: &str, #[case] sent: &str) {
        let response = refused(message, None);
        assert_eq!(response["error"]["message"], sent);
    }

    /// The largest extent a value reaches: members per object, elements per array, code points per
    /// string, members and elements in all, and objects and arrays nested.
    #[derive(Default)]
    struct Extent {
        widest_object: usize,
        longest_array: usize,
        longest_string: usize,
        nodes: usize,
        depth: usize,
    }

    fn measure(value: &Value, depth: usize, extent: &mut Extent) {
        extent.depth = extent.depth.max(depth);
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::String(text) => {
                extent.longest_string = extent.longest_string.max(text.chars().count());
            }
            Value::Array(elements) => {
                extent.longest_array = extent.longest_array.max(elements.len());
                extent.nodes += elements.len();
                for element in elements {
                    measure(element, depth + 1, extent);
                }
            }
            Value::Object(members) => {
                extent.widest_object = extent.widest_object.max(members.len());
                extent.nodes += members.len();
                for member in members.values() {
                    measure(member, depth + 1, extent);
                }
            }
        }
    }

    #[test]
    fn a_wide_deep_detail_stays_within_the_caps() {
        let long_text = "x".repeat(FIELDS_VALUE_MAX_LEN + 100);
        let mut deep = json!(long_text);
        for _ in 0..2 * FIELDS_MAX_DEPTH {
            deep = json!({ "inner": deep });
        }
        let element = json!({ "text": long_text, "inner": deep });
        let wide = Value::Array(vec![element; 2 * FIELDS_MAX_ARRAY_LEN]);
        // Small enough that its own member cap is reached before the walk's node cap.
        let many_members: Map<String, Value> = (0..2 * FIELDS_MAX_KEYS)
            .map(|index| (format!("count{index}"), json!(index)))
            .collect();
        let detail: Map<String, Value> = [("counts".to_owned(), Value::Object(many_members))]
            .into_iter()
            .chain((0..2 * FIELDS_MAX_KEYS).map(|index| (format!("member{index}"), wide.clone())))
            .collect();
        let response = refused("the detail is wide", Some(detail));
        let mut extent = Extent::default();
        measure(&response["error"]["data"]["fields"], 0, &mut extent);
        // A cut adds one marker member or element where it falls, at most one per object or array.
        assert!(extent.widest_object <= FIELDS_MAX_KEYS + 1);
        assert!(extent.longest_array <= FIELDS_MAX_ARRAY_LEN + 1);
        assert!(extent.longest_string <= FIELDS_VALUE_MAX_LEN);
        assert!(extent.depth <= FIELDS_MAX_DEPTH + 1);
        assert!(
            extent.nodes <= 2 * FIELDS_MAX_NODES + 1,
            "{} nodes",
            extent.nodes
        );
    }
}

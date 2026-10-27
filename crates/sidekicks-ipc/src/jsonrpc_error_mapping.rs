//! The error response for every call the daemon answers with a failure: the numeric code, a
//! message for a person and the refusal's code and fields. Both text channels are sanitized on the
//! way out: absolute paths are redacted and every value is capped, so neither a stack-shaped
//! message nor a wide detail reaches the wire. A refusal of received input sends fixed words and
//! names each fault only by its path in the wire's names, never quoting the value: at most
//! `ISSUES_MAX` issues, each path cut to an ancestor within the caps, so it holds no marker.

use std::collections::BTreeMap;
use std::error::Error;

use regex::{Captures, NoExpand};
use serde_json::error::Category;
use serde_json::{Map, Value, json};
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::issue::{Issue, IssuePathSegment, received_issues, rule_issues};
use sidekicks_contracts::jsonrpc::message::{
    JsonRpcError, JsonRpcErrorData, JsonRpcId, JsonRpcMessage, MessageError,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::event_cursor::SessionEventCursorUnresolvable;
use sidekicks_contracts::transcript::content::BodyReadOffsetRefused;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::record::Record;

use crate::domain_error::{DomainError, refusal_fields};
use crate::redaction::{DRIVE_PATH, UNC_PATH, UNIX_PATH};
use crate::registry::{DispatchError, HandlerError};
use crate::session_not_found::session_not_found;
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::events::log_service::{EventLogFollowError, EventLogReadError};

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
const UNPARSABLE_MESSAGE: &str = "the message is not JSON";

/// The message of JSON that is no JSON-RPC 2.0 message.
const NOT_A_MESSAGE: &str = "the JSON is not a JSON-RPC 2.0 message";

/// The message of a message over its size cap.
const MESSAGE_TOO_LARGE: &str = "the message is over its size limit";

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
        CallFailure::Message(MessageError::Json(error)) => match error.classify() {
            Category::Syntax | Category::Eof => {
                json_rpc_error(JsonRpcErrorCode::ParseError, UNPARSABLE_MESSAGE, None)
            }
            Category::Data | Category::Io => envelope_invalid(),
        },
        CallFailure::Message(MessageError::NotAMessage) => envelope_invalid(),
        CallFailure::MessageTooLarge { limit, observed } => {
            let fields = refusal_fields(json!({ "limit": limit, "observed": observed }));
            json_rpc_error(
                RefusalCode::ConnectionMessageTooLarge.json_rpc_code(),
                MESSAGE_TOO_LARGE,
                Some(refusal_data(
                    RefusalCode::ConnectionMessageTooLarge,
                    Some(fields),
                )),
            )
        }
    }
}

/// The answer to JSON that is no JSON-RPC 2.0 message: `request.envelopeInvalid`, with no fields.
fn envelope_invalid() -> JsonRpcError {
    json_rpc_error(
        RefusalCode::RequestEnvelopeInvalid.json_rpc_code(),
        NOT_A_MESSAGE,
        Some(refusal_data(RefusalCode::RequestEnvelopeInvalid, None)),
    )
}

/// The error response of one dispatch failure.
fn map_dispatch_error(error: DispatchError) -> JsonRpcError {
    let message = error.to_string();
    match error {
        DispatchError::MethodNotFound => json_rpc_error(
            RefusalCode::RequestMethodNotFound.json_rpc_code(),
            &message,
            Some(refusal_data(RefusalCode::RequestMethodNotFound, None)),
        ),
        DispatchError::ParamsInvalid(refusal) => {
            let issues = match received_issues(refusal) {
                Ok(issues) => issues.into_iter().map(capped_issue).collect(),
                Err(check_error) => return internal_failure(&check_error),
            };
            json_rpc_error(
                RefusalCode::RequestParamsInvalid.json_rpc_code(),
                &message,
                Some(issue_refusal_data(
                    RefusalCode::RequestParamsInvalid,
                    issues,
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
            json_rpc_error(
                refusal.code.json_rpc_code(),
                &message,
                Some(refusal_data(refusal.code, refusal.detail)),
            )
        }
        DispatchError::Canceled => JsonRpcError::request_canceled(),
        DispatchError::Internal(fault) => internal_failure(&*fault),
        DispatchError::ResultInvalid { report, value } => {
            tracing::error!(
                error = &report as &(dyn Error + 'static),
                "The daemon's answer breaks its contract"
            );
            let issues = rule_issues(&report, &value)
                .into_iter()
                .map(capped_issue)
                .collect();
            json_rpc_error(
                RefusalCode::RequestResultInvalid.json_rpc_code(),
                &message,
                Some(issue_refusal_data(
                    RefusalCode::RequestResultInvalid,
                    issues,
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

/// `issue` as the wire carries it: its path, already at most the contracts' step cap, cut before
/// its first member name longer than [`FIELDS_VALUE_MAX_LEN`] or holding an absolute path, so it
/// names an ancestor of the fault and holds the caps the sanitizer holds with no marker; its
/// message path-redacted and capped as a field is.
fn capped_issue(issue: Issue) -> Issue {
    let Issue {
        path,
        message,
        params,
    } = issue;
    let path = path
        .into_iter()
        .take_while(|segment| match segment {
            IssuePathSegment::Member(name) => {
                name.chars().nth(FIELDS_VALUE_MAX_LEN).is_none() && redact_paths(name) == *name
            }
            IssuePathSegment::Index(_) => true,
        })
        .collect();
    Issue {
        path,
        message: cap_text(redact_paths(&message), FIELDS_VALUE_MAX_LEN),
        params,
    }
}

/// The `data` of a `request.paramsInvalid` or `request.resultInvalid` refusal: `{issues}`, built
/// past the sanitizer since each issue already holds its caps, or no fields when the list is empty.
fn issue_refusal_data(code: RefusalCode, issues: Vec<Issue>) -> JsonRpcErrorData {
    let fields = (!issues.is_empty()).then(|| {
        let issues = serde_json::to_value(issues).expect("an issue is plain text and lists");
        Record::new(BTreeMap::from([("issues".to_owned(), AnyValue(issues))]))
            .expect("the member issues is no prototype key")
    });
    JsonRpcErrorData {
        refusal: code.as_str().to_owned(),
        category: code.category(),
        fields,
    }
}

/// A refusal's `data`: its code, and its fields once sanitized.
fn refusal_data(code: RefusalCode, fields: Option<Map<String, Value>>) -> JsonRpcErrorData {
    JsonRpcErrorData {
        refusal: code.as_str().to_owned(),
        category: code.category(),
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

/// A cursor naming no log position is refused `session.event.cursorUnresolvable` with no fields,
/// so the client's cursor is never echoed.
impl From<SessionEventCursorUnresolvable> for DomainError {
    fn from(error: SessionEventCursorUnresolvable) -> Self {
        Self::new(
            error.to_string(),
            RefusalCode::SessionEventCursorUnresolvable,
        )
    }
}

/// A handler refuses an unresolvable cursor with `?`.
impl From<SessionEventCursorUnresolvable> for HandlerError {
    fn from(error: SessionEventCursorUnresolvable) -> Self {
        Self::Refused(error.into())
    }
}

/// A body offset that is no place to resume from is refused `transcript.body.offsetInvalid`,
/// carrying the offset and the body's length in bytes.
impl From<BodyReadOffsetRefused> for DomainError {
    fn from(error: BodyReadOffsetRefused) -> Self {
        Self::new(
            "The offset is no place in the body to read from.",
            RefusalCode::TranscriptBodyOffsetInvalid,
        )
        .with_detail(json!({ "offset": error.offset, "bodyLength": error.body_length }))
    }
}

/// A handler refuses a body offset that is no place to resume from with `?`.
impl From<BodyReadOffsetRefused> for HandlerError {
    fn from(error: BodyReadOffsetRefused) -> Self {
        Self::Refused(error.into())
    }
}

impl From<EventLogFollowError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`, a cursor it cannot read
    /// `session.event.cursorUnresolvable`, and a failed read is a fault in the daemon.
    fn from(error: EventLogFollowError) -> Self {
        match error {
            EventLogFollowError::SessionNotFound(session_id) => {
                session_not_found(&session_id).into()
            }
            EventLogFollowError::Read(EventLogReadError::CursorUnresolvable(unresolvable)) => {
                unresolvable.into()
            }
            EventLogFollowError::Read(
                fault @ (EventLogReadError::Read(_)
                | EventLogReadError::CursorOutOfRange(_)
                | EventLogReadError::Pool(_)),
            ) => Self::Internal(Box::new(fault)),
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use schemars::JsonSchema;
    use serde::Deserialize;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::jsonrpc::issue::{IssuePathSegment, ShapeFault};
    use sidekicks_contracts::jsonrpc::message::JsonRpcId;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::wire::attachment::{ReceivedError, parse_received};
    use sidekicks_contracts::wire::integer::BoundedInt;

    use super::{
        CallFailure, FIELDS_MAX_ARRAY_LEN, FIELDS_MAX_DEPTH, FIELDS_MAX_KEYS, FIELDS_MAX_NODES,
        FIELDS_VALUE_MAX_LEN, map_json_rpc_error,
    };
    use crate::domain_error::DomainError;
    use crate::registry::DispatchError;

    /// The received value the refusals below must never quote.
    const SECRET_DIGITS: &str = "7340251";

    #[derive(Debug, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Lookup {
        #[garde(skip)]
        #[expect(
            dead_code,
            reason = "the refused read is the subject; nothing reads it back"
        )]
        run_sequence: BoundedInt<0, 9>,
    }

    /// The whole response `failure` answers, as JSON.
    fn answer(failure: CallFailure) -> Value {
        let response = map_json_rpc_error(failure, JsonRpcId::Number(1.into()));
        let json = response.to_vec().expect("an error response writes");
        serde_json::from_slice(&json).expect("an error response is JSON")
    }

    fn refused(message: &str, detail: Option<Map<String, Value>>) -> Value {
        let refusal = DomainError::new(message, RefusalCode::SystemInternalError);
        let refusal = match detail {
            Some(detail) => refusal.with_detail(detail),
            None => refusal,
        };
        answer(CallFailure::Dispatch(DispatchError::Refused(refusal)))
    }

    // A domain refusal answers the one domain number, naming its code and category.
    #[test]
    fn a_domain_refusal_answers_minus_31000_with_its_code_and_category() {
        let refusal = DomainError::session_not_found(
            "session does not exist",
            json!({ "sessionId": "a-session" }),
        );
        let response = answer(CallFailure::Dispatch(DispatchError::Refused(refusal)));
        assert_eq!(response["error"]["code"], -31_000);
        assert_eq!(response["error"]["data"]["type"], "session.notFound");
        assert_eq!(response["error"]["data"]["category"], "notFound");
        assert_eq!(
            response["error"]["data"]["fields"]["sessionId"],
            "a-session"
        );
    }

    // serde's refusal of the sequence reads "7340251 is outside 0..=9".
    #[test]
    fn a_refused_value_is_never_quoted() {
        let refusal = parse_received::<Lookup>(br#"{"runSequence": 7340251}"#, Vec::new())
            .expect_err("the params are refused");
        let response = answer(CallFailure::Dispatch(DispatchError::ParamsInvalid(refusal)));
        assert_eq!(response["error"]["code"], -32_602);
        assert_eq!(response["error"]["data"]["type"], "request.paramsInvalid");
        assert_eq!(response["error"]["data"]["category"], "invalidArgument");
        let issues = response["error"]["data"]["fields"]["issues"]
            .as_array()
            .expect("the refusal lists its issues");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["path"], json!(["runSequence"]));
        assert!(!response.to_string().contains(SECRET_DIGITS), "{response}");
    }

    fn members(names: &[&str]) -> Vec<IssuePathSegment> {
        names
            .iter()
            .map(|name| IssuePathSegment::Member((*name).to_owned()))
            .collect()
    }

    // A path is cut to the ancestor within the caps, so it never carries a marker, a long name or
    // an absolute path.
    #[rstest]
    #[case::long_member_name(
        members(&["servers", &"x".repeat(FIELDS_VALUE_MAX_LEN + 1), "type"]),
        members(&["servers"])
    )]
    #[case::path_shaped_member_name(
        members(&["servers", "/Users/someone/.ssh/id", "type"]),
        members(&["servers"])
    )]
    fn an_issue_path_stops_at_an_ancestor_within_the_caps(
        #[case] faulted: Vec<IssuePathSegment>,
        #[case] sent: Vec<IssuePathSegment>,
    ) {
        let refusal = ReceivedError::Shape {
            faults: vec![ShapeFault {
                path: faulted,
                keyword: "type".to_owned(),
            }],
        };
        let response = answer(CallFailure::Dispatch(DispatchError::ParamsInvalid(refusal)));
        let issues = &response["error"]["data"]["fields"]["issues"];
        assert_eq!(issues[0]["path"], json!(sent), "{response}");
        let text = response.to_string();
        assert!(!text.contains("<truncated"), "{text}");
        assert!(!text.contains("/Users"), "{text}");
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
    #[case::wsl_dollar(r"cannot read \\wsl$\Ubuntu\home\me\x", "cannot read <redacted-path>")]
    #[case::verbatim_unc(
        r"cannot read \\?\UNC\wsl.localhost\Ubuntu\x",
        "cannot read <redacted-path>"
    )]
    #[case::verbatim_drive(r"cannot read \\?\C:\data\a.json", "cannot read <redacted-path>")]
    #[case::drive_with_spaces(
        r"cannot run C:\Program Files\tool.exe",
        "cannot run <redacted-path>"
    )]
    #[case::line_and_column("at /src/main.rs:12:7 (main)", "at <redacted-path> (main)")]
    // Killed by a folder name with a space ending the path, and by the last segment taking the
    // prose after it.
    #[case::folder_with_a_space(
        "cannot open /Users/a/My Project/x.rs now",
        "cannot open <redacted-path> now"
    )]
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

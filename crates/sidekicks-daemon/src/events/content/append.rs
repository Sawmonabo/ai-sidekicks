//! The content partition of an append: machine-authored prose kept in
//! `session_events.content_payload` beside the event, with the description members it adds to
//! `payload`, and the two checks both append branches run on the envelope about to be stored. The
//! log service writes the row; this module touches no database.

use std::fmt;

use jsonschema::error::ValidationErrorKind;
use serde::de::value::MapDeserializer;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{
    CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_PAYLOAD_PLAINTEXT_MAX, CONTENT_TRUNCATED_PAYLOAD_KEY,
};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::jsonrpc::issue::{IssuePathSegment, reader_issue_path, shape_faults};
use sidekicks_contracts::schema::{ReceivedCheckError, received_check};

use crate::issue_path::resolve_issue_path;

/// The `payload` members only this module may set; `contentType` is the producer's.
const CONTENT_DESCRIPTION_PAYLOAD_KEYS: [&str; 2] =
    [CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY];

/// The event types whose registered payload declares the content members, the only ones that may
/// carry a machine-authored content partition.
const BODY_BEARING_EVENT_TYPES: [SessionEventType; 6] = [
    SessionEventType::AssistantMessage,
    SessionEventType::AssistantThinkingUpdate,
    SessionEventType::ToolInvoked,
    SessionEventType::ToolResult,
    SessionEventType::ToolError,
    SessionEventType::ApprovalReviewerDenied,
];

/// A producer pre-seeded a content description member; it names the key only.
#[derive(Debug, thiserror::Error)]
#[error(
    "{refuser} refuses an event whose payload already carries {seeded_key}: the append path is \
     the only producer of {} and {}, each measured from the body it actually stores. Pass the \
     prose as the content body; contentType is the producer's member and is unaffected.",
    CONTENT_LENGTH_PAYLOAD_KEY,
    CONTENT_TRUNCATED_PAYLOAD_KEY
)]
pub(crate) struct ContentDescriptionSeededError {
    /// Who refused, as the append path names itself.
    pub(crate) refuser: &'static str,
    /// The member the payload already carried.
    pub(crate) seeded_key: &'static str,
}

/// Refuses a payload that pre-seeds a content description member, so a false length or truncation
/// claim cannot be stored on either append path.
pub(crate) fn assert_no_seeded_content_description(
    payload: &Map<String, Value>,
    refuser: &'static str,
) -> Result<(), ContentDescriptionSeededError> {
    match CONTENT_DESCRIPTION_PAYLOAD_KEYS
        .into_iter()
        .find(|key| payload.contains_key(*key))
    {
        Some(seeded_key) => Err(ContentDescriptionSeededError {
            refuser,
            seeded_key,
        }),
        None => Ok(()),
    }
}

/// A content partition on an event type whose registered payload declares no content members,
/// which would be stored carrying members its own schema rejects.
#[derive(Debug, thiserror::Error)]
#[error(
    "refuses a content partition on event type {event_type}: machine-authored prose is kept only \
     for {}, the types whose registered payload declares the content members",
    body_bearing_type_names()
)]
pub(crate) struct ContentPartitionRefusedError {
    /// The envelope's type.
    pub(crate) event_type: String,
}

fn body_bearing_type_names() -> String {
    BODY_BEARING_EVENT_TYPES
        .map(SessionEventType::as_str)
        .join(", ")
}

/// One content-bearing row as stored: the envelope with its description members, and the body.
#[derive(Clone, Debug)]
pub(crate) struct ComposedContentRow {
    /// The envelope, its payload carrying `contentLength` and, when cut, `contentTruncated`.
    pub(crate) envelope: EventEnvelope,
    /// The text `content_payload` holds: the body, or its prefix when the bound fired.
    pub(crate) stored_body: String,
}

/// Composes the stored form of an event that carries machine-authored prose. A body over
/// `CONTENT_PAYLOAD_PLAINTEXT_MAX` UTF-8 bytes is cut at a character boundary, not refused, since
/// refusing would drop the turn. Fails on a type that declares no content members.
pub(crate) fn compose_content_row(
    mut envelope: EventEnvelope,
    body: &str,
) -> Result<ComposedContentRow, ContentPartitionRefusedError> {
    let is_body_bearing = SessionEventType::from_wire_name(envelope.event_type.as_str())
        .is_some_and(|event_type| BODY_BEARING_EVENT_TYPES.contains(&event_type));
    if !is_body_bearing {
        return Err(ContentPartitionRefusedError {
            event_type: envelope.event_type.as_str().to_owned(),
        });
    }
    // The length reported is the whole body's, so a cut row still says how much was dropped.
    let stored_body = &body[..body.floor_char_boundary(CONTENT_PAYLOAD_PLAINTEXT_MAX)];
    envelope.payload.insert(
        CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
        Value::from(body.len()),
    );
    if stored_body.len() < body.len() {
        envelope
            .payload
            .insert(CONTENT_TRUNCATED_PAYLOAD_KEY.to_owned(), Value::Bool(true));
    }
    Ok(ComposedContentRow {
        envelope,
        stored_body: stored_body.to_owned(),
    })
}

/// Whether the envelope parses as its registered variant. A type this build registers no payload
/// variant for is kept as a stub and counts as parsing.
pub(crate) fn parses_as_registered_variant(envelope: &EventEnvelope) -> bool {
    match SessionEvent::from_envelope(envelope) {
        Ok(_)
        | Err(SessionEventReadError::UnknownType(_) | SessionEventReadError::NoPayloadVariant(_)) => {
            true
        }
        Err(
            SessionEventReadError::CategoryMismatch { .. }
            | SessionEventReadError::Payload(_)
            | SessionEventReadError::Check(_),
        ) => false,
    }
}

/// One member the registered variant refuses: where it sits from the event down, in the wire's
/// names, and the kind of fault, never its value, since a payload can hold a person's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VariantIssue {
    /// The member's path, empty for the event itself.
    pub(crate) path: Vec<IssuePathSegment>,
    /// The fault's kind: the schema keyword the member breaks, `check` for a rule of its type, or
    /// `shape` for a value its type's own reader refuses.
    pub(crate) kind: String,
}

/// Why an envelope about to be stored was refused by the registered-variant check.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RegisteredVariantRefusal {
    /// Its registered variant rejects it.
    #[error(
        "{refuser} refuses to store an event of type {event_type} that its own registered \
         variant rejects: {}. Storing it would write a row that fails the strict read on the \
         way back out, unreadable as anything but a stub.",
        RenderedIssues(.issues)
    )]
    Rejected {
        /// Who refused, as the append path names itself.
        refuser: &'static str,
        /// The envelope's type, a registered one.
        event_type: String,
        /// Every member the variant refuses that the check could name, at least one.
        issues: Vec<VariantIssue>,
    },
    /// The shape check of the session event could not be built, so the refused members could not
    /// be named.
    #[error("the shape check that names a refused event's members could not be built")]
    ShapeCheck(#[source] ReceivedCheckError),
}

/// Refuses an envelope about to be stored unless it parses as its registered variant. It is the
/// last check on both append branches; a type with no registered variant passes, since a reader
/// must keep an unknown type as a version stub, never reject it.
pub(crate) fn assert_registered_variant_parses(
    envelope: &EventEnvelope,
    refuser: &'static str,
) -> Result<(), RegisteredVariantRefusal> {
    let issues = match SessionEvent::from_envelope(envelope) {
        Ok(_)
        | Err(SessionEventReadError::UnknownType(_) | SessionEventReadError::NoPayloadVariant(_)) =>
        {
            return Ok(());
        }
        Err(SessionEventReadError::CategoryMismatch { .. }) => vec![VariantIssue {
            path: vec![member("category")],
            kind: "const".to_owned(),
        }],
        // garde's messages can quote the value, so only its paths are kept. garde roots the
        // payload at the variant's one field, which serde writes as `payload` itself.
        Err(SessionEventReadError::Check(report)) => {
            let payload = Value::Object(envelope.payload.clone());
            report
                .iter()
                .map(|(check_path, _)| VariantIssue {
                    path: [member("payload")]
                        .into_iter()
                        .chain(resolve_issue_path(check_path, &payload))
                        .collect(),
                    kind: "check".to_owned(),
                })
                .collect()
        }
        // serde's error quotes the value and names only its first fault, so the members are read
        // from the shape check instead.
        Err(SessionEventReadError::Payload(_)) => {
            shape_issues(envelope).map_err(RegisteredVariantRefusal::ShapeCheck)?
        }
    };
    Err(RegisteredVariantRefusal::Rejected {
        refuser,
        event_type: envelope.event_type.as_str().to_owned(),
        issues,
    })
}

/// The members the session event's shape check refuses in the arm `envelope`'s type selects, each
/// by its path and keyword. Where the shape holds every member but the type's own reader still
/// refuses one (a scalar's bound, which the shape leaves to the reader), the reader's first fault
/// is named instead, by its path.
fn shape_issues(envelope: &EventEnvelope) -> Result<Vec<VariantIssue>, ReceivedCheckError> {
    let event_type = Value::String(envelope.event_type.as_str().to_owned());
    let payload = Value::Object(envelope.payload.clone());
    let instance = Value::Object(
        [
            ("type".to_owned(), event_type.clone()),
            ("payload".to_owned(), payload.clone()),
        ]
        .into_iter()
        .collect(),
    );
    let check = received_check::<SessionEvent>()?;
    let mut issues = Vec::new();
    for error in check.iter_errors(&instance) {
        // The root's arms, one error list each; the root's other keywords only repeat that no arm
        // read the event.
        let ValidationErrorKind::AnyOf { context } = error.kind() else {
            continue;
        };
        // Every arm but the one the type selects refuses `/type`.
        let selected_arm = context.iter().find(|arm_errors| {
            arm_errors
                .iter()
                .all(|arm_error| arm_error.instance_path().as_str() != "/type")
        });
        for arm_error in selected_arm.into_iter().flatten() {
            issues.extend(shape_faults(arm_error, &instance).into_iter().map(|fault| {
                VariantIssue {
                    path: fault.path,
                    kind: fault.keyword,
                }
            }));
        }
    }
    if !issues.is_empty() {
        return Ok(issues);
    }
    // `type` is read first so the payload is read as its variant's, with its path tracked.
    let fields = MapDeserializer::<_, serde_json::Error>::new(
        [("type", event_type), ("payload", payload)].into_iter(),
    );
    let path = serde_path_to_error::deserialize::<_, SessionEvent>(fields)
        .err()
        .map_or_else(
            || vec![member("payload")],
            |fault| reader_issue_path(fault.path()),
        );
    Ok(vec![VariantIssue {
        path,
        kind: "shape".to_owned(),
    }])
}

fn member(name: &str) -> IssuePathSegment {
    IssuePathSegment::Member(name.to_owned())
}

// At most this many issues are named; the rest are counted.
const VARIANT_ISSUES_RENDERED_MAX: usize = 5;

/// Paths and kinds, never values.
struct RenderedIssues<'issues>(&'issues [VariantIssue]);

impl fmt::Display for RenderedIssues<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, issue) in self.0.iter().take(VARIANT_ISSUES_RENDERED_MAX).enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            if issue.path.is_empty() {
                formatter.write_str("<envelope>")?;
            }
            for (step_index, step) in issue.path.iter().enumerate() {
                if step_index > 0 {
                    formatter.write_str(".")?;
                }
                match step {
                    IssuePathSegment::Member(name) => formatter.write_str(name)?,
                    IssuePathSegment::Index(position) => write!(formatter, "{}", position.get())?,
                }
            }
            write!(formatter, " ({})", issue.kind)?;
        }
        let elided_count = self.0.len().saturating_sub(VARIANT_ISSUES_RENDERED_MAX);
        if elided_count > 0 {
            write!(formatter, "; and {elided_count} further issue(s)")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::event::envelope::EventEnvelope;
    use sidekicks_contracts::jsonrpc::issue::IssuePathSegment;

    use super::{RegisteredVariantRefusal, VariantIssue, assert_registered_variant_parses};

    // Text a person wrote, which no refusal may repeat.
    const PRIVATE_WORDS: &str = "my locker code is 4921";

    fn tool_invoked(category: &str, extra_members: &Value) -> EventEnvelope {
        let mut payload = json!({
            "sessionId": "0192f3a4-5b6c-7d8e-9f01-234567890abc",
            "runId": "0192f3a4-5b6c-7d8e-9f01-234567890abd",
            "toolName": "Read",
        });
        let members = payload.as_object_mut().expect("the payload is an object");
        members.extend(
            extra_members
                .as_object()
                .expect("the extra members are an object")
                .clone(),
        );
        serde_json::from_value(json!({
            "id": "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",
            "sessionId": "0192f3a4-5b6c-7d8e-9f01-234567890abc",
            "sequence": 1,
            "occurredAt": "2026-03-04T05:06:07.008Z",
            "category": category,
            "type": "tool.invoked",
            "payload": payload,
            "version": "1.0",
        }))
        .expect("the envelope reads")
    }

    #[rstest]
    #[case::category_mismatch(
        "run_lifecycle",
        json!({ "toolName": PRIVATE_WORDS }),
        &[(&["category"][..], "const")]
    )]
    #[case::wrong_typed_member(
        "tool_activity",
        json!({ "toolName": 4921 }),
        &[(&["payload", "toolName"][..], "type")]
    )]
    #[case::unknown_member(
        "tool_activity",
        json!({ "privateNote": PRIVATE_WORDS }),
        &[(&["payload", "privateNote"][..], "additionalProperties")]
    )]
    #[case::rule_of_its_type(
        "tool_activity",
        json!({ "sourceEpoch": 4921 }),
        &[(&["payload", "sourceEpoch"][..], "check")]
    )]
    fn a_refused_event_names_each_member_in_wire_names_never_its_value(
        #[case] category: &str,
        #[case] extra_members: Value,
        #[case] expected: &[(&[&str], &str)],
    ) {
        let refusal =
            assert_registered_variant_parses(&tool_invoked(category, &extra_members), "test")
                .expect_err("the variant refuses the event");
        let message = refusal.to_string();
        let RegisteredVariantRefusal::Rejected { issues, .. } = refusal else {
            panic!("the shape check builds: {message}");
        };
        let expected: Vec<VariantIssue> = expected
            .iter()
            .map(|(path, kind)| VariantIssue {
                path: path
                    .iter()
                    .map(|name| IssuePathSegment::Member((*name).to_owned()))
                    .collect(),
                kind: (*kind).to_owned(),
            })
            .collect();
        assert!(!message.contains("4921"), "{message}");
        assert_eq!(issues, expected, "{message}");
    }
}

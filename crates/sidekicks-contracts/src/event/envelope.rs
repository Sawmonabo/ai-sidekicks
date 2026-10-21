//! The session event envelope: the closed categories, the tolerant envelope every event is stored
//! and sent in, the execution-epoch stamp a late row carries in its payload, and the hydrated
//! reader shape that pairs a stored event with its body.
//!
//! The envelope is the version-tolerant layer: a newer producer's unknown `type` is kept as a
//! version stub and every payload member is kept verbatim, while the category set and the
//! envelope's own members stay closed. The strict session event is parsed from an envelope's
//! `type` and `payload` when it is read.

use std::borrow::Cow;
use std::sync::LazyLock;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::IntoDeserializer;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::event::registry::SessionEventType;
use crate::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::{calendar_date_pattern, stored_instant_text};
use crate::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use crate::wire::text::FreeFormText;
use crate::wire::{NullableSchema, named_scalar};

/// The category a session event belongs to; every event type maps to exactly one, so a mismatched
/// pair fails the strict parse. Adding a category is a minor version bump.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EventCategory {
    /// A run's life: queued, started, paused, rolled back, ended.
    RunLifecycle,
    /// What the agent said or thought.
    AgentOutput,
    /// A tool call's start, result or failure.
    ToolActivity,
    /// A message, an ask or a question waiting on a person or the queue.
    InteractiveRequest,
    /// An artifact published.
    ArtifactPublication,
    /// The session's own life, its workspaces and its worktrees.
    SessionLifecycle,
    /// An approval asked for and answered.
    ApprovalFlow,
    /// Usage, limits and model moves.
    UsageTelemetry,
    /// What the daemon recovered after a restart.
    RecoveryEvents,
    /// A refusal or check that guards the machine.
    SecurityEvents,
    /// Upkeep of the event log itself, such as a deletion's receipt.
    EventMaintenance,
    /// Admission of orchestrated work.
    OrchestrationAdmission,
    /// MCP server sign-ins, bindings and their changes.
    McpGovernance,
    /// A workflow run's life.
    WorkflowLifecycle,
    /// A workflow step's life.
    WorkflowPhaseLifecycle,
    /// A workflow's parallel branches coming together.
    WorkflowParallelCoordination,
    /// A workflow gate's resolution.
    WorkflowGateResolution,
}

impl EventCategory {
    /// The category `name` names, read as its serde form reads it, or `None` for a name that is no
    /// category.
    pub fn from_wire_name(name: &str) -> Option<Self> {
        Self::deserialize(IntoDeserializer::<serde::de::value::Error>::into_deserializer(name)).ok()
    }

    /// The category's wire text, as its serde form writes it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RunLifecycle => "runLifecycle",
            Self::AgentOutput => "agentOutput",
            Self::ToolActivity => "toolActivity",
            Self::InteractiveRequest => "interactiveRequest",
            Self::ArtifactPublication => "artifactPublication",
            Self::SessionLifecycle => "sessionLifecycle",
            Self::ApprovalFlow => "approvalFlow",
            Self::UsageTelemetry => "usageTelemetry",
            Self::RecoveryEvents => "recoveryEvents",
            Self::SecurityEvents => "securityEvents",
            Self::EventMaintenance => "eventMaintenance",
            Self::OrchestrationAdmission => "orchestrationAdmission",
            Self::McpGovernance => "mcpGovernance",
            Self::WorkflowLifecycle => "workflowLifecycle",
            Self::WorkflowPhaseLifecycle => "workflowPhaseLifecycle",
            Self::WorkflowParallelCoordination => "workflowParallelCoordination",
            Self::WorkflowGateResolution => "workflowGateResolution",
        }
    }
}

ts_constants! {
    /// The largest `sequence` an envelope may carry, not a tunable: `sequence` travels as an
    /// IEEE-754 double, which holds integers exactly only up to 2^53 − 1, so above it two events
    /// would share an order key.
    pub const EVENT_ENVELOPE_SEQUENCE_MAX: u64 = MAX_SAFE_INTEGER;
    /// Payload key of the epoch stamp; ingestion writes it and the supersede projection reads it.
    pub const SOURCE_EPOCH_PAYLOAD_KEY: &str = "sourceEpoch";
    /// Payload key of the position stamp; it moves with the epoch stamp's key.
    pub const SOURCE_POSITION_PAYLOAD_KEY: &str = "sourcePosition";
}

/// The `sessionId` that rows describing the machine rather than a conversation bind to: the RFC
/// 9562 Max UUID, which no versioned session id can equal. Built through the session id's own
/// check, so a check that stops admitting it fails at first use rather than on the wire.
pub static DAEMON_SCOPE_SENTINEL_SESSION_ID: LazyLock<SessionId> = LazyLock::new(|| {
    SessionId::new("ffffffff-ffff-ffff-ffff-ffffffffffff").expect("the Max UUID is a session id")
});

named_scalar! {
    /// An event's type as the envelope stores it: free-form text rather than a known type, so a
    /// reader can store and pass on a type a newer producer wrote.
    EventEnvelopeType(FreeFormText<EVENT_FIELD_MAX_LEN>)
}

impl EventEnvelopeType {
    /// The type's text.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl From<SessionEventType> for EventEnvelopeType {
    fn from(event_type: SessionEventType) -> Self {
        Self(
            FreeFormText::new(event_type.as_str().to_owned())
                .expect("an event type's name is free-form text"),
        )
    }
}

/// The schema's form of an `occurredAt`: a real calendar date, an uppercase `T`, a time whose
/// seconds may be left out and whose fraction holds no non-zero digit past the third, then `Z` or
/// an offset up to `23:59`.
const OCCURRED_AT_PATTERN: &str = concat!(
    "^",
    calendar_date_pattern!(),
    "T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,3}0*)?)?\
     (?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
);

/// Why an `occurredAt` was refused. The checks run in the variants' order and the first that fails
/// is the one reported, so a sub-millisecond digit is named before a calendar fault.
#[derive(Clone, Debug, thiserror::Error)]
pub enum OccurredAtRefusal {
    /// Not an RFC 3339 date and time with an uppercase `T`, its hour, minute and second in range,
    /// and `Z` or a `±HH:MM` offset up to `23:59`.
    #[error(
        "an occurredAt is an RFC 3339 date and time with an uppercase `T` and `Z` or a `±HH:MM` \
         offset"
    )]
    Shape,
    /// A non-zero fraction digit past the millisecond, which the stored form cannot keep;
    /// refused, never cut, since a cut would store a different instant.
    #[error("an occurredAt holds a non-zero fraction digit past the millisecond")]
    SubMillisecond,
    /// A date the calendar does not have (February 30, month 13).
    #[error("an occurredAt names a date the calendar does not have")]
    NotACalendarDate,
    /// Folded to UTC, an instant outside the range it can be stored in.
    #[error("an occurredAt folds to UTC outside the range it can be stored in")]
    OutOfRange,
}

/// Reads an `occurredAt` component by component, the instant it names in UTC to the millisecond.
/// Refuses with the first [`OccurredAtRefusal`] that applies: every shape check, ranges included,
/// runs before the sub-millisecond check, which runs before the calendar check.
pub fn parse_occurred_at(text: &str) -> Result<jiff::Timestamp, OccurredAtRefusal> {
    let parts = OccurredAtParts::read(text).ok_or(OccurredAtRefusal::Shape)?;
    // Trailing zeros fold away; any other digit past the millisecond would be lost.
    if parts.fraction.iter().skip(3).any(|digit| *digit != b'0') {
        return Err(OccurredAtRefusal::SubMillisecond);
    }
    let millisecond = parts
        .fraction
        .iter()
        .chain(std::iter::repeat(&b'0'))
        .take(3)
        .fold(0, |value, digit| value * 10 + i32::from(digit - b'0'));
    // jiff's error names the received part and its value, so it is not kept as the cause.
    let date = jiff::civil::Date::new(parts.year, parts.month, parts.day)
        .ok()
        .ok_or(OccurredAtRefusal::NotACalendarDate)?;
    let time = jiff::civil::Time::new(
        parts.hour,
        parts.minute,
        parts.second,
        millisecond * 1_000_000,
    )
    .expect("the hour, minute and second are checked in range");
    jiff::tz::Offset::from_seconds(parts.offset_seconds)
        .expect("an offset up to 23:59 is in range")
        .to_timestamp(date.to_datetime(time))
        .ok()
        .ok_or(OccurredAtRefusal::OutOfRange)
}

/// An `occurredAt`'s lexical parts, every range but the calendar's checked.
struct OccurredAtParts<'text> {
    year: i16,
    month: i8,
    day: i8,
    hour: i8,
    minute: i8,
    second: i8,
    /// The fraction's digits, unchecked past the third.
    fraction: &'text [u8],
    offset_seconds: i32,
}

impl<'text> OccurredAtParts<'text> {
    /// The parts of `text`, or `None` where its shape or a time or offset range is wrong.
    fn read(text: &'text str) -> Option<Self> {
        let mut rest = text.as_bytes();
        let year = take_digits(&mut rest, 4)?;
        take_byte(&mut rest, b'-')?;
        let month = take_digits(&mut rest, 2)?;
        take_byte(&mut rest, b'-')?;
        let day = take_digits(&mut rest, 2)?;
        take_byte(&mut rest, b'T')?;
        let hour = take_digits(&mut rest, 2)?;
        take_byte(&mut rest, b':')?;
        let minute = take_digits(&mut rest, 2)?;
        let mut second = 0;
        let mut fraction: &[u8] = &[];
        if take_byte(&mut rest, b':').is_some() {
            second = take_digits(&mut rest, 2)?;
            if take_byte(&mut rest, b'.').is_some() {
                let digit_count = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
                if digit_count == 0 {
                    return None;
                }
                (fraction, rest) = rest.split_at(digit_count);
            }
        }
        let offset_seconds = match rest {
            [b'Z'] => 0,
            [sign @ (b'+' | b'-'), offset @ ..] => {
                let mut offset = offset;
                let offset_hour = take_digits(&mut offset, 2)?;
                take_byte(&mut offset, b':')?;
                let offset_minute = take_digits(&mut offset, 2)?;
                if !offset.is_empty() || offset_hour > 23 || offset_minute > 59 {
                    return None;
                }
                let seconds = i32::from(offset_hour) * 3600 + i32::from(offset_minute) * 60;
                if *sign == b'-' { -seconds } else { seconds }
            }
            _ => return None,
        };
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        Some(Self {
            year: i16::try_from(year).ok()?,
            month: i8::try_from(month).ok()?,
            day: i8::try_from(day).ok()?,
            hour: i8::try_from(hour).ok()?,
            minute: i8::try_from(minute).ok()?,
            second: i8::try_from(second).ok()?,
            fraction,
            offset_seconds,
        })
    }
}

/// Takes `count` ASCII digits off the front of `rest` as their number.
fn take_digits(rest: &mut &[u8], count: usize) -> Option<u16> {
    let (digits, after) = rest.split_at_checked(count)?;
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *rest = after;
    Some(
        digits
            .iter()
            .fold(0, |value, digit| value * 10 + u16::from(digit - b'0')),
    )
}

/// Takes `expected` off the front of `rest`, or leaves `rest` and answers `None`.
fn take_byte(rest: &mut &[u8], expected: u8) -> Option<()> {
    let (first, after) = rest.split_first()?;
    if *first != expected {
        return None;
    }
    *rest = after;
    Some(())
}

/// Refuses an `occurredAt` [`parse_occurred_at`] does not read.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn is_occurred_at(text: &str, (): &()) -> garde::Result {
    parse_occurred_at(text)
        .map(|_| ())
        .map_err(|refusal| garde::Error::new(refusal.to_string()))
}

/// When an incoming event occurred, as a peer sent it: its seconds may be left out, and its
/// fraction holds no non-zero digit past the third, since the append path stores it in UTC to the
/// millisecond.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct EventOccurredAt(#[garde(custom(is_occurred_at))] String);

impl EventOccurredAt {
    /// `text` as an `occurredAt`, held to the rule its garde check holds. Refuses with the first
    /// [`OccurredAtRefusal`] that applies.
    pub fn new(text: String) -> Result<Self, OccurredAtRefusal> {
        parse_occurred_at(&text)?;
        Ok(Self(text))
    }

    /// The text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The instant, for the append path to store in UTC to the millisecond; `None` where the
    /// text breaks the rule its garde check holds.
    pub fn timestamp(&self) -> Option<jiff::Timestamp> {
        parse_occurred_at(&self.0).ok()
    }

    /// `timestamp` in the stored form, UTC to the millisecond (`YYYY-MM-DDTHH:MM:SS.sssZ`), a
    /// sub-millisecond part cut; `None` before the year 0000, which the stored form cannot write.
    pub fn from_timestamp(timestamp: jiff::Timestamp) -> Option<Self> {
        stored_instant_text(timestamp).map(Self)
    }

    /// The system clock's instant in the stored form. It is left out of WebAssembly builds, since
    /// jiff reads the clock through std, which panics on `wasm32-unknown-unknown`.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn now() -> Self {
        Self::from_timestamp(jiff::Timestamp::now()).expect("the clock reads after year 0000")
    }
}

impl JsonSchema for EventOccurredAt {
    fn schema_name() -> Cow<'static, str> {
        "EventOccurredAt".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "When an incoming event occurred: a real date and time with `Z` or an \
                            offset, its seconds optional, its fraction holding no non-zero digit \
                            past the third.",
            "type": "string",
            "pattern": OCCURRED_AT_PATTERN,
        })
    }
}

/// The message every session event is stored and travels in. Its own members are closed; its
/// `type` and `payload` are kept as written, so an event from a newer producer survives a read
/// and a write unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct EventEnvelope {
    /// The event's id, opaque on the wire; the daemon assigns a UUID v7.
    pub id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The session the event belongs to.
    pub session_id: SessionId,
    /// Daemon-assigned and strictly increasing per session: the order key.
    pub sequence: SafeInt<0>,
    /// When the event occurred; the append path stores it in UTC with millisecond precision.
    #[garde(dive)]
    pub occurred_at: EventOccurredAt,
    /// The event's category.
    pub category: EventCategory,
    /// The event's type, kept as written.
    #[serde(rename = "type")]
    pub event_type: EventEnvelopeType,
    /// A person's or an agent's id; `null` or absent for a system event, never empty.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "NullableSchema<FreeFormText<EVENT_FIELD_MAX_LEN>>")]
    pub actor: Option<Option<FreeFormText<EVENT_FIELD_MAX_LEN>>>,
    /// The category's own members, every one kept as written but `__proto__`, which a JavaScript
    /// reader cannot keep; may carry the epoch stamp.
    #[serde(deserialize_with = "crate::wire::record::prototype_free")]
    #[schemars(extend("propertyNames" = crate::wire::record::prototype_free_names()))]
    pub payload: Map<String, Value>,
    /// The id that ties this event to others of one operation.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The id of what caused this event.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub causation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The producer's version, written at emit time and never rewritten on read, so it is part of
    /// the row's durable identity.
    pub version: EventEnvelopeVersion,
}

// The epoch stamp: `sourceEpoch` and `sourcePosition`, carried in the payload by a row a provider
// delivery produces outside its run's lifecycle and appended late for a superseded execution
// epoch (after a rollback). A current-epoch row carries neither, so the stamp is never made up.
// Only a payload naming its run takes it; every stamped payload holds both members and checks
// them with `check_epoch_stamp`, its schema stating `epoch_stamp_dependent_required()`.

named_scalar! {
    /// The execution epoch a late-appended row is attributed to: `0` before any rollback, advanced
    /// by each accepted `agent.run.rolledBack`.
    SourceEpoch(SafeInt<0>), Copy
}

named_scalar! {
    /// The turn position a stamped row occupies within its source epoch, so the supersede cutoff
    /// (`turn > targetPosition`) can rank a late row against its epoch's surviving rows.
    SourcePosition(SafeInt<0>), Copy
}

/// The epoch stamp's rule: `sourceEpoch` and `sourcePosition` come together, and only on a payload
/// that names its run (`names_run`), because epochs and positions are run-local.
pub fn check_epoch_stamp(
    source_epoch: Option<SourceEpoch>,
    source_position: Option<SourcePosition>,
    names_run: bool,
) -> garde::Result {
    match (source_epoch, source_position) {
        (Some(_), None) => Err(garde::Error::new(
            "a sourceEpoch stamp requires sourcePosition: the supersede cutoff cannot rank the row \
             against its epoch's surviving rows without a position",
        )),
        (None, Some(_)) => Err(garde::Error::new(
            "a sourcePosition stamp requires sourceEpoch: a position without its epoch names no \
             epoch to supersede against",
        )),
        (Some(_), Some(_)) if !names_run => Err(garde::Error::new(
            "an epoch stamp requires a present, non-null runId: epochs and positions are \
             run-local",
        )),
        (None, None) | (Some(_), Some(_)) => Ok(()),
    }
}

/// The schema twin of [`check_epoch_stamp`], for a stamped payload's `dependentRequired`: either
/// stamp member requires the other and `runId`.
pub fn epoch_stamp_dependent_required() -> Value {
    json!({
        SOURCE_EPOCH_PAYLOAD_KEY: [SOURCE_POSITION_PAYLOAD_KEY, "runId"],
        SOURCE_POSITION_PAYLOAD_KEY: [SOURCE_EPOCH_PAYLOAD_KEY, "runId"],
    })
}

/// Why a stored event's body is not available.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HydratedContentUnavailableReason {
    /// The row never carried one.
    Absent,
}

/// A stored event's body as a reader receives it beside the event, never merged into its payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HydratedSessionEventContent {
    /// The body was stored.
    Available {
        /// The opened body, whole.
        body: String,
        /// The whole body's UTF-8 byte length, echoed from the stored payload, never recomputed
        /// from `body`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        content_length: Option<SafeInt<0>>,
    },
    /// No body can be read.
    Unavailable {
        /// Why.
        reason: HydratedContentUnavailableReason,
    },
}

/// A stored event paired with its machine-authored body. `event` is the tolerant envelope, byte
/// for byte the stored row, so a reader need not parse it again to ask whether it has a body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct HydratedSessionEvent {
    /// The stored event.
    #[garde(dive)]
    pub event: EventEnvelope,
    /// Its body.
    pub content: HydratedSessionEventContent,
}

/// The TypeScript module of the event envelope.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/envelope",
    doc: "The session event envelope: the closed categories, the tolerant envelope every event is \
          stored and sent in, the execution-epoch stamp and the hydrated (envelope plus body) \
          reader shape.",
    definitions: &[
        Definition::read::<EventCategory>().checked(),
        Definition::read::<EventEnvelopeType>(),
        Definition::read::<EventOccurredAt>(),
        Definition::read::<EventEnvelope>().checked(),
        Definition::read::<SourceEpoch>(),
        Definition::read::<SourcePosition>(),
        Definition::read::<HydratedContentUnavailableReason>(),
        Definition::read::<HydratedSessionEventContent>(),
        Definition::read::<HydratedSessionEvent>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use garde::Validate as _;
    use regex::Regex;
    use rstest::rstest;

    use super::{EventOccurredAt, OCCURRED_AT_PATTERN};

    #[rstest]
    #[case::three_zero_digits("2026-10-13T12:34:56.000Z", Some("2026-10-13T12:34:56Z"))]
    #[case::one_digit("2026-10-13T12:34:56.5Z", Some("2026-10-13T12:34:56.5Z"))]
    #[case::trailing_zeros("2026-10-13T12:34:56.5000Z", Some("2026-10-13T12:34:56.5Z"))]
    #[case::an_offset("2026-10-13T14:34:56+02:00", Some("2026-10-13T12:34:56Z"))]
    #[case::negative_zero_offset("2026-10-13T12:34:56-00:00", Some("2026-10-13T12:34:56Z"))]
    #[case::omitted_seconds("2026-10-13T12:34Z", Some("2026-10-13T12:34:00Z"))]
    #[case::a_digit_past_the_millisecond("2026-10-13T12:34:56.0001Z", None)]
    #[case::a_lowercase_t("2026-10-13t12:34:56Z", None)]
    #[case::a_leap_second("2016-12-31T23:59:60Z", None)]
    fn an_occurred_at_is_read_component_by_component(
        #[case] text: &str,
        #[case] instant: Option<&str>,
    ) {
        let occurred_at: EventOccurredAt =
            serde_json::from_value(text.into()).expect("any text deserializes");
        let expected = instant.map(|instant| {
            instant
                .parse::<jiff::Timestamp>()
                .expect("the expected instant parses")
        });
        assert_eq!(occurred_at.validate().is_ok(), expected.is_some(), "{text}");
        assert_eq!(occurred_at.timestamp(), expected, "{text}");
        let pattern = Regex::new(OCCURRED_AT_PATTERN).expect("the pattern compiles");
        assert_eq!(
            pattern.is_match(text),
            expected.is_some(),
            "the schema agrees on {text}"
        );
    }
}

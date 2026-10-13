//! The session event envelope: the closed categories, the tolerant envelope every event is stored
//! and sent in, the execution-epoch stamp a late row carries in its payload, and the hydrated
//! reader shape that pairs a stored event with its body.
//!
//! The envelope is the version-tolerant layer: a newer producer's unknown `type` is kept as a
//! version stub and every payload member is kept verbatim, while the category set and the
//! envelope's own members stay closed. The strict session event is parsed from an envelope's
//! `type` and `payload` when it is read.

use std::sync::LazyLock;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use crate::wire::text::FreeFormText;
use crate::wire::{NullableSchema, True, named_scalar};

/// The category a session event belongs to; every event type maps to exactly one, so a mismatched
/// pair fails the strict parse. Adding a category is a minor version bump.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventCategory {
    /// A run's life: queued, started, paused, rolled back, ended.
    RunLifecycle,
    /// What the assistant said or thought.
    AssistantOutput,
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
    SessionId::new("ffffffff-ffff-ffff-ffff-ffffffffffff".to_owned())
        .expect("the Max UUID is a session id")
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

/// The one payload member name the envelope refuses, since a JavaScript record parser drops it
/// and the parsed value would no longer match the stored canonical bytes.
const PROTOTYPE_KEY: &str = "__proto__";

/// Refuses a payload holding the member `__proto__`.
fn holds_no_prototype_member(payload: &Map<String, Value>, (): &()) -> garde::Result {
    if payload.contains_key(PROTOTYPE_KEY) {
        Err(garde::Error::new(
            "an event payload never holds the member __proto__, which a JavaScript reader \
             cannot keep",
        ))
    } else {
        Ok(())
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
    pub occurred_at: WireInstant,
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
    /// The category's own members, every one kept as written; may carry the epoch stamp.
    #[garde(custom(holds_no_prototype_member))]
    #[schemars(extend("propertyNames" = { "not": { "const": PROTOTYPE_KEY } }))]
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
    /// by each accepted `run.rolled_back`.
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
        (None, None) => Ok(()),
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
        (Some(_), Some(_)) => Ok(()),
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
#[serde(rename_all = "snake_case")]
pub enum HydratedContentUnavailableReason {
    /// The row never carried one.
    Absent,
}

/// A stored event's body as a reader receives it beside the event, never merged into its payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HydratedSessionEventContent {
    /// The body was stored.
    Available {
        /// The opened body; a prefix when `contentTruncated` is `true`.
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
        /// Present when the stored body is a prefix of a longer one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "True")]
        content_truncated: Option<True>,
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

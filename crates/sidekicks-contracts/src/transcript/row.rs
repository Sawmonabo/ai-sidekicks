//! The transcript row every transcript read returns, discriminated on the closed `kind` (`run`,
//! `rollback_boundary`, `general`). `type` is free-form so a row projected from a newer producer's
//! event still parses; consumers narrow on `kind`, never on it. [`TranscriptRunStamp`] is the run
//! arm's attribution alone, for an event delivered without its row.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::event::envelope::{
    EventCategory, SOURCE_EPOCH_PAYLOAD_KEY, SOURCE_POSITION_PAYLOAD_KEY,
};
use crate::event::registry::{
    INTERACTIVE_REQUEST_EVENT_TYPES, RUN_LIFECYCLE_EVENT_TYPES, TOOL_ACTIVITY_EVENT_TYPES,
};
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::run::control::RunRolledBackEvent;
use crate::run::id::RunId;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::transcript::child_run_summary::ChildRunSummary;
use crate::transcript::content::TranscriptRowContent;
use crate::transcript::run_attribution::{
    TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS, transcript_run_id_of,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The event type the `rollback_boundary` arm pins.
    pub const TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE: &str = "run.rolled_back";
    /// The category every `run_lifecycle` event belongs to, and the one the boundary arm pins.
    /// Every type in it is run-scoped, which is why the `general` arm refuses the category.
    pub const TRANSCRIPT_RUN_LIFECYCLE_CATEGORY: EventCategory = EventCategory::RunLifecycle;
}

/// The `interactive_request` types whose payload does not always name a run: queue events, a
/// person's message (accepted before any run exists) and a question a workflow step asks. The
/// rest of the category is run-scoped, so a newly added type defaults to run-scoped.
const INTERACTIVE_REQUEST_TYPES_WITHOUT_REQUIRED_RUN: [&str; 7] = [
    "queue_item.created",
    "queue_item.admitted",
    "queue_item.superseded",
    "queue_item.canceled",
    "queue_item.not_delivered",
    "user.message",
    "question.asked",
];

/// The `usage_telemetry` types whose payload requires `runId`, listed positively because the
/// category's shared shape leaves it optional: a session-scoped budget warning is a real row.
const USAGE_TELEMETRY_TYPES_WITH_REQUIRED_RUN: [&str; 2] =
    ["usage.context_compacted", "usage.model_rerouted"];

/// The `approval_flow` types whose payload requires `runId`: an ask, its answer and its end belong
/// to the run that raised it. `approval.rule_revoked` is decided per row by its payload.
const APPROVAL_FLOW_TYPES_WITH_REQUIRED_RUN: [&str; 8] = [
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.canceled",
    "approval.remembered",
    "approval.reviewer_denied",
    "moderation.review_flagged",
    "plan.proposed",
];

/// Every event type whose payload always names a run, built from the run-scoped categories so a
/// type added there joins on its own. The `general` arm refuses these by type, because a
/// projected payload is a summary that may omit `runId`.
pub fn transcript_run_scoped_event_types() -> Vec<&'static str> {
    RUN_LIFECYCLE_EVENT_TYPES
        .iter()
        .chain(TOOL_ACTIVITY_EVENT_TYPES)
        .chain(INTERACTIVE_REQUEST_EVENT_TYPES.iter().filter(|event_type| {
            !INTERACTIVE_REQUEST_TYPES_WITHOUT_REQUIRED_RUN.contains(event_type)
        }))
        .chain(&USAGE_TELEMETRY_TYPES_WITH_REQUIRED_RUN)
        .chain(&APPROVAL_FLOW_TYPES_WITH_REQUIRED_RUN)
        .copied()
        .collect()
}

/// The superseded marker: present exactly when the row's turn is superseded. `targetPosition` is
/// the rewind cutoff of the first accepted rollback in the run's lineage, at the row's epoch or
/// later, that rewound the surviving history containing the row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupersededMarker {
    /// The rewind cutoff.
    pub target_position: SafeInt<0>,
}

/// One file whose patch a tool call's row left out, and the patch's size in bytes;
/// `transcript.patchRead` fetches every left-out patch of the call in one read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptOmittedPatch {
    /// The file's path.
    pub path: FreeFormText<FILE_PATH_MAX_LEN>,
    /// The patch's size in bytes.
    pub size: SafeInt<0>,
}

/// The `rollback_boundary` arm's category: `run_lifecycle`, the one `run.rolled_back` belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum RunLifecycleCategory {
    /// `run_lifecycle`.
    #[serde(rename = "run_lifecycle")]
    RunLifecycle,
}

/// The `rollback_boundary` arm's event type: `run.rolled_back`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum RollbackBoundaryType {
    /// `run.rolled_back`.
    #[serde(rename = "run.rolled_back")]
    RunRolledBack,
}

/// Refuses a marker that does not supersede its row: the row's position must exceed the marker's
/// cutoff. Epoch is not compared; this ordering is the whole in-row rule.
fn require_marker_to_outrank_row(
    position: SafeInt<0>,
    superseded: Option<&SupersededMarker>,
) -> garde::Result {
    match superseded {
        Some(marker) if position <= marker.target_position => Err(garde::Error::new(format!(
            "a superseded row ranks above the rewind cutoff: position {} does not exceed \
             targetPosition {}",
            position.get(),
            marker.target_position.get()
        ))),
        _ => Ok(()),
    }
}

/// Whether a payload member equals an outer integer, as JavaScript's `===` compares two numbers.
fn is_same_number(member: &Value, outer: SafeInt<0>) -> bool {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a safe integer is exact as a double"
    )]
    let outer = outer.get() as f64;
    member
        .as_f64()
        .is_some_and(|number| (number - outer).abs() == 0.0)
}

/// Declares one arm of [`TranscriptReadRow`]: the members every row carries, then the arm's own.
/// The arm writes its own attributes, so a check of its own reads `self` in the derive's scope.
macro_rules! transcript_row_arm {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($arm:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The id of the event this row projects from; opaque on the wire.
            pub id: FreeFormText<EVENT_FIELD_MAX_LEN>,
            /// The session.
            pub session_id: SessionId,
            /// The session event sequence, never a run position: re-execution reuses run
            /// ordinals.
            pub sequence: SafeInt<0>,
            /// The position the session's stream delivers this event at, relayed verbatim, so a
            /// link naming a message by its cursor finds the row however the row was read.
            pub cursor: EventCursor,
            /// Who acted.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
            pub actor: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
            /// When the event occurred.
            #[garde(dive)]
            pub timestamp: WireInstant,
            /// Present when this row is a summarized child-run row.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ChildRunSummary")]
            #[garde(dive)]
            pub child_run_summary: Option<ChildRunSummary>,
            /// Present on a tool call's row that left out one or more patches.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<TranscriptOmittedPatch>", extend("minItems" = 1))]
            #[garde(length(min = 1))]
            pub omitted_patches: Option<Vec<TranscriptOmittedPatch>>,
            /// The row's body.
            #[garde(dive)]
            pub content: TranscriptRowContent,
            $($arm)*
        }
    };
}

transcript_row_arm! {
    /// `kind: "general"`, the non-run arm. It carries no run attribution, and refuses a row that
    /// belongs to a run by its category, its type or a payload naming a run: misfiled, such a row
    /// escapes run filters and rollback, so a superseded turn shows as current.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct TranscriptEntry {
        /// The event's category; never `run_lifecycle`, whose every event is run-scoped.
        #[schemars(extend("not" = { "const": "run_lifecycle" }))]
        pub category: EventCategory,
        /// The event's type, free-form by contract: narrow on `kind`, never on this.
        #[serde(rename = "type")]
        #[garde(custom(|event_type: &FreeFormText<EVENT_FIELD_MAX_LEN>, (): &()| {
            self.refuse_run_scoped_row(event_type.as_str())
        }))]
        #[schemars(extend("not" = { "enum": transcript_run_scoped_event_types() }))]
        pub event_type: FreeFormText<EVENT_FIELD_MAX_LEN>,
        /// The event's payload, an open record that names no run.
        #[schemars(extend("properties" = {
            "runId": { "not": { "type": "string", "minLength": 1 }, "tsType": "unknown" },
            "targetRunId": { "not": { "type": "string", "minLength": 1 }, "tsType": "unknown" }
        }))]
        pub payload: Map<String, Value>,
    }
}

impl TranscriptEntry {
    /// Refuses a row that belongs to a run by its category, its type or a payload naming a run.
    fn refuse_run_scoped_row(&self, event_type: &str) -> garde::Result {
        if self.category == EventCategory::RunLifecycle {
            return Err(garde::Error::new(
                "every run_lifecycle event is run-scoped, so it belongs to the run arm",
            ));
        }
        if transcript_run_scoped_event_types().contains(&event_type) {
            return Err(garde::Error::new(format!(
                "the event type {event_type:?} names a run in every form of its payload, so it \
                 belongs to the run arm"
            )));
        }
        if transcript_run_id_of(Some(&self.payload)).is_some() {
            return Err(garde::Error::new(
                "this row's payload names a run, so the row belongs to the run arm",
            ));
        }
        Ok(())
    }
}

transcript_row_arm! {
    /// `kind: "run"`, the arm that requires attribution: `runId`, `position` and `epoch`.
    /// `position` is the originating run position, compared against a rollback's cutoff; `epoch`
    /// is separate because re-execution reuses ordinals. A payload's echoed run, epoch and
    /// position agree with the row's.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct RunScopedTranscriptEntry {
        /// The event's category.
        pub category: EventCategory,
        /// The event's type; never `run.rolled_back`, which only the boundary arm carries.
        #[serde(rename = "type")]
        #[schemars(extend("not" = { "const": "run.rolled_back" }))]
        #[garde(custom(|event_type: &FreeFormText<EVENT_FIELD_MAX_LEN>, (): &()| {
            refuse_boundary_type(event_type.as_str())
        }))]
        pub event_type: FreeFormText<EVENT_FIELD_MAX_LEN>,
        /// The run the row belongs to.
        pub run_id: RunId,
        /// The row's originating turn position; above any superseded marker's cutoff.
        #[garde(custom(|position: &SafeInt<0>, (): &()| {
            require_marker_to_outrank_row(*position, self.superseded.as_ref())
        }))]
        #[schemars(extend("exclusiveMinimum" = { "$data": "1/superseded/targetPosition" }))]
        pub position: SafeInt<0>,
        /// The row's execution epoch.
        pub epoch: SafeInt<0>,
        /// Present exactly when the row's turn is superseded.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SupersededMarker")]
        pub superseded: Option<SupersededMarker>,
        /// The event's payload, an open record whose echoed attribution agrees with the row's.
        #[garde(custom(|payload: &Map<String, Value>, (): &()| {
            self.require_payload_attribution_to_agree(payload)
        }))]
        #[schemars(extend("properties" = {
            "runId": { "const": { "$data": "2/runId" }, "tsType": "unknown" },
            "targetRunId": { "const": { "$data": "2/runId" }, "tsType": "unknown" },
            "sourceEpoch": { "const": { "$data": "2/epoch" }, "tsType": "unknown" },
            "sourcePosition": { "const": { "$data": "2/position" }, "tsType": "unknown" }
        }))]
        pub payload: Map<String, Value>,
    }
}

/// Refuses the rollback event type off the boundary arm, where its rewind cutoff would go untyped.
fn refuse_boundary_type(event_type: &str) -> garde::Result {
    if event_type == TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE {
        Err(garde::Error::new(
            "the run.rolled_back event type is carried only by the rollback_boundary arm",
        ))
    } else {
        Ok(())
    }
}

impl RunScopedTranscriptEntry {
    /// Refuses a payload that names another run under either spelling, or another epoch or
    /// position: a row stating two identities is filed under one and sourced from the other.
    fn require_payload_attribution_to_agree(&self, payload: &Map<String, Value>) -> garde::Result {
        for attribution_key in TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS {
            if let Some(named) = payload.get(attribution_key)
                && named.as_str() != Some(self.run_id.as_str())
            {
                return Err(garde::Error::new(format!(
                    "payload {attribution_key} {named} disagrees with the row's own runId"
                )));
            }
        }
        for (payload_key, outer) in [
            (SOURCE_EPOCH_PAYLOAD_KEY, self.epoch),
            (SOURCE_POSITION_PAYLOAD_KEY, self.position),
        ] {
            if let Some(echoed) = payload.get(payload_key)
                && !is_same_number(echoed, outer)
            {
                return Err(garde::Error::new(format!(
                    "payload {payload_key} {echoed} disagrees with the row's own {}",
                    outer.get()
                )));
            }
        }
        Ok(())
    }
}

transcript_row_arm! {
    /// `kind: "rollback_boundary"`, the `run.rolled_back` row, whose typed payload agrees with the
    /// row's `runId`, `sessionId` and `position`.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct TranscriptRollbackBoundary {
        /// Pinned with `type`: `run.rolled_back` belongs to this category only.
        pub category: RunLifecycleCategory,
        /// The rollback event's type.
        #[serde(rename = "type")]
        pub event_type: RollbackBoundaryType,
        /// The run the rollback rewound.
        pub run_id: RunId,
        /// The boundary row's own originating position, the confirmed rewind floor.
        #[garde(custom(|position: &SafeInt<0>, (): &()| {
            require_marker_to_outrank_row(*position, self.superseded.as_ref())
        }))]
        #[schemars(extend("exclusiveMinimum" = { "$data": "1/superseded/targetPosition" }))]
        pub position: SafeInt<0>,
        /// The epoch the rollback rewound.
        pub epoch: SafeInt<0>,
        /// Present when a later, lower rollback superseded the boundary row itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SupersededMarker")]
        pub superseded: Option<SupersededMarker>,
        /// The rollback, which names the row's run, session and position.
        #[garde(custom(|payload: &RunRolledBackEvent, (): &()| {
            self.require_payload_to_agree(payload)
        }))]
        #[schemars(extend("type" = "object", "properties" = {
            "runId": { "const": { "$data": "2/runId" } },
            "sessionId": { "const": { "$data": "2/sessionId" } },
            "targetPosition": { "const": { "$data": "2/position" } }
        }))]
        pub payload: RunRolledBackEvent,
    }
}

impl TranscriptRollbackBoundary {
    /// Refuses a payload that names another run, session or rewind floor than the row.
    fn require_payload_to_agree(&self, payload: &RunRolledBackEvent) -> garde::Result {
        if payload.run_id != self.run_id {
            return Err(garde::Error::new("runId must equal payload.runId"));
        }
        if payload.session_id != self.session_id {
            return Err(garde::Error::new("sessionId must equal payload.sessionId"));
        }
        if payload.target_position != self.position {
            return Err(garde::Error::new(
                "position must equal payload.targetPosition",
            ));
        }
        Ok(())
    }
}

/// A transcript row as a read returns it, its body required, discriminated on `kind`. The arm is
/// chosen by `kind`, so a failure is reported against that arm and never retried against a
/// sibling.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscriptReadRow {
    /// The `run.rolled_back` row.
    RollbackBoundary(#[garde(dive)] TranscriptRollbackBoundary),
    /// A run's row.
    Run(#[garde(dive)] RunScopedTranscriptEntry),
    /// A row of no run.
    General(#[garde(dive)] TranscriptEntry),
}

impl TranscriptReadRow {
    /// The run the row belongs to; `None` on the `general` arm.
    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::RollbackBoundary(row) => Some(&row.run_id),
            Self::Run(row) => Some(&row.run_id),
            Self::General(_) => None,
        }
    }

    /// The row's session event sequence.
    pub fn sequence(&self) -> SafeInt<0> {
        match self {
            Self::RollbackBoundary(row) => row.sequence,
            Self::Run(row) => row.sequence,
            Self::General(row) => row.sequence,
        }
    }
}

/// The run attribution the daemon stamps on one event of a run: its turn position, its execution
/// epoch and, when the turn was rolled back, the superseded marker, which ranks below the
/// position.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TranscriptRunStamp {
    /// The turn position.
    #[garde(custom(|position: &SafeInt<0>, (): &()| {
        require_marker_to_outrank_row(*position, self.superseded.as_ref())
    }))]
    #[schemars(extend("exclusiveMinimum" = { "$data": "1/superseded/targetPosition" }))]
    pub position: SafeInt<0>,
    /// The execution epoch.
    pub epoch: SafeInt<0>,
    /// Present when the turn was rolled back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SupersededMarker")]
    pub superseded: Option<SupersededMarker>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/row",
    doc: "The transcript row every transcript read returns, discriminated on the closed `kind`, \
          and the run stamp of an event delivered without its row.",
    definitions: &[
        Definition::read::<SupersededMarker>().checked(),
        Definition::read::<TranscriptOmittedPatch>(),
        Definition::read::<TranscriptReadRow>().checked(),
        Definition::read::<TranscriptRunStamp>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

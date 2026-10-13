//! The payloads of the session events this module declares itself: event compaction, assistant
//! and tool activity, and the provider's move of a turn onto another model, with the members the
//! append path owns on every body-bearing payload.
//!
//! An assistant or tool row's body lives outside the canonical bytes, in the stored row's content;
//! its payload carries only the body's length and whether it was cut, and a reader pairs the two.
//! The strict payloads refuse a spliced body. `contentType` is the producer's; the length and the
//! cut mark are the append path's, which refuses a producer that sends either.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::event::envelope::{
    EventOccurredAt, SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::run::id::RunId;
use crate::runtime_node::id::NodeId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::voice::MessageOrigin;
use crate::wire::Never;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The payload key carrying the body's UTF-8 byte length before any cut, so a cut row still
    /// reports how much was dropped.
    pub const CONTENT_LENGTH_PAYLOAD_KEY: &str = "contentLength";
    /// The payload key marking a body stored as a prefix. Present only as `true`, never `false`,
    /// so a complete row's canonical bytes are what they would be without the bound.
    pub const CONTENT_TRUNCATED_PAYLOAD_KEY: &str = "contentTruncated";
    /// The largest body one stored row keeps, in UTF-8 bytes. A longer body is cut at a code point
    /// boundary, never refused, so the turn is never lost.
    pub const CONTENT_PAYLOAD_PLAINTEXT_MAX: usize = 262_144;
}

/// Refuses a deleted range that ends before it starts.
fn ends_at_or_after_its_start(from_seq: SafeInt<0>, to_seq: SafeInt<0>) -> garde::Result {
    if from_seq <= to_seq {
        Ok(())
    } else {
        Err(garde::Error::new(
            "a deleted range starts at or before its end",
        ))
    }
}

/// One session a deletion removed, with the range of its rows the deletion deleted. Each end is a
/// `sequence` value and takes the envelope's ceiling, so it names the row it points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct EventCompactedRemovedSession {
    /// The session removed.
    pub session_id: SessionId,
    /// The first sequence deleted.
    pub from_seq: SafeInt<0>,
    /// The last sequence deleted; at or after `fromSeq`.
    #[garde(custom(|to_seq: &SafeInt<0>, (): &()| {
        ends_at_or_after_its_start(self.from_seq, *to_seq)
    }))]
    #[schemars(extend("minimum" = { "$data": "1/fromSeq" }))]
    pub to_seq: SafeInt<0>,
}

/// The `event.compacted` payload: the receipt of one session deletion, naming every session it
/// removed and the range of rows it deleted in each. It is written only when a deletion deleted
/// rows, so it names at least one session. The daemon writes it under its own sentinel session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct EventCompactedPayload {
    /// The machine whose daemon ran the deletion.
    pub node_id: NodeId,
    /// The deletion's correlation id: opaque, with no fixed format.
    pub operation_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// When the deletion ran; the envelope's own instant, repeated in the payload.
    #[garde(dive)]
    pub occurred_at: EventOccurredAt,
    /// Every session removed, with its deleted range.
    #[garde(dive)]
    pub removed_sessions: BoundedVec<EventCompactedRemovedSession, 1, { usize::MAX }>,
}

/// Declares a body-bearing payload: the struct as written, followed by the two members the append
/// path owns, `contentLength` and `contentTruncated`, each optional because a row may have no body.
/// The struct's attributes come with it and include `#[garde(allow_unvalidated)]`.
macro_rules! with_machine_content_descriptor {
    ($(#[$meta:meta])* pub struct $name:ident { $($members:tt)* }) => {
        $(#[$meta])*
        pub struct $name {
            $($members)*
            /// The stored body's UTF-8 byte length before any cut.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::wire::integer::SafeInt<0>")]
            pub content_length: Option<$crate::wire::integer::SafeInt<0>>,
            /// Present, as `true`, only when the stored body is a prefix; never `false`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::wire::True")]
            pub content_truncated: Option<$crate::wire::True>,
        }
    };
}

pub(crate) use with_machine_content_descriptor;

/// Declares one arm of the assistant output payload with the members both arms repeat.
macro_rules! assistant_output_arm {
    ($(#[$meta:meta])* $name:ident { $($arm:tt)* }) => {
        $crate::event::declared_variants::with_machine_content_descriptor! {
            $(#[$meta])*
            pub struct $name {
                /// The session.
                pub session_id: SessionId,
                /// The provider's own id of the message this piece belongs to, the same on every
                /// piece, so a reader can rejoin a message the wire delivered in pieces.
                pub provider_message_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
                /// The body's media type, set by the producer and never by the append path.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
                pub content_type: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
                $($arm)*
            }
        }
    };
}

assistant_output_arm! {
    /// An assistant row of a run: every assistant row but a voice call's spoken answer. It takes
    /// the epoch stamp.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[schemars(inline)]
    #[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
    RunAssistantOutputPayload {
        /// The run the row belongs to.
        pub run_id: RunId,
        /// Never present: only a voice call's answer carries an origin.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub origin: Option<Never>,
        /// The execution epoch a late row is attributed to; comes with `sourcePosition`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourceEpoch")]
        #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
            check_epoch_stamp(*epoch, self.source_position, true)
        }))]
        pub source_epoch: Option<SourceEpoch>,
        /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourcePosition")]
        pub source_position: Option<SourcePosition>,
    }
}

assistant_output_arm! {
    /// A voice call's spoken answer, which comes outside any run, so it names no run and takes no
    /// epoch stamp.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[schemars(inline)]
    VoiceAssistantOutputPayload {
        /// Always `voice`.
        pub origin: MessageOrigin,
        /// Never present: a voice call's answer comes outside any run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub run_id: Option<Never>,
        /// Never present: the stamp is run-local.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub source_epoch: Option<Never>,
        /// Never present: the stamp is run-local.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub source_position: Option<Never>,
    }
}

/// The payload of `assistant.message` and `assistant.thinking_update`: a run's row, or a voice
/// call's spoken answer, which alone names no run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AssistantOutputPayload {
    /// A run's row.
    Run(#[garde(dive)] RunAssistantOutputPayload),
    /// A voice call's spoken answer.
    Voice(#[garde(dive)] VoiceAssistantOutputPayload),
}

with_machine_content_descriptor! {
    /// The payload of `tool.invoked`, `tool.result` and `tool.error`; the call's arguments, result
    /// or error body is kept apart from it. It takes the epoch stamp.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
    pub struct ToolActivityPayload {
        /// The session.
        pub session_id: SessionId,
        /// The run the call belongs to.
        pub run_id: RunId,
        /// The tool's name; required, since a row with no name cannot be attributed and the append
        /// path cannot add it.
        pub tool_name: FreeFormText<EVENT_FIELD_MAX_LEN>,
        /// The provider's id of the call.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
        pub tool_call_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
        /// How long the call took, in milliseconds.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        pub duration_ms: Option<SafeInt<0>>,
        /// The execution epoch a late row is attributed to; comes with `sourcePosition`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourceEpoch")]
        #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
            check_epoch_stamp(*epoch, self.source_position, true)
        }))]
        pub source_epoch: Option<SourceEpoch>,
        /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SourcePosition")]
        pub source_position: Option<SourcePosition>,
    }
}

/// How long a provider's move onto another model holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelRerouteScope {
    /// This turn.
    Turn,
    /// The rest of the session.
    Session,
    /// One helper's response: a subagent's, a side question's or a background fork's.
    Local,
}

/// Why the provider moved a turn onto another model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelRerouteCause {
    /// The provider's safety check.
    Safety,
    /// The model was not available.
    ModelUnavailable,
    /// The model was blocked for the account.
    ModelBlocked,
    /// The account ran out of credits.
    OutOfCredits,
}

/// The `usage.model_rerouted` payload: the provider moved a turn onto another model and the turn
/// went on. `sentence`, `explanation` and `safetyCategory` are the provider's own. It takes the
/// epoch stamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct UsageModelReroutedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run whose turn moved.
    pub run_id: RunId,
    /// The agent whose turn moved.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentId")]
    pub agent_id: Option<AgentId>,
    /// The model the turn was asked of.
    pub from_model: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The model the turn ran on, and the model it is priced at.
    pub to_model: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// How long the move holds.
    pub scope: ModelRerouteScope,
    /// The provider's own sentence, absent when it sent none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub sentence: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// The provider's explanation, shown as sent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>")]
    pub explanation: Option<FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>>,
    /// Why the provider moved the turn.
    pub cause: ModelRerouteCause,
    /// The provider's open safety category, such as `cyber` or `bio`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub safety_category: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The execution epoch a late row is attributed to; comes with `sourcePosition`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, true)
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The TypeScript module of the payloads declared here.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/declared-variants",
    doc: "The payloads of the session events this module declares itself: event compaction, \
          assistant and tool activity, and the provider's move of a turn onto another model.",
    definitions: &[
        Definition::read::<EventCompactedRemovedSession>(),
        Definition::read::<EventCompactedPayload>().checked(),
        Definition::read::<RunAssistantOutputPayload>(),
        Definition::read::<VoiceAssistantOutputPayload>(),
        Definition::read::<AssistantOutputPayload>().checked(),
        Definition::read::<ToolActivityPayload>().checked(),
        Definition::read::<ModelRerouteScope>(),
        Definition::read::<ModelRerouteCause>(),
        Definition::read::<UsageModelReroutedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

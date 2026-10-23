//! The payloads of the session events this module declares itself: event compaction and agent
//! and tool activity, with the members the append path owns on every body-bearing payload.
//!
//! An agent or tool row's body lives outside the canonical bytes, in the stored row's content;
//! its payload carries only the body's length and whether it was cut, and a reader pairs the two.
//! The strict payloads refuse a spliced body. `contentType` is the producer's; the length and the
//! cut mark are the append path's, which refuses a producer that sends either.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::envelope::{
    EventOccurredAt, SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::machine::id::MachineId;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::transcript::row::TranscriptOmittedPatch;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::voice::MessageOrigin;
use crate::wire::Never;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{FreeFormText, branded_free_form_text};

ts_constants! {
    /// The payload key carrying the body's UTF-8 byte length before any cut, so a cut row still
    /// reports how much was dropped.
    pub const CONTENT_LENGTH_PAYLOAD_KEY: &str = "contentLength";
    /// The payload key marking a body stored as a prefix. Present only as `true`, never `false`,
    /// so a complete row's canonical bytes are what they would be without the bound.
    pub const CONTENT_TRUNCATED_PAYLOAD_KEY: &str = "contentTruncated";
    /// The largest body one stored row keeps, in code points. A longer body is cut at a code point
    /// boundary, never refused, so the turn is never lost. A tool completion whose body holds its
    /// file patches is the one exception: each file is stored in parts of at most this many code
    /// points, so every patch reads back whole.
    pub const CONTENT_PAYLOAD_PLAINTEXT_MAX: usize = 262_144;
}

branded_free_form_text! {
    /// A provider's id of one tool call.
    pub struct ToolCallId(PROVIDER_WIRE_HANDLE_MAX_LEN);
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
pub struct SessionEventCompactedRemovedSession {
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

/// The `session.event.compacted` payload: one receipt per removed session, committed in the
/// transaction that deletes its rows, naming that session and the range of rows deleted. It is
/// written only when the session had rows. The daemon writes it under its own sentinel session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionEventCompactedPayload {
    /// The machine whose daemon ran the deletion.
    pub machine_id: MachineId,
    /// The deletion's correlation id: opaque, with no fixed format.
    pub operation_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// When the deletion ran; the envelope's own instant, repeated in the payload.
    #[garde(dive)]
    pub occurred_at: EventOccurredAt,
    /// Every session removed, with its deleted range.
    #[garde(dive)]
    pub removed_sessions: BoundedVec<SessionEventCompactedRemovedSession, 1, { usize::MAX }>,
}

/// A payload whose events may carry a body kept apart from it: one declared through
/// `with_machine_content_descriptor!`, or a union of such payloads.
pub(crate) trait MachineContentDescriptor {}

/// Refuses a cut mark on a payload that reports no body length.
pub(crate) fn truncation_reports_its_length(is_truncated: bool, has_length: bool) -> garde::Result {
    if is_truncated && !has_length {
        Err(garde::Error::new("a cut body reports its length"))
    } else {
        Ok(())
    }
}

/// The schema twin of [`truncation_reports_its_length`], merged into the payload's own
/// `dependentRequired` so the epoch stamp's pairs stay beside it.
pub(crate) fn add_truncation_length_rule(schema: &mut schemars::Schema) {
    let rule = serde_json::json!([CONTENT_LENGTH_PAYLOAD_KEY]);
    match schema
        .get_mut("dependentRequired")
        .and_then(serde_json::Value::as_object_mut)
    {
        Some(dependent_required) => {
            dependent_required.insert(CONTENT_TRUNCATED_PAYLOAD_KEY.to_owned(), rule);
        }
        None => {
            schema.insert(
                "dependentRequired".into(),
                serde_json::json!({ CONTENT_TRUNCATED_PAYLOAD_KEY: rule }),
            );
        }
    }
}

/// Declares a body-bearing payload: the struct as written, followed by the two members the append
/// path owns, `contentLength` and `contentTruncated`, each optional because a row may have no body,
/// and the cut mark only beside a length. The struct's attributes come with it and include
/// `#[garde(allow_unvalidated)]`.
macro_rules! with_machine_content_descriptor {
    ($(#[$meta:meta])* pub struct $name:ident { $($members:tt)* }) => {
        $(#[$meta])*
        #[garde(custom(|payload: &Self, (): &()| {
            $crate::event::declared_variants::truncation_reports_its_length(
                payload.content_truncated.is_some(),
                payload.content_length.is_some(),
            )
        }))]
        #[schemars(transform = $crate::event::declared_variants::add_truncation_length_rule)]
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

        impl $crate::event::declared_variants::MachineContentDescriptor for $name {}
    };
}

pub(crate) use with_machine_content_descriptor;

/// Declares one arm of the agent output payload with the members both arms repeat.
macro_rules! agent_output_arm {
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

/// Which content block of a provider's message a piece belongs to: a reply sends its text, its
/// reasoning and its tool calls as blocks of one message, and a retried response may reuse the
/// message's id. Pieces join one row only when their message and block are the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBlock {
    /// The block's index within its message, as the provider numbers it.
    pub index: SafeInt<0>,
    /// Which response under the message's id the block belongs to, from 1.
    pub attempt: SafeInt<1>,
}

agent_output_arm! {
    /// An agent row of a run: every agent row but a voice call's spoken answer. It takes
    /// the epoch stamp.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[schemars(inline)]
    #[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
    RunAgentOutputPayload {
        /// The run the row belongs to.
        pub run_id: RunId,
        /// The content block the piece belongs to, where the provider's message holds several.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderBlock")]
        pub provider_block: Option<ProviderBlock>,
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

agent_output_arm! {
    /// A voice call's spoken answer, which comes outside any run, so it names no run and takes no
    /// epoch stamp.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[schemars(inline)]
    VoiceAgentOutputPayload {
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
        /// Never present: a spoken answer lands whole.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub provider_block: Option<Never>,
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

/// The payload of `agent.message.sent` and `agent.thinking.updated`: a run's row, or a voice
/// call's spoken answer, which alone names no run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AgentOutputPayload {
    /// A run's row.
    Run(#[garde(dive)] RunAgentOutputPayload),
    /// A voice call's spoken answer.
    Voice(#[garde(dive)] VoiceAgentOutputPayload),
}

/// Both arms are declared with the content members.
impl MachineContentDescriptor for AgentOutputPayload {}

with_machine_content_descriptor! {
    /// The payload of `agent.toolCall.invoked`, `agent.toolCall.completed` and
    /// `agent.toolCall.failed`; the call's arguments, result or error body is kept apart from it.
    /// It takes the epoch stamp.
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
        #[schemars(with = "ToolCallId")]
        pub tool_call_id: Option<ToolCallId>,
        /// How long the call took, in milliseconds.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        pub duration_ms: Option<SafeInt<0>>,
        /// On a completion whose body holds its file patches, every file in the body's order with
        /// its patch's UTF-8 size, so a row whose body is too large to travel still names them; set
        /// by the producer. A body naming files is stored in bounded parts of each file, which the
        /// patch read pages; an empty list names none, and its body is stored as any other.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "BoundedVec<TranscriptOmittedPatch, 0, { usize::MAX }>")]
        pub omitted_patches: Option<BoundedVec<TranscriptOmittedPatch, 0, { usize::MAX }>>,
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

/// The TypeScript module of the payloads declared here.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/declared-variants",
    doc: "The payloads of the session events this module declares itself: event compaction and \
          agent and tool activity.",
    definitions: &[
        Definition::read::<SessionEventCompactedRemovedSession>(),
        Definition::read::<SessionEventCompactedPayload>().checked(),
        Definition::read::<ToolCallId>(),
        Definition::read::<ProviderBlock>(),
        Definition::read::<RunAgentOutputPayload>(),
        Definition::read::<VoiceAgentOutputPayload>(),
        Definition::read::<AgentOutputPayload>().checked(),
        Definition::read::<ToolActivityPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

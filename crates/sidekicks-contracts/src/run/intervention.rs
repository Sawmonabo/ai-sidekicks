//! Interventions on a running run: the interrupt and the faster-model retry a caller sends
//! through `agent.run.intervene`, the daemon's answer, the states an intervention passes through,
//! and an interrupt's stored record.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::internal::branded::branded_uuid_id;
use crate::method::KeyedRequest;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::{
    PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_REASON_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN,
};
use crate::run::id::RunId;
use crate::run::queue::QueueItemId;
use crate::turn::ProviderTurnId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

branded_uuid_id! {
    /// Identifies one intervention on a run.
    InterventionId
}

/// How a caller acts on a live run, as its intervention row records it: interrupt, or retry on a
/// faster model, which the daemon carries out by stopping the turn and sending its message again on
/// the named model. A person's message mid-turn is a queue send, never an intervention.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum InterventionType {
    /// Stops the turn.
    Interrupt,
    /// Stops the turn and sends its message again on a faster model.
    FasterModelRetry,
}

/// Where an intervention stands, from request to outcome; each state has its own event. `failed`
/// is a dispatch that threw, so a request never stays `accepted` for good.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum InterventionState {
    /// Asked for.
    Requested,
    /// Taken by the daemon.
    Accepted,
    /// Carried out as asked.
    Applied,
    /// Refused.
    Rejected,
    /// Carried out through a fallback.
    Degraded,
    /// Outdated before it could apply.
    Expired,
    /// Its dispatch threw, never completed (a daemon death among them), or was never sent because
    /// the run ended and was continued before it.
    Failed,
}

ts_constants! {
    /// Every state an intervention passes through, `requested` first.
    INTERVENTION_STATES = InterventionState::VARIANTS;
}

/// Declares the interrupt's arms on `pending`: each repeats the guards every intervention carries
/// and the reason, then adds its own members.
macro_rules! intervention_interrupt_request {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "pending",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[schemars(inline)]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The run interrupted.
                target_run_id: RunId,
                /// The run version the caller last saw; an absent or outdated one is refused,
                /// never applied.
                expected_run_version: SafeInt<0>,
                /// The caller's key, stored with the intervention, so an identical retry answers
                /// the recorded outcome.
                client_idempotency_key: ClientUuid,
                /// The person's reason.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>")]
                reason: Option<FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>>,
                $($extra)*
            },
        )+}
    };
}

intervention_interrupt_request! {
    /// An interrupt of a run's turn, tagged on what becomes of the messages still waiting: sent as
    /// the next turn, or returned to the draft. Only the next turn may name a message to deliver
    /// first.
    pub enum InterventionInterruptRequest {
        /// The waiting messages go as the next turn.
        NextTurn {
            /// The message `Send now` puts ahead of the rest.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "QueueItemId")]
            deliver_first: Option<QueueItemId>,
        },
        /// The waiting messages return to the draft.
        ReturnToDraft {
            /// Never present: a message delivered first goes as the next turn.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            deliver_first: Option<Never>,
        },
    }
}

/// A limit the daemon stops a run at by itself: the step limit on a provider that does not bound a
/// turn's steps, or the spend or token limit. Only the daemon's own stop records one.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum RunLimit {
    /// The turn reached the steps it may take.
    StepLimit,
    /// The session reached its spend limit.
    SpendLimit,
    /// The run reached its token limit.
    TokenLimit,
}

/// A person's interrupt as its `interventions` row stores it: what becomes of the waiting
/// messages, the message delivered first and the person's reason, never a limit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "pending",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PersonInterruptRecord {
    /// The waiting messages go as the next turn.
    NextTurn {
        /// The message `Send now` puts ahead of the rest.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "QueueItemId")]
        deliver_first: Option<QueueItemId>,
        /// The person's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>")]
        reason: Option<FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>>,
        /// Never present: only the daemon's own stop carries a limit.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        limit: Option<Never>,
    },
    /// The waiting messages return to the draft.
    ReturnToDraft {
        /// Never present: a message delivered first goes as the next turn.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        deliver_first: Option<Never>,
        /// The person's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>")]
        reason: Option<FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>>,
        /// Never present: only the daemon's own stop carries a limit.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        limit: Option<Never>,
    },
}

/// The daemon's own stop at a limit as its `interventions` row stores it, with no device: the
/// limit and the turn the stop cut, so a restart settles the run and ends that turn with that
/// cause. The waiting messages stay waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitInterruptRecord {
    /// The limit the run reached.
    pub limit: RunLimit,
    /// The turn the stop cut; absent when no turn of the run was open.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub turn_number: Option<SafeInt<1>>,
}

/// The stored `payload` of an interrupt's `interventions` row: a person's, or the daemon's own at
/// a limit. The arms are disjoint: a person's carries `pending` and no limit, the daemon's only
/// its limit, so a person's reason never reads as a limit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum InterruptInterventionRecord {
    /// A person's interrupt.
    Person(PersonInterruptRecord),
    /// The daemon's own stop at a limit.
    Limit(LimitInterruptRecord),
}

impl InterruptInterventionRecord {
    /// The limit the daemon stopped the run at, `None` on a person's interrupt.
    pub fn limit(&self) -> Option<RunLimit> {
        match self {
            Self::Person(_) => None,
            Self::Limit(record) => Some(record.limit),
        }
    }
}

/// A caller's request to interrupt or retry a run; a person's steer is an `agent.queueItem.create`,
/// never an intervention. `fasterModelRetry` resends a turn the provider holds for a safety check
/// on `model`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum AgentRunInterveneRequest {
    /// Interrupts the run's turn.
    Interrupt(InterventionInterruptRequest),
    /// Retries the turn the provider holds on the faster model it names.
    FasterModelRetry {
        /// The run retried.
        target_run_id: RunId,
        /// The run version the caller last saw; an absent or outdated one is refused, never
        /// applied.
        expected_run_version: SafeInt<0>,
        /// The caller's key, stored with the intervention, so an identical retry answers the
        /// recorded outcome.
        client_idempotency_key: ClientUuid,
        /// The provider's id of the turn held.
        expected_turn_id: ProviderTurnId,
        /// The model the turn is sent again on.
        model: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    },
}

impl KeyedRequest for AgentRunInterveneRequest {}

/// Declares the intervention answer's arms on `state`: each repeats the members every answer
/// carries; the arms before the `;` carry no reason, and each arm after it adds its own.
macro_rules! intervention_request_response {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $plain_doc:literal])+ $plain_arm:ident,)+
            ;
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "state",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            $(
                $(#[doc = $plain_doc])+
                $plain_arm {
                    /// The intervention.
                    intervention_id: InterventionId,
                    /// What it does.
                    intervention_type: InterventionType,
                    /// The run version after the intervention, for the caller's next
                    /// `expectedRunVersion`.
                    run_version: SafeInt<0>,
                    /// Never present outside `rejected`.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    rejection_reason: Option<Never>,
                    /// Never present outside `failed`.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    failure_reason: Option<Never>,
                },
            )+
            $(
                $(#[doc = $arm_doc])+
                $arm {
                    /// The intervention.
                    intervention_id: InterventionId,
                    /// What it does.
                    intervention_type: InterventionType,
                    /// The run version after the intervention, for the caller's next
                    /// `expectedRunVersion`.
                    run_version: SafeInt<0>,
                    $($extra)*
                },
            )+
        }
    };
}

intervention_request_response! {
    /// The daemon's answer to an intervention request. A refused intervention is a normal answer in
    /// state `rejected` with a machine-readable `rejectionReason`, not a JSON-RPC error; one whose
    /// dispatch threw, never completed or was never sent answers `failed` with its `failureReason`,
    /// the error's code or message, the restart that lost the outcome or the run's end and
    /// continue before the dispatch, and a retry under the same key answers the same. No other
    /// state carries a reason.
    pub enum AgentRunInterveneResponse {
        /// Asked for.
        Requested,
        /// Taken by the daemon.
        Accepted,
        /// Carried out as asked.
        Applied,
        /// Carried out through a fallback.
        Degraded,
        /// Outdated before it could apply.
        Expired,
        ;
        /// Refused, with why.
        Rejected {
            /// The machine-readable cause, such as `provider.capability.unsupported`.
            rejection_reason: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
            /// Never present outside `failed`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            failure_reason: Option<Never>,
        },
        /// Its dispatch threw, never completed (a daemon death among them), or was never sent
        /// because the run ended and was continued before it, with why.
        Failed {
            /// The thrown error's code, else its message, or why it never completed or was never
            /// sent.
            failure_reason: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
            /// Never present outside `rejected`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            rejection_reason: Option<Never>,
        },
    }
}

/// The TypeScript module of a run's interventions.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/intervention",
    doc: "Interventions on a running run: the interrupt and the faster-model retry a caller sends \
          through `agent.run.intervene`, the daemon's answer, the states an intervention passes \
          through, and an interrupt's stored record.",
    definitions: &[
        Definition::read::<InterventionId>().checked(),
        Definition::read::<InterventionType>().checked(),
        Definition::read::<InterventionState>(),
        Definition::read::<RunLimit>(),
        Definition::read::<PersonInterruptRecord>(),
        Definition::read::<LimitInterruptRecord>(),
        Definition::read::<InterruptInterventionRecord>(),
        Definition::read::<AgentRunInterveneRequest>().checked(),
        Definition::read::<AgentRunInterveneResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{AgentRunInterveneRequest, InterruptInterventionRecord, RunLimit};
    use crate::wire::attachment::parse_received;

    /// What reading a stored interrupt record gives: the limit it names, a record with no limit,
    /// or a refusal.
    #[derive(Debug, PartialEq)]
    enum RecordRead {
        Limit(RunLimit),
        NoLimit,
        Refused,
    }

    // Dropping the person arms' `limit: Never` reads the mixed row as a person's interrupt,
    // reading `reason` as a limit makes the person's text settle as one, and a limit record that
    // refuses the turn its stop cut leaves every stored limit row unreadable.
    #[rstest]
    #[case(json!({"limit": "stepLimit"}), RecordRead::Limit(RunLimit::StepLimit))]
    #[case(json!({"limit": "spendLimit", "turnNumber": 2}), RecordRead::Limit(RunLimit::SpendLimit))]
    #[case(json!({"limit": "tokenLimit"}), RecordRead::Limit(RunLimit::TokenLimit))]
    #[case(json!({"pending": "nextTurn", "reason": "stepLimit"}), RecordRead::NoLimit)]
    #[case(json!({"pending": "returnToDraft"}), RecordRead::NoLimit)]
    #[case(json!({"pending": "nextTurn", "limit": "stepLimit"}), RecordRead::Refused)]
    #[case(json!({"limit": "budget"}), RecordRead::Refused)]
    fn only_the_daemons_record_reads_a_limit(#[case] payload: Value, #[case] expected: RecordRead) {
        let read = match serde_json::from_value::<InterruptInterventionRecord>(payload) {
            Ok(record) => record
                .limit()
                .map_or(RecordRead::NoLimit, RecordRead::Limit),
            Err(_) => RecordRead::Refused,
        };
        assert_eq!(read, expected);
    }

    // Killed by `ProviderTurnId` reading its text without free-form text's checks, which would
    // hand the provider a NUL, a blank or an over-long turn id.
    #[rstest]
    #[case::a_nul("turn\u{0}1".to_owned())]
    #[case::a_blank("   ".to_owned())]
    #[case::past_the_cap("t".repeat(257))]
    fn a_retry_refuses_a_turn_id_free_form_text_refuses(#[case] expected_turn_id: String) {
        let retry = |expected_turn_id: &str| {
            json!({
                "type": "fasterModelRetry",
                "targetRunId": "0190f2a0-0000-7000-8000-000000000001",
                "expectedRunVersion": 3,
                "clientIdempotencyKey": "0190f2a0-0000-7000-8000-000000000002",
                "expectedTurnId": expected_turn_id,
                "model": "gpt-5-mini",
            })
            .to_string()
        };
        assert!(
            parse_received::<AgentRunInterveneRequest>(retry(&"t".repeat(256)).as_bytes(), vec![])
                .is_ok()
        );
        assert!(
            parse_received::<AgentRunInterveneRequest>(retry(&expected_turn_id).as_bytes(), vec![])
                .is_err()
        );
    }
}

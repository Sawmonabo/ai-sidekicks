//! Interventions on a running run: the interrupt and the faster-model retry a caller sends
//! through `agent.run.intervene`, the daemon's answer, and the states an intervention passes
//! through.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::internal::branded::branded_uuid_id;
use crate::provider::driver::intervention::InterventionType;
use crate::provider::driver::length_limits::DRIVER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::driver::methods::{
    PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_REASON_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN,
};
use crate::run::id::RunId;
use crate::run::queue::QueueItemId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

branded_uuid_id! {
    /// Identifies one intervention on a run.
    InterventionId
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
    /// Its dispatch threw.
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
        expected_turn_id: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
        /// The model the turn is sent again on.
        model: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    },
}

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
    /// dispatch threw answers `failed` with its `failureReason`, the error's code or message, and a
    /// retry under the same key answers the same. No other state carries a reason.
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
        /// Its dispatch threw, with what it threw.
        Failed {
            /// The thrown error's code, else its message.
            failure_reason: FreeFormText<DRIVER_FAILURE_DETAIL_MAX_LEN>,
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
          through `agent.run.intervene`, the daemon's answer, and the states an intervention \
          passes through.",
    definitions: &[
        Definition::read::<InterventionId>().checked(),
        Definition::read::<InterventionState>(),
        Definition::read::<AgentRunInterveneRequest>().checked(),
        Definition::read::<AgentRunInterveneResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

//! `workflow.phase.suspended`, the payload of a step's wait: its cause, and with each cause what
//! the wait keeps, the deadline, the wait id and what a person's wait asks, the account and the
//! resume an account's wait arms, or nothing for a chain's question.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::account::record::ProviderAccountId;
use crate::session::id::SessionId;
use crate::wire::Never;
use crate::wire::id::UuidTextForm;
use crate::wire::instant::WireInstant;
use crate::wire::text::ComposedText;
use crate::workflow::run::step::record::{WorkflowPayloadRef, workflow_step_key};

/// Declares `WorkflowPhaseSuspendedPayload` with the step members every wait cause repeats.
macro_rules! phase_suspended_payload {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($fields:tt)* })+) => {
        workflow_step_key! {
            enum [
                /// The session the run lives in.
                session_id: SessionId,
            ]
            /// `workflow.phase.suspended`: a step started waiting: its `waitCause` and, for an
            /// `account` wait, the spent account the attention read groups it under and the
            /// durable resume instant where the wait armed one; absent, only the person resumes
            /// it, with the log and run variables its step recorded before it waited. A wait on
            /// anything else names neither. A wait on a person's approval, form or reply carries
            /// the deadline its node's `Timeout` arms, the `waitId` its answer names, the `logRef`
            /// the step wrote before it waited and what it asks, a form's fields among it; a wait
            /// on an account carries none of them but the log, and a chain's question none.
            #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
            #[serde(
                tag = "waitCause",
                rename_all = "camelCase",
                rename_all_fields = "camelCase",
                deny_unknown_fields
            )]
            #[garde(allow_unvalidated)]
            pub enum WorkflowPhaseSuspendedPayload {$(
                $(#[doc = $doc])+
                $arm { $($fields)* }
            )+}
        }
    };
}

phase_suspended_payload! {
    /// Waiting on a spent provider account.
    Account {
        /// The spent account.
        provider_account_id: ProviderAccountId,
        /// When the wait resumes itself; absent, only the person resumes it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        resume_at: Option<WireInstant>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_deadline_at: Option<Never>,
        /// Never present: only a wait on a person carries a wait id.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_id: Option<Never>,
        /// The log its step wrote before it waited; absent where it wrote none.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPayloadRef")]
        #[garde(dive)]
        log_ref: Option<WorkflowPayloadRef>,
        /// The run variables its step set before it waited, one item each; absent for none.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowPayloadRef")]
        #[garde(dive)]
        run_variables_ref: Option<WorkflowPayloadRef>,
        /// Never present: only a wait on a person asks.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        prompt: Option<Never>,
        /// Never present: only a form asks for fields.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        input_schema: Option<Never>,
    }
    /// Waiting on a person's approval.
    Approval {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// The log the step wrote before it waited.
        #[garde(dive)]
        log_ref: WorkflowPayloadRef,
        /// Never present: only an account wait keeps the run variables its step set before it
        /// waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        run_variables_ref: Option<Never>,
        /// What the wait asks the person, which the restart asks again where its ask is gone.
        prompt: ComposedText,
        /// Never present: only a form asks for fields.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        input_schema: Option<Never>,
    }
    /// Waiting on a person's form.
    Form {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// The log the step wrote before it waited.
        #[garde(dive)]
        log_ref: WorkflowPayloadRef,
        /// Never present: only an account wait keeps the run variables its step set before it
        /// waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        run_variables_ref: Option<Never>,
        /// What the wait asks the person, which the restart asks again where its ask is gone.
        prompt: ComposedText,
        /// The JSON Schema of the answer's fields.
        input_schema: serde_json::Map<String, serde_json::Value>,
    }
    /// Waiting on a person's chat reply.
    Reply {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// When the wait gives up, where the node's `Timeout` armed one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        wait_deadline_at: Option<WireInstant>,
        /// The wait the person's answer must name to settle it.
        wait_id: UuidTextForm,
        /// The log the step wrote before it waited.
        #[garde(dive)]
        log_ref: WorkflowPayloadRef,
        /// Never present: only an account wait keeps the run variables its step set before it
        /// waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        run_variables_ref: Option<Never>,
        /// What the wait asks the person, which the restart asks again where its ask is gone.
        prompt: ComposedText,
        /// Never present: only a form asks for fields.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        input_schema: Option<Never>,
    }
    /// Waiting on its chain's question.
    Chain {
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        provider_account_id: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        resume_at: Option<Never>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_deadline_at: Option<Never>,
        /// Never present: only a wait on a person carries a wait id.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        wait_id: Option<Never>,
        /// Never present: only a wait on a person writes a log before it waits.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        log_ref: Option<Never>,
        /// Never present: only an account wait keeps the run variables its step set before it
        /// waited.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        run_variables_ref: Option<Never>,
        /// Never present: only a wait on a person asks.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        prompt: Option<Never>,
        /// Never present: only a form asks for fields.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        input_schema: Option<Never>,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::WorkflowPhaseSuspendedPayload;
    use crate::workflow::run::step::events::tests::{empty_log, step_payload};

    const ACCOUNT: &str = "018f0000-0000-7000-8000-00000000000c";
    const DEADLINE: &str = "2020-01-01T10:00:00.000Z";
    const WAIT: &str = "018f0000-0000-7000-8000-00000000000d";

    /// A deadline rides a wait on a person and is refused on any other wait. Mutations: refuse it
    /// on a person's wait; keep it on an account or chain wait.
    #[rstest]
    #[case::approval(
        json!({"waitCause": "approval", "waitId": WAIT, "logRef": empty_log(), "prompt": "Ship?"}),
        true
    )]
    #[case::form(
        json!({"waitCause": "form", "waitId": WAIT, "logRef": empty_log(), "prompt": "Notes",
               "inputSchema": {"type": "object"}}),
        true
    )]
    #[case::reply(
        json!({"waitCause": "reply", "waitId": WAIT, "logRef": empty_log(), "prompt": "Why?"}),
        true
    )]
    #[case::account(json!({"waitCause": "account", "providerAccountId": ACCOUNT}), false)]
    #[case::chain(json!({"waitCause": "chain"}), false)]
    fn phase_suspended_carries_a_deadline_only_on_a_wait_on_a_person(
        #[case] wait: Value,
        #[case] is_carried: bool,
    ) {
        let without_deadline = step_payload(wait.clone());
        assert!(
            serde_json::from_value::<WorkflowPhaseSuspendedPayload>(without_deadline).is_ok(),
            "the wait reads without a deadline"
        );
        let mut with_deadline = wait;
        if let Some(members) = with_deadline.as_object_mut() {
            members.insert("waitDeadlineAt".into(), json!(DEADLINE));
        }
        let wire = step_payload(with_deadline);
        let written = serde_json::from_value::<WorkflowPhaseSuspendedPayload>(wire.clone())
            .ok()
            .map(|read| serde_json::to_value(read).expect("a read payload writes"));
        assert_eq!(written, is_carried.then_some(wire));
    }

    /// A wait on a person is refused without the log its step wrote. Mutation: make the person
    /// arms' `logRef` optional.
    #[rstest]
    #[case::approval("approval")]
    #[case::form("form")]
    #[case::reply("reply")]
    fn phase_suspended_on_a_person_is_refused_without_its_log(#[case] wait_cause: &str) {
        let wire = step_payload(json!({
            "waitCause": wait_cause, "waitId": WAIT, "prompt": "Ship?",
            "inputSchema": {"type": "object"},
        }));
        assert!(serde_json::from_value::<WorkflowPhaseSuspendedPayload>(wire).is_err());
    }
}

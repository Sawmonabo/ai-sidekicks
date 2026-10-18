//! A child's own controls. A child here is a provider's own helper inside a run, named by
//! `childHandle` from the daemon's parent-to-child index; a child the daemon bridges runs as its
//! own run and takes that run's verbs. The steer names the helper by its session and handle and
//! carries an idempotency key; the interrupt and the pause also carry the parent run and its
//! version comparand.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::agent::tree::{AgentTreeMember, ChildHandle};
use crate::jsonrpc::refusal::RefusalCode;
use crate::provider::driver::methods::PROVIDER_WIRE_REASON_MAX_LEN;
use crate::run::id::RunId;
use crate::run::queue::{MessageContent, QueueItemId};
use crate::run::state::RunState;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{False, Never, True};

/// Sends a message onto one child's own queue (`agent.childRun.steer`), where it waits for the
/// child's next step as a pending row the lead's queue verbs reach with `childHandle`. It names
/// the helper by its session and handle, so it reaches a helper whose parent run has ended, and it
/// answers as `agent.queueItem.create` does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunSteerRequest {
    /// The session the helper works in.
    pub session_id: SessionId,
    /// The child.
    pub child_handle: ChildHandle,
    /// The words.
    pub content: MessageContent,
    /// A retry's key is the failed steer's queue item id, so a second press answers the first.
    pub client_idempotency_key: ClientUuid,
    /// A retry of the child's steer that reads not delivered, with its own words: it goes again as
    /// a new message at the end of the child's queue, and the failed one reads `superseded`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QueueItemId")]
    pub replaces_queue_item_id: Option<QueueItemId>,
}

/// Interrupts one child, and only that child (`agent.childRun.interrupt`); its pending messages go
/// as its next turn, with `deliver_first`, the row `Send now` was pressed on, ahead of the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunInterruptRequest {
    /// The run the child belongs to.
    pub target_run_id: RunId,
    /// The child.
    pub child_handle: ChildHandle,
    /// The parent run's version the caller last observed.
    pub expected_run_version: SafeInt<0>,
    /// A retry under the same key answers what the first saved.
    pub client_idempotency_key: ClientUuid,
    /// The pending row that goes first.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QueueItemId")]
    pub deliver_first: Option<QueueItemId>,
}

/// Where the child stands after the interrupt. A child that had already finished answers the state
/// it finished in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunInterruptResponse {
    /// The child.
    pub child_handle: ChildHandle,
    /// Where it stands.
    pub state: RunState,
}

/// Pauses one child (`paused: true`) or continues it (`paused: false`)
/// (`agent.childRun.paused.update`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunPausedUpdateRequest {
    /// The run the child belongs to.
    pub target_run_id: RunId,
    /// The child.
    pub child_handle: ChildHandle,
    /// Whether to pause or continue it.
    pub paused: bool,
    /// The parent run's version the caller last observed.
    pub expected_run_version: SafeInt<0>,
    /// A retry under the same key answers what the first saved.
    pub client_idempotency_key: ClientUuid,
}

/// A child held paused after the set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct AgentChildRunPausedUpdatePaused {
    /// The child.
    pub child_handle: ChildHandle,
    /// Always `true`.
    pub paused: True,
    /// A lost hold never leaves the child paused.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub hold_lost: Option<Never>,
}

/// A child not paused after the set. `hold_lost` says the hold that paused it was gone before the
/// continue reached it (the provider canceled the held call), so the person did not release it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct AgentChildRunPausedUpdateNotPaused {
    /// The child.
    pub child_handle: ChildHandle,
    /// Always `false`.
    pub paused: False,
    /// Present only when the hold was lost.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "True")]
    pub hold_lost: Option<True>,
}

/// Where the child stands after the set; a lost hold never comes with `paused: true`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum AgentChildRunPausedUpdateResponse {
    /// Held paused.
    Paused(AgentChildRunPausedUpdatePaused),
    /// Not paused.
    NotPaused(AgentChildRunPausedUpdateNotPaused),
}

/// Stops every running child of a run at every depth (`agent.childRun.stopAll`): the daemon walks
/// its own index, one stop per child, never relayed through the lead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunStopAllRequest {
    /// The run whose children to stop.
    pub run_id: RunId,
}

/// The run state a stop leaves a child in: `stopped` where the provider's stop is final,
/// `interrupted` where a send can continue it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChildStoppedState {
    /// The provider's stop is final.
    Stopped,
    /// A send can continue it.
    Interrupted,
}

/// One child's stop: stopped, with the state it left the child in, already ended, or failed with
/// the daemon's reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChildStopOutcome {
    /// Stopped.
    Stopped {
        /// The child.
        child: AgentTreeMember,
        /// The state the stop left the child in.
        state: ChildStoppedState,
        /// Only a failed stop carries a reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        reason: Option<Never>,
    },
    /// Had already ended.
    AlreadyEnded {
        /// The child.
        child: AgentTreeMember,
        /// Only a stopped child carries the state the stop left it in.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        state: Option<Never>,
        /// Only a failed stop carries a reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        reason: Option<Never>,
    },
    /// The stop failed.
    Failed {
        /// The child.
        child: AgentTreeMember,
        /// Only a stopped child carries the state the stop left it in.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        state: Option<Never>,
        /// The daemon's reason.
        reason: FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>,
    },
}

/// Every child the stop reached, each with its own outcome; nothing is atomic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentChildRunStopAllResponse {
    /// One row per child.
    pub children: Vec<ChildStopOutcome>,
}

/// Why a child control was refused.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum AgentChildRunControlRefusedReason {
    /// The child has ended; an interrupt instead answers the state it finished in.
    ChildEnded,
    /// The provider refused the act.
    ProviderRefused,
}

ts_constants! {
    /// The refusal of a child control: the child has ended or the provider refused the act. A
    /// handle that names no child of the run is `agent.childRun.notFound`, and a hold lost before
    /// a continue is a result, never this refusal.
    AGENT_CHILD_RUN_CONTROL_REFUSED_CODE = RefusalCode::AgentChildRunControlRefused;
    /// Every reason a child control is refused.
    AGENT_CHILD_RUN_CONTROL_REFUSED_REASONS = AgentChildRunControlRefusedReason::VARIANTS;
}

/// The details an `agent.childRun.controlRefused` refusal carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentChildRunControlRefusedDetails {
    /// Why it was refused.
    pub reason: AgentChildRunControlRefusedReason,
}

/// The TypeScript module of a child's own controls.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/children",
    doc: "A child's own controls: steer, interrupt and pause one provider helper inside a run, \
          and stop every child of a run.",
    definitions: &[
        Definition::read::<AgentChildRunSteerRequest>().checked(),
        Definition::read::<AgentChildRunInterruptRequest>().checked(),
        Definition::read::<AgentChildRunInterruptResponse>().checked(),
        Definition::read::<AgentChildRunPausedUpdateRequest>().checked(),
        Definition::read::<AgentChildRunPausedUpdateResponse>().checked(),
        Definition::read::<AgentChildRunStopAllRequest>().checked(),
        Definition::read::<ChildStoppedState>(),
        Definition::read::<ChildStopOutcome>(),
        Definition::read::<AgentChildRunStopAllResponse>().checked(),
        Definition::read::<AgentChildRunControlRefusedReason>(),
        Definition::read::<AgentChildRunControlRefusedDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

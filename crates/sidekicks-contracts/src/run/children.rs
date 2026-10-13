//! A child's own controls. A child here is a provider's own helper inside a run, named by
//! `childHandle` from the daemon's parent-to-child index; a child the daemon bridges runs as its
//! own run and takes that run's verbs. Each control but the subtree stop carries the parent run's
//! version comparand and an idempotency key.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::agent::tree::{AgentTreeMember, ChildHandle};
use crate::jsonrpc::refusal::RefusalCode;
use crate::provider::driver::methods::DRIVER_WIRE_REASON_MAX_LEN;
use crate::run::id::RunId;
use crate::run::queue::{MessageContent, QueueItemId};
use crate::run::state::RunState;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{False, Never, True};

/// Sends a message onto one child's own queue (`run.childSteer`), where it waits for the child's
/// next step as a pending row the lead's queue verbs reach with `child_handle`. It answers as
/// `run.queueCreate` does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildSteerRequest {
    /// The run the child belongs to.
    pub target_run_id: RunId,
    /// The child.
    pub child_handle: ChildHandle,
    /// The words.
    pub content: MessageContent,
    /// The parent run's version the caller last observed.
    pub expected_run_version: SafeInt<0>,
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

/// Interrupts one child, and only that child (`run.childInterrupt`); its pending messages go as
/// its next turn, with `deliver_first`, the row `Send now` was pressed on, ahead of the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildInterruptRequest {
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildInterruptResponse {
    /// The child.
    pub child_handle: ChildHandle,
    /// Where it stands.
    pub state: RunState,
}

/// Pauses one child (`paused: true`) or continues it (`paused: false`) (`run.childPauseSet`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildPauseSetRequest {
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
pub struct ChildPauseSetPaused {
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
pub struct ChildPauseSetNotPaused {
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ChildPauseSetResponse {
    /// Held paused.
    Paused(ChildPauseSetPaused),
    /// Not paused.
    NotPaused(ChildPauseSetNotPaused),
}

/// Stops every running child of a run at every depth (`run.childrenStop`): the daemon walks its
/// own index, one stop per child, never relayed through the lead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildrenStopRequest {
    /// The run whose children to stop.
    pub run_id: RunId,
}

/// One child's stop: stopped, already ended, or failed with the daemon's reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChildStopOutcome {
    /// Stopped.
    Stopped {
        /// The child.
        child: AgentTreeMember,
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
        /// The daemon's reason.
        reason: FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>,
    },
}

/// Every child the stop reached, each with its own outcome; nothing is atomic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildrenStopResponse {
    /// One row per child.
    pub children: Vec<ChildStopOutcome>,
}

/// Why a child control was refused.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum RunChildControlRefusedReason {
    /// The daemon's index names no such child.
    ChildUnknown,
    /// The child has ended; an interrupt instead answers the state it finished in.
    ChildEnded,
    /// The provider refused the act.
    ProviderRefused,
}

ts_constants! {
    /// The refusal of a child control: the daemon's index names no such child, the child has
    /// ended, or the provider refused the act. A hold lost before a continue is a result, never
    /// this refusal.
    RUN_CHILD_CONTROL_REFUSED_CODE = RefusalCode::RunChildControlRefused;
    /// Every reason a child control is refused.
    RUN_CHILD_CONTROL_REFUSED_REASONS = RunChildControlRefusedReason::VARIANTS;
}

/// The details a `run.child_control_refused` refusal carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunChildControlRefusedDetails {
    /// Why it was refused.
    pub reason: RunChildControlRefusedReason,
}

/// The TypeScript module of a child's own controls.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/children",
    doc: "A child's own controls: steer, interrupt and pause one provider helper inside a run, \
          and stop every child of a run.",
    definitions: &[
        Definition::read::<ChildSteerRequest>().checked(),
        Definition::read::<ChildInterruptRequest>().checked(),
        Definition::read::<ChildInterruptResponse>().checked(),
        Definition::read::<ChildPauseSetRequest>().checked(),
        Definition::read::<ChildPauseSetResponse>().checked(),
        Definition::read::<ChildrenStopRequest>().checked(),
        Definition::read::<ChildStopOutcome>(),
        Definition::read::<ChildrenStopResponse>().checked(),
        Definition::read::<RunChildControlRefusedReason>(),
        Definition::read::<RunChildControlRefusedDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

//! The plan record and the one call that answers it. A plan turn ends with a held request on one
//! provider and a plan item on the other; the daemon turns either into one plan record the screen
//! renders (`plan.proposed`) and one call answers (`plan.resolve`), and records the outcome as
//! `plan.accepted`, `plan.handedOff` or `plan.kept` so the system messages survive a reload. A held
//! request that ends with no answer settles the plan `open` with `plan.hold.ended`. The first
//! answer settles the plan everywhere; a later answer reads back the state it settled to rather
//! than applying again.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::artifacts::id::ArtifactId;
use crate::free_form_string::FilesystemPath;
use crate::internal::branded::branded_uuid_id;
use crate::method::methods;
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::session::controls::methods::PermissionLevel;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

branded_uuid_id! {
    /// The daemon-minted id of one plan record, stable across a reload and every device.
    PlanId
}

/// Where a plan stands: `waiting` while its card is up, `accepted` after it is built here,
/// `handedOff` after it is built in a fresh session, and `open` after the person keeps planning,
/// which answers the held request and leaves the plan as a record the next plan replaces.
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
pub enum PlanState {
    /// Its card is up.
    Waiting,
    /// Being built here.
    Accepted,
    /// Being built in a fresh session.
    HandedOff,
    /// The person kept planning.
    Open,
}

/// `plan.proposed`: the plan as the agent wrote it, never read off the disk, with the daemon's
/// count of its top-level steps and the files it names, and the artifact that keeps it, written
/// before this event. `planFilePath` is present only where the provider wrote the plan as a file;
/// `holdsRequest` says a held provider request waits on the verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanProposedPayload {
    /// The plan.
    pub plan_id: PlanId,
    /// The session.
    pub session_id: SessionId,
    /// The run that proposed it.
    pub run_id: RunId,
    /// Its title.
    pub title: String,
    /// Its text.
    pub text: String,
    /// How many top-level steps it has.
    pub step_count: SafeInt<0>,
    /// How many files it names.
    pub file_count: SafeInt<0>,
    /// The file the provider wrote it to.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FilesystemPath")]
    pub plan_file_path: Option<FilesystemPath>,
    /// The artifact that keeps the plan.
    pub artifact_id: ArtifactId,
    /// Whether a held provider request waits on the verdict.
    pub holds_request: bool,
}

/// `plan.accepted`: the plan is being built in its own session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanAcceptedPayload {
    /// The plan.
    pub plan_id: PlanId,
    /// The session.
    pub session_id: SessionId,
    /// The device whose verdict it was.
    pub device_id: DeviceId,
}

/// `plan.kept`: the person kept planning; the provider went back to planning and the plan stays a
/// record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanKeptPayload {
    /// The plan.
    pub plan_id: PlanId,
    /// The session.
    pub session_id: SessionId,
    /// The device whose verdict it was.
    pub device_id: DeviceId,
}

/// Why a held plan request ended with no verdict: its turn was interrupted, the provider withdrew
/// it, or its run ended, a restart of the background service among the ways a run ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PlanHoldEndedReason {
    /// Its turn was interrupted.
    Interrupted,
    /// The provider withdrew the request.
    Withdrawn,
    /// Its run ended.
    RunEnded,
}

/// `plan.hold.ended`: the provider request a plan held ended with no verdict, so the plan settles
/// `open`; its card closes on every device and the plan stays readable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanHoldEndedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The plan.
    pub plan_id: PlanId,
    /// Why the hold ended.
    pub reason: PlanHoldEndedReason,
}

/// `plan.handedOff`: the plan seeded a fresh session, which the system message opens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanHandedOffPayload {
    /// The plan.
    pub plan_id: PlanId,
    /// The planning session.
    pub session_id: SessionId,
    /// The session it seeded.
    pub fresh_session_id: SessionId,
    /// The device whose verdict it was.
    pub device_id: DeviceId,
}

/// The session a `fresh` verdict mints: the provider it runs and the level it starts at, the
/// planning session's level or, where that provider cannot give it, one of that provider's levels
/// the person picks. The rest is the planning session's: the same project and worktree, the
/// provider's current account, and the plan as the seed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanFreshSession {
    /// The provider.
    pub provider_name: ProviderId,
    /// The level.
    pub level: PermissionLevel,
}

/// `plan.resolve`: the verdict on one plan, keep planning, build here, or build in a fresh
/// session; only `fresh` names the session to mint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "verdict",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum PlanResolveRequest {
    /// Keep planning.
    Keep {
        /// The plan.
        plan_id: PlanId,
    },
    /// Build here.
    Build {
        /// The plan.
        plan_id: PlanId,
    },
    /// Build in a fresh session.
    Fresh {
        /// The plan.
        plan_id: PlanId,
        /// The session to mint.
        fresh: PlanFreshSession,
    },
}

/// The `plan.resolve` result: the plan's state after the verdict, or the state an earlier verdict
/// settled, never `waiting`; only a handed-off plan names its fresh session, so the caller switches
/// to it without another read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum PlanResolveResponse {
    /// Being built here.
    Accepted {
        /// The plan.
        plan_id: PlanId,
    },
    /// Being built in a fresh session.
    HandedOff {
        /// The plan.
        plan_id: PlanId,
        /// The fresh session.
        fresh_session_id: SessionId,
    },
    /// The person kept planning.
    Open {
        /// The plan.
        plan_id: PlanId,
    },
}

methods! {
    /// The `plan.*` methods a client calls.
    pub const PLAN_METHOD_DESCRIPTORS = [
        /// Answers one plan.
        PlanResolve = mutation "plan.resolve" {
            mutating: true,
            params: PlanResolveRequest,
            result: PlanResolveResponse,
            refusals: [PlanNotFound, SessionPermissionLevelNotOffered],
        },
    ];
}

/// The TypeScript module of the plan record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "plan",
    doc: "The plan record and the one call that answers it.",
    definitions: &[
        Definition::read::<PlanId>().checked(),
        Definition::read::<PlanState>(),
        Definition::read::<PlanProposedPayload>().checked(),
        Definition::read::<PlanAcceptedPayload>().checked(),
        Definition::read::<PlanKeptPayload>().checked(),
        Definition::read::<PlanHoldEndedReason>(),
        Definition::read::<PlanHoldEndedPayload>().checked(),
        Definition::read::<PlanHandedOffPayload>().checked(),
        Definition::read::<PlanFreshSession>(),
        Definition::read::<PlanResolveRequest>().checked(),
        Definition::read::<PlanResolveResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&PLAN_METHOD_DESCRIPTORS],
};

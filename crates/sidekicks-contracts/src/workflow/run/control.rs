//! The acts on a workflow run: starting one, canceling and resuming it, retrying from a step,
//! running one node from the builder and posting a finished run's results into a session, with
//! their refusals and their method table.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::byte_length::fits_budget;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::project::ProjectId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::list::BoundedVec;
use crate::wire::text::{BoundedText, ComposedText, NonEmptyText};
use crate::wire::{True, literal};
use crate::workflow::definition::document::{
    WorkflowNodeId, WorkflowTriggerInput, WorkflowVersionId,
};
use crate::workflow::definition::item::WorkflowItem;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::trigger::WorkflowRunMode;

ts_constants! {
    /// The most bytes a cancellation reason may take, counted as UTF-8 bytes of its JSON encoding
    /// (quotes and escapes included), so the same sentence is not refused sooner in one script than
    /// in another.
    pub const WORKFLOW_CANCEL_REASON_BYTE_CAP: usize = 8 * 1024;
    /// What a node run covers.
    WORKFLOW_NODE_EXECUTE_SCOPES = WorkflowNodeExecuteScope::VARIANTS;
    /// Every reason a retry cannot be made.
    WORKFLOW_RETRY_UNAVAILABLE_REASONS = WorkflowRunStillRunningReason::VARIANTS;
    /// A start the policy check denied, or whose principal could not be resolved.
    WORKFLOW_START_DENIED_CODE = RefusalCode::WorkflowRunStartDenied;
    /// A start in a project session that names a project: the run works in that session's
    /// repository, so it names no other. Nothing runs.
    WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE = RefusalCode::WorkflowRunProjectOnProjectSession;
    /// A start or a node run that works in no project's repository, of a version holding a Git,
    /// Read a repo diff or Run tests step. Nothing runs.
    WORKFLOW_REPOSITORY_REQUIRED_CODE = RefusalCode::WorkflowRunRepositoryRequired;
    /// A start that leaves a required input of the workflow unfilled, or gives an input a value
    /// that does not fit it. Nothing runs.
    WORKFLOW_INPUT_REQUIRED_CODE = RefusalCode::WorkflowRunInputRequired;
    /// A start of a version whose Code steps' packages are not locked; a later save that locks them
    /// makes the version runnable. Nothing runs.
    WORKFLOW_CODE_PACKAGES_NOT_LOCKED_CODE = RefusalCode::WorkflowCodePackagesNotLocked;
    /// A cancel on a run that has ended. A failed run waiting on Resume has not ended and is
    /// canceled; a run already canceled is not refused, the cancel returns the first's outcome.
    WORKFLOW_RUN_NOT_CANCELABLE_CODE = RefusalCode::WorkflowRunNotCancelable;
    /// A resume on a run that is not waiting: there is no wait to lift.
    WORKFLOW_RESUME_NOT_PARKED_CODE = RefusalCode::WorkflowRunResumeNotParked;
    /// A version re-pin on a run that is not waiting; a going run is never re-pinned.
    WORKFLOW_REPAIR_NOT_PARKED_CODE = RefusalCode::WorkflowRunRepairNotParked;
    /// A version re-pin while one of the run's steps is still in flight.
    WORKFLOW_REPAIR_ATTEMPT_IN_FLIGHT_CODE = RefusalCode::WorkflowRunRepairAttemptInFlight;
    /// A version re-pin whose target cannot account for the steps the run already finished.
    WORKFLOW_REPAIR_VERSION_UNACCOUNTABLE_CODE = RefusalCode::WorkflowRunRepairVersionUnaccountable;
    /// A run or step move its status does not allow: retrying from a step that did not fail,
    /// posting the results of an unfinished run, or opening a fix session on a step that did not
    /// fail.
    WORKFLOW_INVALID_TRANSITION_CODE = RefusalCode::WorkflowInvalidTransition;
    /// A retry the daemon cannot make now; the reason says why.
    WORKFLOW_RETRY_UNAVAILABLE_CODE = RefusalCode::WorkflowRunStillRunning;
}

/// The most code points a cancellation reason can hold under its byte cap: its JSON takes two
/// quotes beside at least one byte for each code point.
const WORKFLOW_CANCEL_REASON_MAX_LEN: usize = WORKFLOW_CANCEL_REASON_BYTE_CAP - 2;

/// A cancellation's reason as the person typed it: non-empty, and at most
/// [`WORKFLOW_CANCEL_REASON_BYTE_CAP`] bytes as JSON, which its garde check holds. It is recorded
/// on the run and its canceled event and never reaches a step's output or anything an agent reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct WorkflowCancelReason(
    #[garde(custom(|reason: &BoundedText<1, WORKFLOW_CANCEL_REASON_MAX_LEN>, (): &()| {
        fits_budget(reason, WORKFLOW_CANCEL_REASON_BYTE_CAP)
    }))]
    BoundedText<1, WORKFLOW_CANCEL_REASON_MAX_LEN>,
);

impl WorkflowCancelReason {
    /// `reason` when it is non-empty and its JSON takes at most the cap's bytes, else `None`.
    pub fn new(reason: String) -> Option<Self> {
        let reason = Self(BoundedText::new(reason)?);
        garde::Validate::validate(&reason).is_ok().then_some(reason)
    }

    /// The reason.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl JsonSchema for WorkflowCancelReason {
    fn schema_name() -> Cow<'static, str> {
        "WorkflowCancelReason".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = BoundedText::<1, WORKFLOW_CANCEL_REASON_MAX_LEN>::json_schema(generator);
        schema.insert(
            "description".into(),
            format!(
                "A cancellation's reason as the person typed it: non-empty, and at most \
                 {WORKFLOW_CANCEL_REASON_BYTE_CAP} bytes as JSON."
            )
            .into(),
        );
        schema.insert(
            "maxJsonBytes".into(),
            WORKFLOW_CANCEL_REASON_BYTE_CAP.into(),
        );
        schema
    }
}

/// Refuses a re-pin that names one of its two versions without the other.
pub(crate) fn names_whole_repin(
    repinned_from: Option<&WorkflowVersionId>,
    repinned_to: Option<&WorkflowVersionId>,
) -> garde::Result {
    if repinned_from.is_some() == repinned_to.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "a re-pin names both the version the run left and the one it joined, or neither",
        ))
    }
}

/// The start modes a caller may ask for; `retry` and `subWorkflow` come from their own methods.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRequestableRunMode {
    /// Started by a person.
    Manual,
    /// Started by a trigger.
    Trigger,
    /// Started by a webhook call.
    Webhook,
    /// Started from a chat.
    Chat,
    /// Started by an agent.
    Agent,
}

impl From<WorkflowRequestableRunMode> for WorkflowRunMode {
    fn from(mode: WorkflowRequestableRunMode) -> Self {
        match mode {
            WorkflowRequestableRunMode::Manual => Self::Manual,
            WorkflowRequestableRunMode::Trigger => Self::Trigger,
            WorkflowRequestableRunMode::Webhook => Self::Webhook,
            WorkflowRequestableRunMode::Chat => Self::Chat,
            WorkflowRequestableRunMode::Agent => Self::Agent,
        }
    }
}

/// The `workflow.run.start` input: the caller's key, the version to run, the session it is started
/// in, the repository it works in, the items it starts on and how the start was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunStartRequest {
    /// The caller's key, kept in the command receipts: a resend under it after a reconnect answers
    /// the first start's run, never a second; the same key with a differing payload is refused.
    pub client_idempotency_key: ClientUuid,
    /// The version, taken verbatim from a definition or version read.
    pub workflow_version_id: WorkflowVersionId,
    /// The session the start was made in; absent, the run lives in the workflow's own session.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
    /// The project whose folder the run works in. A project session's run works in that session's
    /// repository and names none; absent on a chat's run, it works in the chat's folder, and
    /// absent on a start in no session, in its own empty folder.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
    /// The items the run starts on, where the workflow declares inputs: the one item's `json`
    /// object holds the filled values by input name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<WorkflowItem>")]
    #[garde(dive)]
    pub input: Option<Vec<WorkflowItem>>,
    /// How the start was made.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRequestableRunMode")]
    pub mode: Option<WorkflowRequestableRunMode>,
}

/// The status a new run can answer with: admitted but not yet dispatched, or already running.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStartStatus {
    /// Admitted, not yet dispatched.
    New,
    /// Running.
    Running,
}

/// The `workflow.run.start` result, which `workflow.run.rerun` also answers with: the new run, the
/// session it lives in, and its status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunStartResponse {
    /// The new run.
    pub workflow_run_id: WorkflowRunId,
    /// The session it lives in.
    pub session_id: SessionId,
    /// Its status.
    pub status: WorkflowRunStartStatus,
}

/// A value a start fills a declared input with: a `boolean` input's flag, any other's text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WorkflowTriggerInputValue {
    /// A `boolean` input's value.
    Flag(bool),
    /// A `string`, `path` or `select` input's value.
    Text(String),
}

/// Fills a workflow's declared inputs from a start's `input`, whose first item's `json` object
/// holds the values by input name. A value counts as filled only where it fits its input: a flag
/// for `boolean`, non-empty text for `string`, a [`FilesystemPath`] for `path`, one of the options
/// for `select`. An optional input left out or left as empty text takes
/// its `default`. Fails with the refusal's details naming every required input left unfilled and
/// every input given a value that does not fit it, in declaration order.
pub fn fill_workflow_trigger_inputs(
    declared: &[WorkflowTriggerInput],
    input: &[WorkflowItem],
) -> Result<BTreeMap<String, WorkflowTriggerInputValue>, WorkflowRunInputRequiredDetails> {
    let named = input.first().and_then(|item| item.json.0.as_object());
    let mut values = BTreeMap::new();
    let mut missing = Vec::new();
    for declared_input in declared {
        let (name, is_required, default) = match declared_input {
            WorkflowTriggerInput::Boolean {
                name,
                required,
                default,
                ..
            } => (name, required, WorkflowTriggerInputValue::Flag(*default)),
            WorkflowTriggerInput::String {
                name,
                required,
                default,
                ..
            }
            | WorkflowTriggerInput::Select {
                name,
                required,
                default,
                ..
            } => (
                name,
                required,
                WorkflowTriggerInputValue::Text(default.clone()),
            ),
            WorkflowTriggerInput::Path {
                name,
                required,
                default,
                ..
            } => (
                name,
                required,
                WorkflowTriggerInputValue::Text(default.as_str().to_owned()),
            ),
        };
        let value = named.and_then(|named| named.get(name.as_str()));
        if let Some(fitting) = value.and_then(|value| fitting_value(declared_input, value)) {
            values.insert(name.as_str().to_owned(), fitting);
        } else if *is_required != Some(true) && value.is_none_or(|value| value.as_str() == Some(""))
        {
            values.insert(name.as_str().to_owned(), default);
        } else {
            missing.push(name.clone());
        }
    }
    match BoundedVec::new(missing) {
        None => Ok(values),
        Some(input_names) => Err(WorkflowRunInputRequiredDetails { input_names }),
    }
}

/// `value` as the value of `input` where it fits it, else `None`.
fn fitting_value(
    input: &WorkflowTriggerInput,
    value: &serde_json::Value,
) -> Option<WorkflowTriggerInputValue> {
    let text = match input {
        WorkflowTriggerInput::Boolean { .. } => {
            return value.as_bool().map(WorkflowTriggerInputValue::Flag);
        }
        WorkflowTriggerInput::String { .. } => value.as_str().filter(|text| !text.is_empty()),
        WorkflowTriggerInput::Path { .. } => value
            .as_str()
            .filter(|text| FilesystemPath::new((*text).to_owned()).is_ok()),
        WorkflowTriggerInput::Select { options, .. } => value.as_str().filter(|text| {
            options
                .as_slice()
                .iter()
                .any(|option| option.as_str() == *text)
        }),
    };
    text.map(|text| WorkflowTriggerInputValue::Text(text.to_owned()))
}

/// The `workflow.run.cancel` input. `reason` is recorded on the run and carried on its canceled
/// event; it never reaches a step's output or anything an agent reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunCancelRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// The person's reason.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowCancelReason")]
    #[garde(dive)]
    pub reason: Option<WorkflowCancelReason>,
}

literal! {
    /// The one status a successful cancel answers with.
    pub enum WorkflowRunCanceledStatus = "canceled";
}

/// The `workflow.run.cancel` result. Cancel is offered on a new, running or waiting run, and on a
/// failed run parked on its failed step; `alreadyCanceled` is true when the run was already
/// canceled and this call returned the first cancel's saved result, `canceledEventId` naming the
/// original event and no second one written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunCancelResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// `canceled`.
    pub status: WorkflowRunCanceledStatus,
    /// The `workflow.run.canceled` event the cancel wrote.
    pub canceled_event_id: ComposedText,
    /// Whether the run was already canceled.
    pub already_canceled: bool,
}

/// The version a resume moves its run to, named rather than asked for as the latest, so the
/// recorded from-and-to pair is the one the person saw.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunResumeVersionRepin {
    /// The version the run joins.
    pub target_workflow_version_id: WorkflowVersionId,
}

/// The `workflow.run.resume` input. An ordinary resume omits `versionRepin` and continues on the
/// run's pinned version; only an explicit `versionRepin` moves the run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunResumeRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// The re-pin asked for.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRunResumeVersionRepin")]
    pub version_repin: Option<WorkflowRunResumeVersionRepin>,
}

/// The status a resume answers with: running, or waiting again where it reached a provider account
/// still out of quota, which is a legal outcome and not a refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunResumeStatus {
    /// Running.
    Running,
    /// Waiting again.
    Waiting,
}

/// The `workflow.run.resume` result. The two repinned ids are present only on an accepted re-pin,
/// and then both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|response: &Self, (): &()| names_whole_repin(
    response.repinned_from_workflow_version_id.as_ref(),
    response.repinned_to_workflow_version_id.as_ref(),
)))]
#[schemars(extend("type" = "object", "dependentRequired" = {
    "repinnedFromWorkflowVersionId": ["repinnedToWorkflowVersionId"],
    "repinnedToWorkflowVersionId": ["repinnedFromWorkflowVersionId"],
}))]
pub struct WorkflowRunResumeResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Its status.
    pub status: WorkflowRunResumeStatus,
    /// The version the run left, on an accepted re-pin.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowVersionId")]
    pub repinned_from_workflow_version_id: Option<WorkflowVersionId>,
    /// The version the run joined, on an accepted re-pin.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowVersionId")]
    pub repinned_to_workflow_version_id: Option<WorkflowVersionId>,
}

/// The `workflow.run.retry` input: re-run from a named step, which runs again with its descendants
/// while the source run's data stays pinned upstream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunRetryRequest {
    /// The source run.
    pub workflow_run_id: WorkflowRunId,
    /// The step to re-run from.
    pub from_node_id: WorkflowNodeId,
    /// The caller's key, kept in the command receipts: a resend under it after a reconnect answers
    /// the first retry's run, never a second; the same key with a differing payload is refused.
    pub client_idempotency_key: ClientUuid,
}

/// The `workflow.run.retry` result: a new run in `retry` mode; the source run stays readable. The
/// new run is never its own source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|response: &Self, (): &()| {
    if response.workflow_run_id == response.source_workflow_run_id {
        Err(garde::Error::new("a retry is a new run, never its own source"))
    } else {
        Ok(())
    }
}))]
pub struct WorkflowRunRetryResponse {
    /// The new run; never the source.
    #[schemars(extend(
        "type" = "string",
        "not" = { "const": { "$data": "1/sourceWorkflowRunId" } }
    ))]
    pub workflow_run_id: WorkflowRunId,
    /// The source run.
    pub source_workflow_run_id: WorkflowRunId,
    /// The new run's status.
    pub status: WorkflowRunStartStatus,
}

/// The `workflow.run.rerun` input: start a new run of the named run's own pinned version, with the
/// input and mode that run was started with, in the session it lives in. The daemon reads all
/// three from the source run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunRerunRequest {
    /// The run to re-run.
    pub workflow_run_id: WorkflowRunId,
    /// The caller's key, kept in the command receipts: a resend under it after a reconnect answers
    /// the first re-run's run, never a second; the same key with a differing payload is refused.
    pub client_idempotency_key: ClientUuid,
}

/// What a node run covers: the node alone (`Run this node`), or the node and its ancestors
/// (`Run from here`).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeExecuteScope {
    /// The node alone.
    Node,
    /// The node and its ancestors.
    FromHere,
}

/// The `workflow.node.execute` input: `Run this node` or `Run from here` on a saved version, never
/// unsaved bytes. `projectId` is the project the builder's `Repository` panel names for a node run
/// on a `chat` or `subWorkflow` trigger, absent for `None` and on every other trigger;
/// `dirtyNodeIds` is the builder's hint, and the daemon decides what it runs and reuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowNodeExecuteRequest {
    /// The saved version.
    pub workflow_version_id: WorkflowVersionId,
    /// The session the node run is started in; absent, it lives in the workflow's own session.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
    /// The project it works in, on a `chat` or `subWorkflow` trigger.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
    /// The node.
    pub node_id: WorkflowNodeId,
    /// What the run covers.
    pub scope: WorkflowNodeExecuteScope,
    /// The nodes the builder believes are dirty.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<WorkflowNodeId>")]
    pub dirty_node_ids: Option<Vec<WorkflowNodeId>>,
}

/// The `workflow.node.execute` result: the nodes the daemon ran, in order, and those it reused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowNodeExecuteResponse {
    /// The run the node run made.
    pub workflow_run_id: WorkflowRunId,
    /// The nodes executed, in execution order.
    pub executed_node_ids: Vec<WorkflowNodeId>,
    /// The nodes whose step data was reused.
    pub reused_node_ids: Vec<WorkflowNodeId>,
}

/// The `workflow.results.post` input: pull a finished run's results into the session the
/// `/workflow results` verb was typed in, which the daemon checks is the caller's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowResultsPostRequest {
    /// The finished run.
    pub workflow_run_id: WorkflowRunId,
    /// The session that asks.
    pub session_id: SessionId,
}

/// The `workflow.results.post` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowResultsPostResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Always `true`.
    pub posted: True,
}

/// The repository refusal's details: the nodes that need a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunRepositoryRequiredDetails {
    /// The nodes, at least one.
    pub node_ids: BoundedVec<WorkflowNodeId, 1, { usize::MAX }>,
}

/// The missing-input refusal's details: the inputs the start left unfilled or filled with a value
/// that does not fit, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunInputRequiredDetails {
    /// The inputs, at least one.
    pub input_names: BoundedVec<NonEmptyText, 1, { usize::MAX }>,
}

/// The unlocked-packages refusal's details: the Code nodes whose packages are not locked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCodePackagesNotLockedDetails {
    /// The nodes, at least one.
    pub node_ids: BoundedVec<WorkflowNodeId, 1, { usize::MAX }>,
}

/// Why a retry cannot be made.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStillRunningReason {
    /// The source run is still going.
    SourceRunning,
}

/// The retry refusal's details.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunStillRunningDetails {
    /// Why.
    pub reason: WorkflowRunStillRunningReason,
}

methods! {
    /// The `workflow.*` methods that act on a run.
    pub const WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS = [
        /// Starts a run of a pinned version.
        WorkflowRunStart = mutation "workflow.run.start" {
            mutating: true,
            params: WorkflowRunStartRequest,
            result: WorkflowRunStartResponse,
            refusals: [
                WorkflowVersionNotFound,
                SessionNotFound,
                WorkflowRunStartDenied,
                WorkflowRunProjectOnProjectSession,
                WorkflowRunRepositoryRequired,
                WorkflowRunInputRequired,
                WorkflowCodePackagesNotLocked,
                WorkflowRunIdempotencyConflict,
            ],
        },
        /// Cancels a run that has not ended.
        WorkflowRunCancel = mutation "workflow.run.cancel" {
            mutating: true,
            params: WorkflowRunCancelRequest,
            result: WorkflowRunCancelResponse,
            refusals: [WorkflowRunNotFound, WorkflowRunNotCancelable],
        },
        /// Resumes a waiting run, moving it to another version where a re-pin is asked for.
        WorkflowRunResume = mutation "workflow.run.resume" {
            mutating: true,
            params: WorkflowRunResumeRequest,
            result: WorkflowRunResumeResponse,
            refusals: [
                WorkflowRunNotFound,
                WorkflowRunResumeNotParked,
                WorkflowRunRepairNotParked,
                WorkflowRunRepairAttemptInFlight,
                WorkflowRunRepairVersionUnaccountable,
            ],
        },
        /// Starts a new run from a named step of a run, its upstream data pinned.
        WorkflowRunRetry = mutation "workflow.run.retry" {
            mutating: true,
            params: WorkflowRunRetryRequest,
            result: WorkflowRunRetryResponse,
            refusals: [
                WorkflowRunNotFound, WorkflowStepNotFound,
                WorkflowRunStillRunning,
                WorkflowInvalidTransition,
                WorkflowRunIdempotencyConflict,
            ],
        },
        /// Starts a new run of a run's own version, input and mode, in its session.
        WorkflowRunRerun = mutation "workflow.run.rerun" {
            mutating: true,
            params: WorkflowRunRerunRequest,
            result: WorkflowRunStartResponse,
            refusals: [WorkflowRunNotFound, WorkflowRunIdempotencyConflict],
        },
        /// Runs one node, or it and its ancestors, from the builder.
        WorkflowNodeExecute = mutation "workflow.node.execute" {
            mutating: true,
            params: WorkflowNodeExecuteRequest,
            result: WorkflowNodeExecuteResponse,
            refusals: [SessionNotFound, WorkflowVersionNotFound, WorkflowRunRepositoryRequired],
        },
        /// Posts a finished run's results into the session that asks.
        WorkflowResultsPost = mutation "workflow.results.post" {
            mutating: true,
            params: WorkflowResultsPostRequest,
            result: WorkflowResultsPostResponse,
            refusals: [SessionNotFound, WorkflowRunNotFound, WorkflowInvalidTransition],
        },
    ];
}

/// The details a `workflow.run.idempotencyConflict` refusal carries: what the key first answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunIdempotencyConflictDetails {
    /// The run the first request under the key named: a retry's or re-run's source run; absent
    /// for a start, which names none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRunId")]
    pub source_workflow_run_id: Option<WorkflowRunId>,
    /// The run the first request under the key made.
    pub workflow_run_id: WorkflowRunId,
}

/// The TypeScript module of the run control methods and their refusals.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/control",
    doc: "The acts on a workflow run: starting one, canceling and resuming it, retrying from a \
          step, running one node from the builder and posting a finished run's results into a \
          session, with their refusals and their method table.",
    definitions: &[
        Definition::read::<WorkflowCancelReason>().checked(),
        Definition::read::<WorkflowRequestableRunMode>(),
        Definition::read::<WorkflowRunStartRequest>().checked(),
        Definition::read::<WorkflowRunStartStatus>(),
        Definition::read::<WorkflowRunStartResponse>().checked(),
        Definition::read::<WorkflowRunCancelRequest>().checked(),
        Definition::read::<WorkflowRunCancelResponse>().checked(),
        Definition::read::<WorkflowRunResumeVersionRepin>(),
        Definition::read::<WorkflowRunResumeRequest>().checked(),
        Definition::read::<WorkflowRunResumeStatus>(),
        Definition::read::<WorkflowRunResumeResponse>().checked(),
        Definition::read::<WorkflowRunRetryRequest>().checked(),
        Definition::read::<WorkflowRunRetryResponse>().checked(),
        Definition::read::<WorkflowRunRerunRequest>().checked(),
        Definition::read::<WorkflowNodeExecuteScope>(),
        Definition::read::<WorkflowNodeExecuteRequest>().checked(),
        Definition::read::<WorkflowNodeExecuteResponse>().checked(),
        Definition::read::<WorkflowResultsPostRequest>().checked(),
        Definition::read::<WorkflowResultsPostResponse>().checked(),
        Definition::read::<WorkflowRunRepositoryRequiredDetails>().checked(),
        Definition::read::<WorkflowRunInputRequiredDetails>().checked(),
        Definition::read::<WorkflowCodePackagesNotLockedDetails>().checked(),
        Definition::read::<WorkflowRunStillRunningReason>(),
        Definition::read::<WorkflowRunStillRunningDetails>().checked(),
        Definition::read::<WorkflowRunIdempotencyConflictDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::fill_workflow_trigger_inputs;
    use crate::workflow::definition::document::WorkflowTriggerInput;
    use crate::workflow::definition::item::WorkflowItem;

    /// A required text input and an optional flag that starts on `true`.
    fn declared() -> Vec<WorkflowTriggerInput> {
        serde_json::from_value(json!([
            { "name": "branch", "type": "string", "required": true, "default": "" },
            { "name": "dryRun", "type": "boolean", "default": true },
        ]))
        .expect("the inputs read")
    }

    #[rstest]
    #[case::a_required_input_left_out(declared(), json!({ "dryRun": false }), Err(vec!["branch"]))]
    #[case::inputs_given_values_that_do_not_fit(
        declared(),
        json!({ "branch": 7, "dryRun": "yes" }),
        Err(vec!["branch", "dryRun"]),
    )]
    #[case::an_optional_input_left_out_takes_its_default(
        declared(),
        json!({ "branch": "main" }),
        Ok(json!({ "branch": "main", "dryRun": true })),
    )]
    #[case::every_input_filled(
        declared(),
        json!({ "branch": "main", "dryRun": false }),
        Ok(json!({ "branch": "main", "dryRun": false })),
    )]
    #[case::no_declared_inputs_on_an_empty_start(vec![], Value::Null, Ok(json!({})))]
    fn a_start_fills_the_declared_inputs_or_names_those_it_lacks(
        #[case] declared: Vec<WorkflowTriggerInput>,
        #[case] start: Value,
        #[case] expected: Result<Value, Vec<&str>>,
    ) {
        let input: Vec<WorkflowItem> = if start.is_null() {
            vec![]
        } else {
            serde_json::from_value(json!([{ "json": start }])).expect("the items read")
        };
        let filled = fill_workflow_trigger_inputs(&declared, &input)
            .map(|values| serde_json::to_value(values).expect("the values write"))
            .map_err(|details| {
                let names = details.input_names.as_slice().iter();
                names
                    .map(|name| name.as_str().to_owned())
                    .collect::<Vec<_>>()
            });
        let expected: Result<Value, Vec<String>> =
            expected.map_err(|names| names.into_iter().map(str::to_owned).collect());
        assert_eq!(filled, expected);
    }
}

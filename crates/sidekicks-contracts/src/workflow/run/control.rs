//! The acts on a workflow run: starting one, canceling and resuming it, retrying from a step,
//! running one node from the builder and posting a finished run's results into a session, with
//! their refusals, the run events they write and their method table.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::jsonrpc::byte_length::json_utf8_byte_length;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::project::ProjectId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{BoundedText, ComposedText, NonEmptyText};
use crate::wire::{True, literal};
use crate::workflow::definition::document::item::WorkflowItem;
use crate::workflow::definition::document::{
    WorkflowNodeId, WorkflowTriggerInput, WorkflowVersionId,
};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::status::WorkflowRunStatus;
use crate::workflow::run::trigger::{WorkflowRunMode, WorkflowStartedBy};

ts_constants! {
    /// The most bytes a cancellation reason may take, counted as UTF-8 bytes of its JSON encoding
    /// (quotes and escapes included), so the same sentence is not refused sooner in one script than
    /// in another.
    pub const WORKFLOW_CANCEL_REASON_BYTE_CAP: usize = 8 * 1024;
    /// What a node run covers.
    pub const WORKFLOW_NODE_EXECUTE_SCOPES: [WorkflowNodeExecuteScope; 2] =
        [WorkflowNodeExecuteScope::Node, WorkflowNodeExecuteScope::FromHere];
    /// Every reason a retry cannot be made.
    pub const WORKFLOW_RETRY_UNAVAILABLE_REASONS: [WorkflowRetryUnavailableReason; 1] =
        [WorkflowRetryUnavailableReason::SourceRunning];
    /// A start the policy check denied, or whose principal could not be resolved.
    WORKFLOW_START_DENIED_CODE = RefusalCode::WorkflowStartDenied.as_str();
    /// A start in a project session that names a project: the run works in that session's
    /// repository, so it names no other. Nothing runs.
    WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE =
        RefusalCode::WorkflowProjectOnProjectSession.as_str();
    /// A start or a node run that works in no project's repository, of a version holding a Git,
    /// Read a repo diff or Run tests step. Nothing runs.
    WORKFLOW_REPOSITORY_REQUIRED_CODE = RefusalCode::WorkflowRepositoryRequired.as_str();
    /// A start that leaves a required input of the workflow unfilled, or gives an input a value
    /// that does not fit it. Nothing runs.
    WORKFLOW_INPUT_REQUIRED_CODE = RefusalCode::WorkflowInputRequired.as_str();
    /// A start of a version whose Code steps' packages are not locked; a later save that locks them
    /// makes the version runnable. Nothing runs.
    WORKFLOW_CODE_PACKAGES_NOT_LOCKED_CODE = RefusalCode::WorkflowCodePackagesNotLocked.as_str();
    /// A cancel on a run that has ended. A failed run waiting on Resume has not ended and is
    /// canceled; a run already canceled is not refused, the cancel returns the first's outcome.
    WORKFLOW_RUN_NOT_CANCELABLE_CODE = RefusalCode::WorkflowRunNotCancelable.as_str();
    /// A resume on a run that is not waiting: there is no wait to lift.
    WORKFLOW_RESUME_NOT_PARKED_CODE = RefusalCode::WorkflowResumeNotParked.as_str();
    /// A version re-pin on a run that is not waiting; a going run is never re-pinned.
    WORKFLOW_REPAIR_NOT_PARKED_CODE = RefusalCode::WorkflowRepairNotParked.as_str();
    /// A version re-pin while one of the run's steps is still in flight.
    WORKFLOW_REPAIR_ATTEMPT_IN_FLIGHT_CODE = RefusalCode::WorkflowRepairAttemptInFlight.as_str();
    /// A version re-pin whose target cannot account for the steps the run already finished.
    WORKFLOW_REPAIR_VERSION_UNACCOUNTABLE_CODE =
        RefusalCode::WorkflowRepairVersionUnaccountable.as_str();
    /// A run or step move its status does not allow: retrying from a step that did not fail,
    /// posting the results of an unfinished run, or opening a fix session on a step that did not
    /// fail.
    WORKFLOW_INVALID_TRANSITION_CODE = RefusalCode::WorkflowInvalidTransition.as_str();
    /// A retry the daemon cannot make now; the reason says why.
    WORKFLOW_RETRY_UNAVAILABLE_CODE = RefusalCode::WorkflowRetryUnavailable.as_str();
}

/// A cancellation's reason as the person typed it: non-empty, and at most
/// [`WORKFLOW_CANCEL_REASON_BYTE_CAP`] bytes as JSON. It is recorded on the run and its canceled
/// event and never reaches a step's output or anything an agent reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct WorkflowCancelReason(BoundedText<1, WORKFLOW_CANCEL_REASON_BYTE_CAP>);

impl WorkflowCancelReason {
    /// `reason` when it is non-empty and its JSON takes at most the cap's bytes, else `None`.
    pub fn new(reason: String) -> Option<Self> {
        let reason = BoundedText::new(reason)?;
        let byte_length = json_utf8_byte_length(&reason.as_str()).ok()?;
        (byte_length <= WORKFLOW_CANCEL_REASON_BYTE_CAP).then_some(Self(reason))
    }

    /// The reason.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for WorkflowCancelReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "a cancellation reason is non-empty and at most {WORKFLOW_CANCEL_REASON_BYTE_CAP} \
                 bytes as JSON"
            ))
        })
    }
}

impl JsonSchema for WorkflowCancelReason {
    fn schema_name() -> Cow<'static, str> {
        "WorkflowCancelReason".into()
    }

    // The byte cap is checked where the reason is read; the schema states the code-point bound it
    // implies, since every code point takes at least one byte.
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = BoundedText::<1, WORKFLOW_CANCEL_REASON_BYTE_CAP>::json_schema(generator);
        schema.insert(
            "description".into(),
            format!(
                "A cancellation's reason as the person typed it: non-empty, and at most \
                 {WORKFLOW_CANCEL_REASON_BYTE_CAP} bytes as JSON."
            )
            .into(),
        );
        schema
    }
}

/// Refuses a re-pin that names one of its two versions without the other.
fn names_whole_repin(
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

/// The start modes a caller may ask for; `retry` and `sub-workflow` come from their own methods.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
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

/// The `workflow.runStart` input: the version to run, the session it is started in, the
/// repository it works in, the items it starts on and how the start was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunStartRequest {
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
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStartStatus {
    /// Admitted, not yet dispatched.
    New,
    /// Running.
    Running,
}

impl From<WorkflowRunStartStatus> for WorkflowRunStatus {
    fn from(status: WorkflowRunStartStatus) -> Self {
        match status {
            WorkflowRunStartStatus::New => Self::New,
            WorkflowRunStartStatus::Running => Self::Running,
        }
    }
}

/// The `workflow.runStart` result, which `workflow.runRerun` also answers with: the new run, the
/// session it lives in, and its status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
/// for `boolean`, non-empty text for `string` and `path` (a path within [`FILE_PATH_MAX_LEN`] code
/// points), one of the options for `select`. An optional input left out or left as empty text takes
/// its `default`. Fails with the refusal's details naming every required input left unfilled and
/// every input given a value that does not fit it, in declaration order.
pub fn fill_workflow_trigger_inputs(
    declared: &[WorkflowTriggerInput],
    input: &[WorkflowItem],
) -> Result<BTreeMap<String, WorkflowTriggerInputValue>, WorkflowInputRequiredDetails> {
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
        Some(input_names) => Err(WorkflowInputRequiredDetails { input_names }),
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
            .filter(|text| !text.is_empty() && text.chars().count() <= FILE_PATH_MAX_LEN),
        WorkflowTriggerInput::Select { options, .. } => value.as_str().filter(|text| {
            options
                .as_slice()
                .iter()
                .any(|option| option.as_str() == *text)
        }),
    };
    text.map(|text| WorkflowTriggerInputValue::Text(text.to_owned()))
}

/// The `workflow.runCancel` input. `reason` is recorded on the run and carried on its canceled
/// event; it never reaches a step's output or anything an agent reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    pub reason: Option<WorkflowCancelReason>,
}

literal! {
    /// The one status a successful cancel answers with.
    pub enum WorkflowRunCanceledStatus = "canceled";
}

/// The `workflow.runCancel` result. Cancel is offered on a new, running or waiting run, and on a
/// failed run parked on its failed step; `alreadyCanceled` is true when the run was already
/// canceled and this call returned the first cancel's saved result, `canceledEventId` naming the
/// original event and no second one written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunCancelResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// `canceled`.
    pub status: WorkflowRunCanceledStatus,
    /// The `workflow.canceled` event the cancel wrote.
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

/// The `workflow.runResume` input. An ordinary resume omits `versionRepin` and continues on the
/// run's pinned version; only an explicit `versionRepin` moves the run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunResumeStatus {
    /// Running.
    Running,
    /// Waiting again.
    Waiting,
}

impl From<WorkflowRunResumeStatus> for WorkflowRunStatus {
    fn from(status: WorkflowRunResumeStatus) -> Self {
        match status {
            WorkflowRunResumeStatus::Running => Self::Running,
            WorkflowRunResumeStatus::Waiting => Self::Waiting,
        }
    }
}

/// The `workflow.runResume` result. The two repinned ids are present only on an accepted re-pin,
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

/// The `workflow.runRetry` input: re-run from a named step, which runs again with its descendants
/// while the source run's data stays pinned upstream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunRetryRequest {
    /// The source run.
    pub workflow_run_id: WorkflowRunId,
    /// The step to re-run from.
    pub from_node_id: WorkflowNodeId,
}

/// Refuses a retry that answers with its own source run.
fn is_a_new_run(response: &WorkflowRunRetryResponse, (): &()) -> garde::Result {
    if response.workflow_run_id == response.source_workflow_run_id {
        Err(garde::Error::new(
            "a retry is a new run, never its own source",
        ))
    } else {
        Ok(())
    }
}

/// The `workflow.runRetry` result: a new run in `retry` mode; the source run stays readable. The
/// new run is never its own source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(is_a_new_run))]
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

/// The `workflow.runRerun` input: start a new run of the named run's own pinned version, with the
/// input and mode that run was started with, in the session it lives in. The daemon reads all
/// three from the source run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunRerunRequest {
    /// The run to re-run.
    pub workflow_run_id: WorkflowRunId,
}

/// What a node run covers: the node alone (`Run this node`), or the node and its ancestors
/// (`Run from here`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeExecuteScope {
    /// The node alone.
    Node,
    /// The node and its ancestors.
    FromHere,
}

/// The `workflow.nodeExecute` input: `Run this node` or `Run from here` on a saved version, never
/// unsaved bytes. `projectId` is the project the builder's `Repository` panel names for a node run
/// on a `chat` or `sub-workflow` trigger, absent for `None` and on every other trigger;
/// `dirtyNodeIds` is the builder's hint, and the daemon decides what it runs and reuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// The project it works in, on a `chat` or `sub-workflow` trigger.
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

/// The `workflow.nodeExecute` result: the nodes the daemon ran, in order, and those it reused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeExecuteResponse {
    /// The run the node run made.
    pub workflow_run_id: WorkflowRunId,
    /// The nodes executed, in execution order.
    pub executed_node_ids: Vec<WorkflowNodeId>,
    /// The nodes whose step data was reused.
    pub reused_node_ids: Vec<WorkflowNodeId>,
}

/// The `workflow.resultsPost` input: pull a finished run's results into the session the
/// `/workflow results` verb was typed in, which the daemon checks is the caller's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResultsPostRequest {
    /// The finished run.
    pub workflow_run_id: WorkflowRunId,
    /// The session that asks.
    pub session_id: SessionId,
}

/// The `workflow.resultsPost` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResultsPostResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Always `true`.
    pub posted: True,
}

/// The repository refusal's details: the nodes that need a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRepositoryRequiredDetails {
    /// The nodes, at least one.
    pub node_ids: BoundedVec<WorkflowNodeId, 1, { usize::MAX }>,
}

/// The missing-input refusal's details: the inputs the start left unfilled or filled with a value
/// that does not fit, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowInputRequiredDetails {
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRetryUnavailableReason {
    /// The source run is still going.
    SourceRunning,
}

/// The retry refusal's details.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRetryUnavailableDetails {
    /// Why.
    pub reason: WorkflowRetryUnavailableReason,
}

/// Declares a run event's payload struct: the run it names (its session, its id, and the
/// definition and version it pins), then the payload's own members.
macro_rules! workflow_run_event {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($members:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The session the run lives in.
            pub session_id: $crate::session::id::SessionId,
            /// The run.
            pub workflow_run_id: $crate::workflow::run::id::WorkflowRunId,
            /// The definition it came from.
            pub definition_id: $crate::workflow::definition::document::WorkflowDefinitionId,
            /// The version it pins.
            pub workflow_version_id: $crate::workflow::definition::document::WorkflowVersionId,
            $($members)*
        }
    };
}

pub(crate) use workflow_run_event;

workflow_run_event! {
    /// `workflow.started`: how the run was started and by whom, so the run row rebuilds from
    /// events.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowStartedPayload {
        /// How it was started.
        pub mode: WorkflowRunMode,
        /// Who or what started it.
        pub started_by: WorkflowStartedBy,
    }
}

workflow_run_event! {
    /// `workflow.canceled`, written with the status in one step, so rebuilding the run from the log
    /// cannot bring a canceled run back. `reason` is the person's, when one was given; a chain's
    /// `Stop them all` cancels with none.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowCanceledPayload {
        /// The person's reason.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowCancelReason")]
        pub reason: Option<WorkflowCancelReason>,
    }
}

workflow_run_event! {
    /// `workflow.run_deleted`, written with the delete of the run's rows in one step, so rebuilding
    /// the runs from the log leaves out a run the person deleted, whose earlier events the log
    /// keeps.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowRunDeletedPayload {}
}

/// One step a resumed run picks up, by its node, its attempt and which execution of the node.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResumedStep {
    /// The node.
    pub node_id: WorkflowNodeId,
    /// Which attempt at the step, counted from 1.
    pub attempt: SafeInt<1>,
    /// Which execution of the node.
    pub execution_index: SafeInt<0>,
}

/// Where a resumed run picks up, so a reader rebuilds it without replaying the run's whole history:
/// the steps going on and the approval steps still waiting for an answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResumptionPoint {
    /// The steps going on.
    pub active_steps: Vec<WorkflowResumedStep>,
    /// The approval steps still waiting for an answer.
    pub pending_gates: Vec<WorkflowNodeId>,
}

workflow_run_event! {
    /// `workflow.resumed`: a person or an armed schedule resumed a waiting or failed run, with
    /// where it picks up and, only on an accepted re-pin, the version it left and the one it
    /// joined, both or neither.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    #[garde(custom(|payload: &Self, (): &()| names_whole_repin(
        payload.repinned_from_workflow_version_id.as_ref(),
        payload.repinned_to_workflow_version_id.as_ref(),
    )))]
    #[schemars(extend("type" = "object", "dependentRequired" = {
        "repinnedFromWorkflowVersionId": ["repinnedToWorkflowVersionId"],
        "repinnedToWorkflowVersionId": ["repinnedFromWorkflowVersionId"],
    }))]
    pub struct WorkflowResumedPayload {
        /// Where it picks up.
        pub resumption_point: WorkflowResumptionPoint,
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
}

/// `workflow.results_posted`: a finished run's results landed as the results row in `sessionId`,
/// the session that asked. It follows the run's final status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowResultsPostedPayload {
    /// The session that asked.
    pub session_id: SessionId,
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

methods! {
    /// The `workflow.*` methods that act on a run.
    pub const WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS = [
        /// Starts a run of a pinned version.
        WorkflowRunStart = mutation "workflow.runStart" {
            mutating: true,
            params: WorkflowRunStartRequest,
            result: WorkflowRunStartResponse,
            refusals: [
                WorkflowNotFound,
                SessionNotFound,
                WorkflowStartDenied,
                WorkflowProjectOnProjectSession,
                WorkflowRepositoryRequired,
                WorkflowInputRequired,
                WorkflowCodePackagesNotLocked,
            ],
        },
        /// Cancels a run that has not ended.
        WorkflowRunCancel = mutation "workflow.runCancel" {
            mutating: true,
            params: WorkflowRunCancelRequest,
            result: WorkflowRunCancelResponse,
            refusals: [WorkflowNotFound, WorkflowRunNotCancelable],
        },
        /// Resumes a waiting run, moving it to another version where a re-pin is asked for.
        WorkflowRunResume = mutation "workflow.runResume" {
            mutating: true,
            params: WorkflowRunResumeRequest,
            result: WorkflowRunResumeResponse,
            refusals: [
                WorkflowNotFound,
                WorkflowResumeNotParked,
                WorkflowRepairNotParked,
                WorkflowRepairAttemptInFlight,
                WorkflowRepairVersionUnaccountable,
            ],
        },
        /// Starts a new run from a named step of a run, its upstream data pinned.
        WorkflowRunRetry = mutation "workflow.runRetry" {
            mutating: true,
            params: WorkflowRunRetryRequest,
            result: WorkflowRunRetryResponse,
            refusals: [WorkflowNotFound, WorkflowRetryUnavailable, WorkflowInvalidTransition],
        },
        /// Starts a new run of a run's own version, input and mode, in its session.
        WorkflowRunRerun = mutation "workflow.runRerun" {
            mutating: true,
            params: WorkflowRunRerunRequest,
            result: WorkflowRunStartResponse,
            refusals: [WorkflowNotFound],
        },
        /// Runs one node, or it and its ancestors, from the builder.
        WorkflowNodeExecute = mutation "workflow.nodeExecute" {
            mutating: true,
            params: WorkflowNodeExecuteRequest,
            result: WorkflowNodeExecuteResponse,
            refusals: [WorkflowNotFound, WorkflowRepositoryRequired],
        },
        /// Posts a finished run's results into the session that asks.
        WorkflowResultsPost = mutation "workflow.resultsPost" {
            mutating: true,
            params: WorkflowResultsPostRequest,
            result: WorkflowResultsPostResponse,
            refusals: [WorkflowNotFound, WorkflowInvalidTransition],
        },
    ];
}

/// The TypeScript module of the run control methods, their refusals and the run events.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/control",
    doc: "The acts on a workflow run: starting one, canceling and resuming it, retrying from a \
          step, running one node from the builder and posting a finished run's results into a \
          session, with their refusals, the run events they write and their method table.",
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
        Definition::read::<WorkflowRepositoryRequiredDetails>().checked(),
        Definition::read::<WorkflowInputRequiredDetails>().checked(),
        Definition::read::<WorkflowCodePackagesNotLockedDetails>().checked(),
        Definition::read::<WorkflowRetryUnavailableReason>(),
        Definition::read::<WorkflowRetryUnavailableDetails>().checked(),
        Definition::read::<WorkflowStartedPayload>().checked(),
        Definition::read::<WorkflowCanceledPayload>().checked(),
        Definition::read::<WorkflowRunDeletedPayload>().checked(),
        Definition::read::<WorkflowResumedStep>(),
        Definition::read::<WorkflowResumptionPoint>(),
        Definition::read::<WorkflowResumedPayload>().checked(),
        Definition::read::<WorkflowResultsPostedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS],
};

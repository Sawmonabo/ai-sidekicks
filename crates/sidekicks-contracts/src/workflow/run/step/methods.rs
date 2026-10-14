//! The `workflow.*` methods on one step: reading its input, output or log, storing what one of its
//! panel's tabs holds as an artifact, the agent and human steps' saved outputs, answering an
//! approval step or a chain's question, loading, saving and submitting a waiting form, and opening
//! a fix session on a failed step, with their refusals and their method table.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::approval::ApprovalDecision;
use crate::artifacts::id::ArtifactId;
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::record::JsonRecord;
use crate::wire::text::{ComposedText, NonEmptyText, branded_text};
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::kind::WorkflowParamSpec;
use crate::workflow::run::gate_resolution::WorkflowGateResolutionId;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::status::WorkflowStepStatus;
use crate::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey, workflow_step_key};

ts_constants! {
    /// A step panel's tabs, in the order the panel shows them: its three payloads, then its cost
    /// and its error.
    WORKFLOW_STEP_TABS = WorkflowStepTab::VARIANTS;
    /// An approval answered, a form read or a form submitted on a step that is no longer waiting,
    /// an answer after the step's `Timeout` passed included, even before its timer has run; also a
    /// chain's question answered once it is no longer open.
    WORKFLOW_STEP_NOT_WAITING_CODE = RefusalCode::WorkflowStepNotWaiting;
    /// A form draft save or a form submit carrying a revision that is no longer current.
    WORKFLOW_REVISION_STALE_CODE = RefusalCode::WorkflowRevisionStale;
}

/// One tab of a step's panel: its input, output or log, its cost or its error.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepTab {
    /// The items the step ran on.
    Input,
    /// The items it produced.
    Output,
    /// Its log.
    Log,
    /// What it cost.
    Cost,
    /// Its error.
    Error,
}

/// Which of a step's three payloads a read returns: the tabs that hold items.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepPayloadKind {
    /// The items the step ran on.
    Input,
    /// The items it produced.
    Output,
    /// Its log.
    Log,
}

impl From<WorkflowStepPayloadKind> for WorkflowStepTab {
    fn from(kind: WorkflowStepPayloadKind) -> Self {
        match kind {
            WorkflowStepPayloadKind::Input => Self::Input,
            WorkflowStepPayloadKind::Output => Self::Output,
            WorkflowStepPayloadKind::Log => Self::Log,
        }
    }
}

/// The longest `workflow.stepRead` cursor accepted; a guard against pathological lengths.
const WORKFLOW_STEP_READ_CURSOR_MAX_LEN: usize = 256;

branded_text! {
    /// Where the next page of a step's payload starts. The daemon writes it and owns its format; a
    /// client passes it back unchanged with the same step and payload.
    pub struct WorkflowStepReadCursor(1..=WORKFLOW_STEP_READ_CURSOR_MAX_LEN);
}

workflow_step_key! {
    /// The `workflow.stepRead` input: one step's input, output or log, paged. Every secret value
    /// was redacted before the payload was written, so a read never returns one.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepReadRequest {
        /// Which payload.
        pub which: WorkflowStepPayloadKind,
        /// The most items on one page.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<1>")]
        pub limit: Option<SafeInt<1>>,
        /// Continue from this cursor, the previous page's `nextCursor`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepReadCursor")]
        pub cursor: Option<WorkflowStepReadCursor>,
    }
}

/// The `workflow.stepRead` result: the payload inline or as an artifact reference, with a cursor
/// while more remains.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepReadResponse {
    /// The step's node.
    pub node_id: WorkflowNodeId,
    /// Which execution of the node.
    pub execution_index: SafeInt<0>,
    /// Which payload.
    pub which: WorkflowStepPayloadKind,
    /// The payload's page.
    #[garde(dive)]
    pub payload: WorkflowPayloadRef,
    /// Where the next page starts; absent on the last.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowStepReadCursor")]
    pub next_cursor: Option<WorkflowStepReadCursor>,
}

workflow_step_key! {
    /// The `workflow.stepTabArtifactCreate` input: the step-panel tab whose content is stored as an
    /// artifact of the run's session, for the tab's `Open as artifact`.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowStepTabArtifactCreateRequest {
        /// The tab.
        pub which: WorkflowStepTab,
    }
}

/// The `workflow.stepTabArtifactCreate` result: the stored artifact's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepTabArtifactCreateResponse {
    /// The artifact.
    pub artifact_id: ArtifactId,
}

/// The `workflow.stepOutputList` input: the run whose agent and human steps' outputs are listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepOutputListRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

/// One saved output of a finished step: its summary and, for an artifact, the artifact's id. An
/// `artifact_ref` output points at a stored artifact and never carries its bytes; an `inline`
/// output carries no artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "valueKind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum WorkflowStepOutput {
    /// An output carried in the step's record.
    Inline {
        /// What it holds.
        summary: String,
        /// When the step produced it.
        #[garde(dive)]
        produced_at: WireInstant,
    },
    /// An output stored as an artifact.
    ArtifactRef {
        /// The artifact.
        artifact_id: ArtifactId,
        /// What it holds.
        summary: String,
        /// When the step produced it.
        #[garde(dive)]
        produced_at: WireInstant,
    },
}

/// The status of a step whose outputs are listed: it finished, succeeded or failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowStepOutputStatus {
    /// Done.
    Succeeded,
    /// Failed.
    Failed,
}

impl From<WorkflowStepOutputStatus> for WorkflowStepStatus {
    fn from(status: WorkflowStepOutputStatus) -> Self {
        match status {
            WorkflowStepOutputStatus::Succeeded => Self::Succeeded,
            WorkflowStepOutputStatus::Failed => Self::Failed,
        }
    }
}

/// One finished agent or human step and its saved outputs. `status` is the step's, not the run's;
/// a retry adds steps and never rewrites one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepOutputs {
    /// The step's node.
    pub node_id: WorkflowNodeId,
    /// Which execution of the node.
    pub execution_index: SafeInt<0>,
    /// How the step finished.
    pub status: WorkflowStepOutputStatus,
    /// Its saved outputs.
    #[garde(dive)]
    pub outputs: Vec<WorkflowStepOutput>,
}

/// The `workflow.stepOutputList` result: summaries and artifact references only. One step's full
/// input, output or log comes from `workflow.stepRead`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepOutputListResponse {
    /// The finished agent and human steps.
    #[garde(dive)]
    pub steps: Vec<WorkflowStepOutputs>,
}

/// The `workflow.gateResolve` input: the person's answer to an approval step, named by `nodeId`,
/// or to the question a chain raises on its first run, which names no node: `approved` keeps the
/// chain going and `rejected` stops every run of it. The answer goes through the approvals pipeline
/// and its policy check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowGateResolveRequest {
    /// The run; for a chain's question, the chain's first run.
    pub workflow_run_id: WorkflowRunId,
    /// The approval step answered; absent for a chain's question.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowNodeId")]
    pub node_id: Option<WorkflowNodeId>,
    /// The answer.
    pub decision: ApprovalDecision,
    /// The person's words with it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub feedback: Option<NonEmptyText>,
}

/// The `workflow.gateResolve` result: the answer's entry in the run's approval record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowGateResolveResponse {
    /// The answer's record, which the `workflow.gate_resolved` event names.
    pub gate_resolution_id: WorkflowGateResolutionId,
    /// When the answer was recorded, which the step panel's receipt reads.
    #[garde(dive)]
    pub decided_at: WireInstant,
}

/// What the person has typed into a waiting form so far, held by the daemon so a reload keeps it.
/// `revision` counts draft saves and guards only them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowHumanFormDraft {
    /// The form's values as typed.
    pub form_state: JsonRecord,
    /// The draft's revision, counted from 1.
    pub revision: SafeInt<1>,
    /// When it was saved.
    #[garde(dive)]
    pub saved_at: WireInstant,
}

/// The `workflow.humanFormRead` result: the node's prompt, its fields (the same parameter specs the
/// inspector's form draws), the draft saved so far, and `formRevision`, the token a submit carries
/// back: 0 while the step has no accepted answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowHumanFormReadResponse {
    /// What the form asks.
    pub prompt: ComposedText,
    /// Its fields.
    pub fields: Vec<WorkflowParamSpec>,
    /// The revision a submit carries back.
    pub form_revision: SafeInt<0>,
    /// The draft saved so far.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowHumanFormDraft")]
    #[garde(dive)]
    pub draft: Option<WorkflowHumanFormDraft>,
}

workflow_step_key! {
    /// The `workflow.humanFormDraftSave` input: the form as it is typed. With `expectedRevision`, a
    /// save over a newer draft is refused rather than overwriting it.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowHumanFormDraftSaveRequest {
        /// The form's values as typed.
        pub form_state: JsonRecord,
        /// The draft revision the save was typed over.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<1>")]
        pub expected_revision: Option<SafeInt<1>>,
    }
}

/// The `workflow.humanFormDraftSave` result: the draft's new revision and when it was saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowHumanFormDraftSaveResponse {
    /// The draft's new revision.
    pub revision: SafeInt<1>,
    /// When it was saved.
    #[garde(dive)]
    pub saved_at: WireInstant,
}

/// One `path` field's answer: the field, by its dotted place in the form (`parent.child`, or
/// `parent.0.child` inside a repeating collection), and the path picked with the platform's own
/// chooser. It sits beside `fields`, never in it, so the page's file token for the path is found at
/// one fixed member whatever the form holds; a `json` answer can hold any key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowHumanFormPathAnswer {
    /// The field's dotted place in the form.
    pub field: NonEmptyText,
    /// The path picked.
    pub path: FilesystemPath,
}

/// The `path` fields' answers, no two for one field.
type WorkflowHumanFormPathAnswers = UniqueList<WorkflowHumanFormPathAnswer, 0, { usize::MAX }>;

impl ListKey for WorkflowHumanFormPathAnswer {
    type Key = String;

    fn list_key(&self) -> String {
        self.field.as_str().to_owned()
    }
}

workflow_step_key! {
    /// The `workflow.humanFormSubmit` input: every answer is in `fields` but a `path` field's, in
    /// `paths` at most once per field, and a form has no artifact field. `expectedRevision` is the
    /// form's revision when read; a stale one is refused and never overwrites an accepted answer.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[garde(allow_unvalidated)]
    pub struct WorkflowHumanFormSubmitRequest {
        /// The answers by field, a `path` field's aside.
        pub fields: JsonRecord,
        /// The `path` fields' answers, one per field at most.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowHumanFormPathAnswers")]
        #[garde(dive)]
        pub paths: Option<WorkflowHumanFormPathAnswers>,
        /// The form's revision when it was read.
        pub expected_revision: SafeInt<0>,
    }
}

/// The `workflow.humanFormSubmit` result: when the answer was accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowHumanFormSubmitResponse {
    /// When the answer was accepted.
    #[garde(dive)]
    pub submitted_at: WireInstant,
}

/// The `workflow.fixSessionCreate` result: the fix session, opened on the failed step's own project
/// and checkout and seeded with the step; the step's own record receives nothing, and the run links
/// the new session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowFixSessionCreateResponse {
    /// The new session.
    pub session_id: SessionId,
}

methods! {
    /// The `workflow.*` methods on one step.
    pub const WORKFLOW_STEP_METHOD_DESCRIPTORS = [
        /// Reads one step's input, output or log, paged.
        WorkflowStepRead = query "workflow.stepRead" {
            mutating: false,
            params: WorkflowStepReadRequest,
            result: WorkflowStepReadResponse,
            refusals: [WorkflowNotFound, WorkflowCursorUnresolvable],
        },
        /// Stores what one step-panel tab holds as an artifact of the run's session.
        WorkflowStepTabArtifactCreate = mutation "workflow.stepTabArtifactCreate" {
            mutating: true,
            params: WorkflowStepTabArtifactCreateRequest,
            result: WorkflowStepTabArtifactCreateResponse,
            refusals: [WorkflowNotFound],
        },
        /// Lists a run's agent and human steps' saved outputs.
        WorkflowStepOutputList = query "workflow.stepOutputList" {
            mutating: false,
            params: WorkflowStepOutputListRequest,
            result: WorkflowStepOutputListResponse,
            refusals: [WorkflowNotFound],
        },
        /// Answers an approval step or a chain's question.
        WorkflowGateResolve = mutation "workflow.gateResolve" {
            mutating: true,
            params: WorkflowGateResolveRequest,
            result: WorkflowGateResolveResponse,
            refusals: [WorkflowNotFound, WorkflowStepNotWaiting],
        },
        /// Reads a waiting form: its prompt, fields, saved draft and submit revision.
        WorkflowHumanFormRead = query "workflow.humanFormRead" {
            mutating: false,
            params: WorkflowStepKey,
            result: WorkflowHumanFormReadResponse,
            refusals: [WorkflowNotFound, WorkflowStepNotWaiting],
        },
        /// Saves a waiting form's draft as it is typed.
        WorkflowHumanFormDraftSave = mutation "workflow.humanFormDraftSave" {
            mutating: true,
            params: WorkflowHumanFormDraftSaveRequest,
            result: WorkflowHumanFormDraftSaveResponse,
            refusals: [WorkflowNotFound, WorkflowRevisionStale],
        },
        /// Submits a waiting form against the revision it was read at.
        WorkflowHumanFormSubmit = mutation "workflow.humanFormSubmit" {
            mutating: true,
            params: WorkflowHumanFormSubmitRequest,
            result: WorkflowHumanFormSubmitResponse,
            refusals: [WorkflowNotFound, WorkflowRevisionStale, WorkflowStepNotWaiting],
        },
        /// Opens a new session to fix a failed step, which the run links to.
        WorkflowFixSessionCreate = mutation "workflow.fixSessionCreate" {
            mutating: true,
            params: WorkflowStepKey,
            result: WorkflowFixSessionCreateResponse,
            refusals: [WorkflowNotFound, WorkflowInvalidTransition],
        },
    ];
}

/// The TypeScript module of the methods on one step.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/step/methods",
    doc: "The `workflow.*` methods on one step: reading its input, output or log, storing what one \
          of its panel's tabs holds as an artifact, the agent and human steps' saved outputs, \
          answering an approval step or a chain's question, loading, saving and submitting a \
          waiting form, and opening a fix session on a failed step, with their refusals and their \
          method table.",
    definitions: &[
        Definition::read::<WorkflowStepTab>(),
        Definition::read::<WorkflowStepPayloadKind>(),
        Definition::read::<WorkflowStepReadCursor>(),
        Definition::read::<WorkflowStepReadRequest>().checked(),
        Definition::read::<WorkflowStepReadResponse>().checked(),
        Definition::read::<WorkflowStepTabArtifactCreateRequest>().checked(),
        Definition::read::<WorkflowStepTabArtifactCreateResponse>().checked(),
        Definition::read::<WorkflowStepOutputListRequest>().checked(),
        Definition::read::<WorkflowStepOutput>(),
        Definition::read::<WorkflowStepOutputStatus>(),
        Definition::read::<WorkflowStepOutputs>(),
        Definition::read::<WorkflowStepOutputListResponse>().checked(),
        Definition::read::<WorkflowGateResolveRequest>().checked(),
        Definition::read::<WorkflowGateResolveResponse>().checked(),
        Definition::read::<WorkflowHumanFormDraft>(),
        Definition::read::<WorkflowHumanFormReadResponse>().checked(),
        Definition::read::<WorkflowHumanFormDraftSaveRequest>().checked(),
        Definition::read::<WorkflowHumanFormDraftSaveResponse>().checked(),
        Definition::read::<WorkflowHumanFormPathAnswer>(),
        Definition::read::<WorkflowHumanFormSubmitRequest>().checked(),
        Definition::read::<WorkflowHumanFormSubmitResponse>().checked(),
        Definition::read::<WorkflowFixSessionCreateResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_STEP_METHOD_DESCRIPTORS],
};

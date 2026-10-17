//! The `workflow.*` reads over a definition's saved versions: one version, the chain a run's pinned
//! version belongs to, and the difference between two versions, with the refusal a diff of two
//! workflows answers with. The definition methods' table lists these methods.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowDocument, WorkflowEdge, WorkflowNode,
    WorkflowTriggerNode, WorkflowVersionId,
};

// workflow.version.read and workflow.version.list

/// The `workflow.version.read` input: a version is addressed by its definition and number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionReadRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number, counted from 1.
    pub version_number: SafeInt<1>,
}

/// The `workflow.version.read` result: one saved version, which never changes. A soft-deleted
/// definition's versions still read, because a run pins its version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionReadResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number.
    pub version_number: SafeInt<1>,
    /// The version's id, the one a run start takes.
    pub workflow_version_id: WorkflowVersionId,
    /// The hash of its hashed body.
    pub content_hash: WorkflowContentHash,
    /// The document.
    #[garde(dive)]
    pub document: WorkflowDocument,
    /// When it was saved.
    #[garde(dive)]
    pub created_at: WireInstant,
}

/// The `workflow.version.list` input, keyed by a version id alone. A run holds only its pinned
/// version id, and a run whose definition was deleted still opens, so this read works from that
/// one handle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionChainReadRequest {
    /// A version of the chain.
    pub workflow_version_id: WorkflowVersionId,
}

/// Who saved a version: the person, or the agent that did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowVersionSavedBy {
    /// The person.
    User {
        /// Never present: the person is no agent.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        agent_id: Option<Never>,
    },
    /// An agent.
    Agent {
        /// The agent.
        agent_id: AgentId,
    },
}

/// How many nodes and edges one version changed over another, counted over the hashed body only,
/// so a moved node never counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionChangeCounts {
    /// Nodes added.
    pub nodes_added: SafeInt<0>,
    /// Nodes removed.
    pub nodes_removed: SafeInt<0>,
    /// Nodes changed.
    pub nodes_changed: SafeInt<0>,
    /// Edges added.
    pub edges_added: SafeInt<0>,
    /// Edges removed.
    pub edges_removed: SafeInt<0>,
}

/// One version in a chain: the id a re-pin carries, the number a person reads, when it was saved
/// and by whom, and what it changed over the version before it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionChainEntry {
    /// The version's id.
    pub workflow_version_id: WorkflowVersionId,
    /// The version's number.
    pub version_number: SafeInt<1>,
    /// The hash of its hashed body.
    pub content_hash: WorkflowContentHash,
    /// When it was saved.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// Who saved it.
    pub saved_by: WorkflowVersionSavedBy,
    /// What it changed over the version before it; absent on the first version.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowVersionChangeCounts")]
    pub changes_from_previous: Option<WorkflowVersionChangeCounts>,
}

/// The `workflow.version.list` result: every version of the pinned version's definition, oldest
/// first, never empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionChainReadResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Its versions, oldest first.
    #[garde(dive)]
    pub versions: BoundedVec<WorkflowVersionChainEntry, 1, { usize::MAX }>,
}

// workflow.version.diff.read

/// The `workflow.version.diff.read` input: two versions of one workflow. Two versions of different
/// workflows are refused with `workflow.version.diffCrossWorkflow`, and nothing is compared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionDiffReadRequest {
    /// The version compared from.
    pub from_workflow_version_id: WorkflowVersionId,
    /// The version compared to.
    pub to_workflow_version_id: WorkflowVersionId,
}

/// One node of a version difference, whole: the trigger travels with its inputs, every other node
/// as itself. A trigger with no inputs reads back as a plain node, losing nothing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum WorkflowVersionNode {
    /// A node other than the trigger, or a trigger that declares no inputs.
    Node(WorkflowNode),
    /// The trigger with the inputs it declares.
    Trigger(WorkflowTriggerNode),
}

/// One node a version changed, whole, before and after.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionNodeChange {
    /// The node in the version compared from.
    pub before: WorkflowVersionNode,
    /// The node in the version compared to.
    pub after: WorkflowVersionNode,
}

/// The `workflow.version.diff.read` result: the structural difference, computed in the daemon over
/// the hashed body only, so a moved node is never a change. The trigger counts as a node, and a
/// version that changed only the trigger's inputs names the trigger changed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowVersionDiffReadResponse {
    /// Nodes added.
    pub nodes_added: Vec<WorkflowVersionNode>,
    /// Nodes removed.
    pub nodes_removed: Vec<WorkflowVersionNode>,
    /// Nodes changed.
    pub nodes_changed: Vec<WorkflowVersionNodeChange>,
    /// Edges added.
    pub edges_added: Vec<WorkflowEdge>,
    /// Edges removed.
    pub edges_removed: Vec<WorkflowEdge>,
}

/// The details of `workflow.version.diffCrossWorkflow`: the two versions, of different
/// workflows, a diff named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionDiffCrossWorkflowDetails {
    /// The version compared from.
    pub from_workflow_version_id: WorkflowVersionId,
    /// The version compared to.
    pub to_workflow_version_id: WorkflowVersionId,
}

/// The TypeScript module of the version reads.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/versions",
    doc: "The reads over a definition's saved versions: one version, the chain a run's pinned \
          version belongs to, and the difference between two versions, with the refusal a diff of \
          two workflows answers with.",
    definitions: &[
        Definition::read::<WorkflowVersionReadRequest>().checked(),
        Definition::read::<WorkflowVersionReadResponse>().checked(),
        Definition::read::<WorkflowVersionChainReadRequest>().checked(),
        Definition::read::<WorkflowVersionSavedBy>(),
        Definition::read::<WorkflowVersionChangeCounts>(),
        Definition::read::<WorkflowVersionChainEntry>().checked(),
        Definition::read::<WorkflowVersionChainReadResponse>().checked(),
        Definition::read::<WorkflowVersionDiffReadRequest>().checked(),
        Definition::read::<WorkflowVersionNode>(),
        Definition::read::<WorkflowVersionNodeChange>(),
        Definition::read::<WorkflowVersionDiffReadResponse>().checked(),
        Definition::read::<WorkflowVersionDiffCrossWorkflowDetails>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

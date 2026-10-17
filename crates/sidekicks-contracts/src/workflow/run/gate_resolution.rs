//! The record of one answer to a run's gate: an approval step's question or its chain's question.
//! Answers are appended and never rewritten, numbered per run, and each names the approval request
//! it answered and the device that answered it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{EnumDiscriminants, IntoStaticStr, VariantArray};

use crate::approval::{ApprovalCategory, ApprovalDecision, ApprovalRequestId};
use crate::internal::branded::branded_uuid_id;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::record::JsonRecord;
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::run::id::WorkflowRunId;

branded_uuid_id! {
    /// Identifies one answer to a run's gate, its append-only row's id; the
    /// `workflow.gate.resolved` event names it.
    WorkflowGateResolutionId
}

/// The category of the approval request a gate answered: an approval's categories but a plan's,
/// which no workflow gate asks.
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
pub enum WorkflowGateApprovalCategory {
    /// Running a tool.
    ToolExecution,
    /// Writing a file.
    FileWrite,
    /// Reaching the network.
    NetworkAccess,
    /// A git command that destroys work.
    DestructiveGit,
    /// A workflow gate.
    Gate,
}

impl From<WorkflowGateApprovalCategory> for ApprovalCategory {
    fn from(category: WorkflowGateApprovalCategory) -> Self {
        match category {
            WorkflowGateApprovalCategory::ToolExecution => Self::ToolExecution,
            WorkflowGateApprovalCategory::FileWrite => Self::FileWrite,
            WorkflowGateApprovalCategory::NetworkAccess => Self::NetworkAccess,
            WorkflowGateApprovalCategory::DestructiveGit => Self::DestructiveGit,
            WorkflowGateApprovalCategory::Gate => Self::Gate,
        }
    }
}

/// Declares [`WorkflowGateResolution`] with the members every gate kind's answer carries spelled
/// once, then each arm's own.
macro_rules! workflow_gate_resolution {
    ($(#[$attribute:meta])+ pub enum $name:ident {
        $($(#[$arm_attribute:meta])+ $arm:ident { $($members:tt)* },)+
    }) => {
        $(#[$attribute])+
        pub enum $name {
            $(
                $(#[$arm_attribute])+
                $arm {
                    /// The answer's id.
                    gate_resolution_id: WorkflowGateResolutionId,
                    /// The run whose gate it answered.
                    workflow_run_id: WorkflowRunId,
                    /// Which of the run's answers, counted from 1.
                    sequence: SafeInt<1>,
                    /// The approval request's category, where the request carries one.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "WorkflowGateApprovalCategory")]
                    approval_category: Option<WorkflowGateApprovalCategory>,
                    /// The approval request answered.
                    approval_request_id: ApprovalRequestId,
                    /// The answer.
                    outcome: ApprovalDecision,
                    /// The device that answered.
                    device_id: DeviceId,
                    /// When.
                    resolved_at: WireInstant,
                    /// What the answer was given about: its scope, the resource and the reason
                    /// text.
                    decision_context: JsonRecord,
                    $($members)*
                },
            )+
        }
    };
}

workflow_gate_resolution! {
    /// One answer to a gate of a run, as its append-only row holds it. An approval step's answer
    /// names the step's node; a chain's question belongs to the run and names none.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, EnumDiscriminants)]
    #[serde(
        tag = "gateKind",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    #[strum_discriminants(
        name(WorkflowGateKind),
        doc = "The kind of gate an answer resolved, spelled as its `gateKind` tag.",
        derive(IntoStaticStr, VariantArray)
    )]
    pub enum WorkflowGateResolution {
        /// A `human.approval` step's question.
        #[serde(rename = "human.approval")]
        #[strum_discriminants(strum(serialize = "human.approval"))]
        HumanApproval {
            /// The approval step answered.
            node_id: WorkflowNodeId,
        },
        /// The question a chain's first run asks once the chain has started as many runs as the
        /// person allows.
        #[serde(rename = "chain")]
        #[strum_discriminants(strum(serialize = "chain"))]
        Chain {
            /// Never present: a chain's question belongs to the run.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            node_id: Option<Never>,
        },
    }
}

/// The TypeScript module of a gate's answer.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/gate-resolution",
    doc: "The record of one answer to a run's gate: an approval step's question or its chain's \
          question, appended and never rewritten, numbered per run.",
    definitions: &[
        Definition::read::<WorkflowGateResolutionId>().checked(),
        Definition::read::<WorkflowGateApprovalCategory>(),
        Definition::read::<WorkflowGateResolution>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

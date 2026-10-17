//! The items data travels in between nodes, and the failure an item, a step or a run carries.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentDefinitionId;
use crate::agent::definition::refusal::{
    AgentDefinitionResolutionRefusedCode, agent_definition_resolution_refused_details,
};
use crate::artifacts::id::ArtifactId;
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::record::{JsonRecord, Record};
use crate::wire::text::{BoundedText, NonEmptyText, pattern_text};
use crate::wire::{AnyValue, Never};
use crate::workflow::definition::document::WorkflowNodeId;

/// A binary value an item carries: a stored artifact by id, with the type, name and size a panel
/// draws. Bytes never travel inside a run record or a document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBinaryRef {
    /// The artifact holding the bytes.
    pub artifact_id: ArtifactId,
    /// The media type.
    pub mime_type: NonEmptyText,
    /// The file name.
    pub file_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// The size, in bytes.
    pub size: SafeInt<0>,
}

/// One input item an output item came from, and on which input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPairedItem {
    /// The input item's index.
    pub item: SafeInt<0>,
    /// The input's index.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub input: Option<SafeInt<0>>,
}

/// An item's lineage: the one input item it came from, or several.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum WorkflowPairedItems {
    /// One input item.
    One(WorkflowPairedItem),
    /// Several input items.
    Many(Vec<WorkflowPairedItem>),
}

pattern_text! {
    /// A step failure's own code, a wire name in the `workflow[.resource].condition` form, such as
    /// `workflow.step.timedOut`.
    pub struct WorkflowStepErrorCode("^workflow(\\.[a-z][a-zA-Z0-9]*){1,3}$");
}

agent_definition_resolution_refused_details! {
    /// Why a step's agent could not resolve: the resolution refusal's own details, its
    /// `definitionId` `null` for a step running the General agent, which runs no definition.
    WorkflowStepAgentResolutionRefusedDetails,
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<AgentDefinitionId>")]
    Option<AgentDefinitionId>
}

/// Declares one arm of a step failure with the members every arm carries, then its own.
macro_rules! step_error_arm {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// What went wrong, in words.
            pub message: NonEmptyText,
            /// The node the failure belongs to.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowNodeId")]
            pub node_id: Option<WorkflowNodeId>,
            /// The zero-based index of the input item the step failed on, the `$itemIndex` an
            /// expression reads.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<0>")]
            pub item_index: Option<SafeInt<0>>,
            $($extra)*
        }
    };
}

step_error_arm! {
    /// A failure with no code of its own: the message alone.
    pub struct WorkflowStepUncodedError {
        /// Absent: this failure has no code.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub code: Option<Never>,
        /// Absent: details never come without a code.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub details: Option<Never>,
    }
}

step_error_arm! {
    /// A failure carrying the step failure's own `workflow[.resource].condition` code, and that
    /// code's details where it has any.
    pub struct WorkflowStepCodedError {
        /// The failure's code.
        pub code: WorkflowStepErrorCode,
        /// The code's details.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "JsonRecord")]
        pub details: Option<JsonRecord>,
    }
}

step_error_arm! {
    /// A step whose agent could not resolve, such as a park on an account removed first.
    pub struct WorkflowStepAgentResolutionError {
        /// Always `agent.definition.resolutionRefused`.
        pub code: AgentDefinitionResolutionRefusedCode,
        /// Why the agent could not resolve.
        #[garde(dive)]
        pub details: WorkflowStepAgentResolutionRefusedDetails,
    }
}

/// A failure carried on one item, so one item can fail while the rest of a batch succeeds, on the
/// step it failed in, and on a run as why it failed or was canceled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum WorkflowStepError {
    /// The message alone.
    Uncoded(#[garde(dive)] WorkflowStepUncodedError),
    /// A `workflow.<condition>` code.
    Coded(#[garde(dive)] WorkflowStepCodedError),
    /// An agent that could not resolve.
    AgentResolution(#[garde(dive)] WorkflowStepAgentResolutionError),
}

/// Declares an item type with the members every item carries, followed by the members it adds.
macro_rules! workflow_item {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The item's data.
            pub json: AnyValue,
            $($extra)*
            /// The item's lineage, which lets an expression walk back across a branch and a merge.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowPairedItems")]
            pub paired_item: Option<WorkflowPairedItems>,
            /// The item's failure.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowStepError")]
            #[garde(dive)]
            pub error: Option<WorkflowStepError>,
        }
    };
}

workflow_item! {
    /// One item: data between nodes is always a list of these.
    pub struct WorkflowItem {
        /// The binary values the item carries, by name.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Record<String, WorkflowBinaryRef>")]
        pub binary: Option<Record<String, WorkflowBinaryRef>>,
    }
}

workflow_item! {
    /// An item pinned onto a node as test data. It carries no binary value, because a node whose
    /// items carry one cannot be pinned.
    pub struct WorkflowPinnedItem {}
}

/// The TypeScript module of the workflow items and the failures they carry.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/item",
    doc: "The items data travels in between nodes, and the failure an item, a step or a run \
          carries.",
    definitions: &[
        Definition::read::<WorkflowBinaryRef>(),
        Definition::read::<WorkflowPairedItem>(),
        Definition::read::<WorkflowPairedItems>(),
        Definition::read::<WorkflowStepErrorCode>(),
        Definition::read::<WorkflowStepAgentResolutionRefusedDetails>(),
        Definition::read::<WorkflowStepUncodedError>(),
        Definition::read::<WorkflowStepCodedError>(),
        Definition::read::<WorkflowStepAgentResolutionError>(),
        Definition::read::<WorkflowStepError>().checked(),
        Definition::read::<WorkflowItem>().checked(),
        Definition::read::<WorkflowPinnedItem>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

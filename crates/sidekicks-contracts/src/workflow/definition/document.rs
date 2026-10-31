//! Workflow definitions: the node-graph document an author writes and the ids that address a
//! definition and its versions. The document has one form, on the wire and in the store; its
//! content hash covers only the hashed body, so canvas layout, pinned sample data and tags sit
//! outside it and dragging a node, pinning data or tagging a workflow never mints a version.
//!
//! The workflow authoring agent tools take their input schemas from this document, and a model
//! reading one sees each member's description but not its bounds, so every rule an author must
//! meet is also written in that description. The run contracts import the document's ids, nodes
//! and items from here; this module imports nothing from them.

use std::collections::HashSet;
use std::sync::LazyLock;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::internal::branded::branded_uuid_id;
use crate::mcp::server::McpServerBindingRef;
use crate::tag::TagList;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::{SafeInt, SafeSignedInt};
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::number::{Number, PositiveNumber};
use crate::wire::record::{JsonRecord, Record};
use crate::wire::text::{BoundedText, NonEmptyText, branded_text};
use crate::wire::{literal, named_scalar};
use crate::workflow::definition::item::WorkflowPinnedItem;
use crate::workflow::kind::NOTIFY_KIND;

/// The message of the issue a document's read raises at a repeated node id (`nodes[i].id`). The
/// daemon's refusal recognizes the rule by it and carries the repeat's `nodeIdDuplicate` finding,
/// over the id at that path, as the issue's `params`.
pub const NODE_ID_DUPLICATE_MESSAGE: &str = "this node id is already used by an earlier node";

/// The longest workflow name a document holds, in code points: a session's bound, since a run's
/// name is drawn where a session's is.
pub const WORKFLOW_NAME_MAX_LEN: usize = 256;

/// The longest notice a Notify step posts, in code points: the bound of the smallest chat
/// message the web address's receivers take, so the notice reaches them whole.
pub const NOTIFY_NOTICE_MAX_LEN: usize = 2_000;

/// A workflow's name: one to [`WORKFLOW_NAME_MAX_LEN`] code points.
pub type WorkflowName = BoundedText<1, WORKFLOW_NAME_MAX_LEN>;

/// A Notify step's notice: one to [`NOTIFY_NOTICE_MAX_LEN`] code points.
pub type WorkflowNotifyNotice = BoundedText<1, NOTIFY_NOTICE_MAX_LEN>;

/// The Notify step's parameter holding its notice.
const NOTIFY_NOTICE_PARAM: &str = "notice";

/// The message of the issue a document's read raises at a Notify step's notice that does not read
/// as a [`WorkflowNotifyNotice`].
static NOTIFY_NOTICE_MESSAGE: LazyLock<String> = LazyLock::new(|| {
    format!("a Notify step's notice is text of 1 to {NOTIFY_NOTICE_MAX_LEN} characters")
});

ts_constants! {
    /// The document schema version this contract reads and writes.
    WORKFLOW_DOCUMENT_SCHEMA_VERSION = WorkflowDocumentSchemaVersion::Value;
    /// Every way a `flow.merge` node joins its inputs.
    WORKFLOW_MERGE_MODES = WorkflowMergeMode::VARIANTS;
}

branded_uuid_id! {
    /// A workflow definition's id. The daemon mints it; a client passes it through unparsed.
    WorkflowDefinitionId
}

branded_uuid_id! {
    /// One saved version's id, exactly as the daemon returned it; it is what a run start takes. The
    /// daemon mints it; a client never builds one from a definition id and a version number.
    WorkflowVersionId
}

named_scalar! {
    /// A definition's content hash: BLAKE3 over the RFC 8785 canonical JSON of its hashed body.
    WorkflowContentHash(NonEmptyText)
}

branded_text! {
    /// The node's id, unique in the document; edges and expressions address it.
    pub struct WorkflowNodeId(1..=usize::MAX);
}

named_scalar! {
    /// The node kind's key as workflow.kind.list lists it, such as files.read.
    WorkflowNodeKindId(NonEmptyText)
}

named_scalar! {
    /// An edge's id, unique among the document's edges.
    WorkflowEdgeId(NonEmptyText)
}

named_scalar! {
    /// A sticky note's id, unique among the canvas's notes.
    WorkflowStickyNoteId(NonEmptyText)
}

literal! {
    /// The document schema version, always `2`.
    pub enum WorkflowDocumentSchemaVersion = "2";
}

/// What a node's failure does: stop the run, pass the node's input on, or send the failed items
/// down a real `error` output handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeOnError {
    /// Stop the run.
    Stop,
    /// Pass the node's input on.
    Continue,
    /// Send the failed items down the node's `error` output.
    ContinueErrorOutput,
}

/// How a `flow.merge` node joins its inputs into its one output. `firstToArrive` passes on the
/// first input to succeed and cancels the branches still running.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowMergeMode {
    /// Every input's items, one input after another.
    Append,
    /// Items joined on a field's value.
    CombineByField,
    /// Items joined by their position.
    CombineByPosition,
    /// One branch's items.
    ChooseBranch,
    /// The first input to succeed; the rest are canceled.
    FirstToArrive,
}

/// A node's retries on failure, as the author asks for them; the engine clamps both.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeRetry {
    /// The tries, from 1.
    pub max_tries: SafeInt<1>,
    /// The wait between tries, in milliseconds.
    pub wait_ms: SafeInt<0>,
}

/// Declares a node type with every member a node carries, followed by the members it adds.
macro_rules! workflow_node {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The node's id.
            pub id: WorkflowNodeId,
            /// The node's kind.
            pub kind: WorkflowNodeKindId,
            /// The kind's version when the node was placed, never migrated.
            #[schemars(
                description = "The kind's version when the node was placed; a whole number from 1."
            )]
            pub kind_version: SafeInt<1>,
            /// The label a person reads.
            #[schemars(description = "The label a person reads; never used to address the node.")]
            pub name: NonEmptyText,
            /// Which sibling branch runs first, lowest first.
            #[schemars(
                description = "Which sibling branch runs first, lowest first; never the canvas \
                               position."
            )]
            pub order: SafeSignedInt,
            /// The node's parameters by the ids its kind lists.
            #[schemars(
                description = "The node's parameters by the ids its kind lists. A value is a \
                               literal, or an expression written ={{ … }}. An agent, project or \
                               session parameter holds that record's id and an MCP tool \
                               parameter its server binding and tool name, never a nested node. \
                               A secret is written secret://shared/<name> or \
                               secret://project/<name>, never as an expression, and only in a \
                               parameter the kind marks sensitive."
            )]
            pub params: JsonRecord,
            /// Whether the node is switched off.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub disabled: Option<bool>,
            /// The author's notes.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            pub notes: Option<String>,
            /// What the node's failure does.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowNodeOnError")]
            pub on_error: Option<WorkflowNodeOnError>,
            /// Retries on failure.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(
                with = "WorkflowNodeRetry",
                description = "Retries on failure: maxTries from 1, waitMs from 0; the engine \
                               clamps both."
            )]
            pub retry: Option<WorkflowNodeRetry>,
            /// Whether the node runs once, over its first item only.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub execute_once: Option<bool>,
            /// Whether the node outputs one empty item where it would output none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub always_output_data: Option<bool>,
            $($extra)*
        }
    };
}

workflow_node! {
    /// One node. `kindVersion` is written when the node is placed and never migrated: the daemon
    /// runs the kind implementation the document names. `order` decides which sibling branch runs
    /// first and is never derived from canvas position.
    pub struct WorkflowNode {}
}

workflow_node! {
    /// The trigger node: a node that may also declare the inputs a run of the workflow starts
    /// with, each name used once.
    pub struct WorkflowTriggerNode {
        /// The inputs a run starts with.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "Vec<WorkflowTriggerInput>",
            description = "The inputs a run starts with, each with a name no other input uses and \
                           a type (boolean, string, path, or select with its options) with the \
                           value it starts on as default; required marks one a start must fill."
        )]
        #[garde(dive)]
        pub inputs: Option<UniqueList<WorkflowTriggerInput, 0, { usize::MAX }>>,
    }
}

impl From<&WorkflowTriggerNode> for WorkflowNode {
    /// The trigger's node members, without its inputs.
    fn from(trigger: &WorkflowTriggerNode) -> Self {
        Self {
            id: trigger.id.clone(),
            kind: trigger.kind.clone(),
            kind_version: trigger.kind_version,
            name: trigger.name.clone(),
            order: trigger.order,
            params: trigger.params.clone(),
            disabled: trigger.disabled,
            notes: trigger.notes.clone(),
            on_error: trigger.on_error,
            retry: trigger.retry,
            execute_once: trigger.execute_once,
            always_output_data: trigger.always_output_data,
        }
    }
}

impl ListKey for WorkflowTriggerInput {
    type Key = String;

    fn list_key(&self) -> String {
        self.name().as_str().to_owned()
    }

    fn validate_item(&self, parent: &mut dyn FnMut() -> garde::Path, report: &mut garde::Report) {
        garde::Validate::validate_into(self, &(), parent, report);
    }
}

/// One input a workflow declares on its trigger, which a run start fills by `name`, unique among
/// the trigger's inputs. Its type picks the field Run now draws: a checkbox for `boolean`, a list
/// of `options` for `select`, a folder picker for `path`, a box for `string`. `default` is the
/// value the field starts on, and a `select` input's is one of its `options`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(select_starts_on_an_option))]
pub enum WorkflowTriggerInput {
    /// A checkbox.
    Boolean {
        /// The input's name.
        #[schemars(description = "The input's name; a run start fills the input by it.")]
        name: NonEmptyText,
        /// Whether a start must fill the input.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "bool",
            description = "True where a start must fill the input; omitted, it may be left out."
        )]
        required: Option<bool>,
        /// The value the field starts on.
        default: bool,
    },
    /// A box.
    String {
        /// The input's name.
        #[schemars(description = "The input's name; a run start fills the input by it.")]
        name: NonEmptyText,
        /// Whether a start must fill the input.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "bool",
            description = "True where a start must fill the input; omitted, it may be left out."
        )]
        required: Option<bool>,
        /// The value the field starts on.
        default: String,
    },
    /// A folder picker.
    Path {
        /// The input's name.
        #[schemars(description = "The input's name; a run start fills the input by it.")]
        name: NonEmptyText,
        /// Whether a start must fill the input.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "bool",
            description = "True where a start must fill the input; omitted, it may be left out."
        )]
        required: Option<bool>,
        /// The path the field starts on.
        default: BoundedText<0, FILE_PATH_MAX_LEN>,
    },
    /// A list of choices.
    Select {
        /// The input's name.
        #[schemars(description = "The input's name; a run start fills the input by it.")]
        name: NonEmptyText,
        /// Whether a start must fill the input.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "bool",
            description = "True where a start must fill the input; omitted, it may be left out."
        )]
        required: Option<bool>,
        /// The choices, at least one; one of them is `default`.
        #[schemars(
            description = "The choices, at least one; default is one of them.",
            extend("contains" = { "const": { "$data": "2/default" } })
        )]
        options: BoundedVec<NonEmptyText, 1, { usize::MAX }>,
        /// The choice the field starts on.
        default: String,
    },
}

impl WorkflowTriggerInput {
    /// The input's name, which a run start fills it by.
    pub fn name(&self) -> &NonEmptyText {
        match self {
            Self::Boolean { name, .. }
            | Self::String { name, .. }
            | Self::Path { name, .. }
            | Self::Select { name, .. } => name,
        }
    }
}

/// Refuses a choice input whose starting value is none of its options.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn select_starts_on_an_option(input: &WorkflowTriggerInput, (): &()) -> garde::Result {
    if let WorkflowTriggerInput::Select {
        options, default, ..
    } = input
        && !options
            .as_slice()
            .iter()
            .any(|option| option.as_str() == default)
    {
        return Err(garde::Error::new(
            "a choice input starts on one of its options",
        ));
    }
    Ok(())
}

/// One edge. It names the two handles it joins, not only the two nodes, because a node can carry
/// several handles on each side. A handle id reads `<mode>/<type>/<index>`, such as
/// `outputs/main/1`; the daemon's check at save refuses a type other than `main` or `tool`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowEdge {
    /// The edge's id.
    pub id: WorkflowEdgeId,
    /// The node the edge leaves.
    pub source: WorkflowNodeId,
    /// The source node's output handle.
    #[schemars(
        description = "The source node's output handle, such as outputs/main/0 or outputs/tool/0."
    )]
    pub source_handle: NonEmptyText,
    /// The node the edge enters.
    pub target: WorkflowNodeId,
    /// The target node's input handle.
    #[schemars(
        description = "The target node's input handle, such as inputs/main/0 or inputs/tool/0."
    )]
    pub target_handle: NonEmptyText,
}

/// A point on the canvas, in canvas units.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCanvasPoint {
    /// Across.
    pub x: Number,
    /// Down.
    pub y: Number,
}

/// The canvas's view: where it is scrolled to and how far it is zoomed.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowViewport {
    /// Across.
    pub x: Number,
    /// Down.
    pub y: Number,
    /// The zoom, above 0.
    pub zoom: PositiveNumber,
}

/// A sticky note on the canvas: text in a box, with no handles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStickyNote {
    /// The note's id.
    pub id: WorkflowStickyNoteId,
    /// The note's text.
    pub text: String,
    /// Across.
    pub x: Number,
    /// Down.
    pub y: Number,
    /// The box's width, above 0.
    pub width: PositiveNumber,
    /// The box's height, above 0.
    pub height: PositiveNumber,
}

/// Canvas geometry, in canvas units. Outside the hash, and persisted beside the version's body, so
/// an exported or agent-written workflow carries its picture. A document with no layout is laid
/// out by the daemon the same way every time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowLayout {
    /// Each node's position, by node id.
    pub nodes: Record<String, WorkflowCanvasPoint>,
    /// The canvas's view.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowViewport")]
    pub viewport: Option<WorkflowViewport>,
    /// The sticky notes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<WorkflowStickyNote>")]
    pub notes: Option<Vec<WorkflowStickyNote>>,
}

/// Declares a document type with every member a document carries, its trigger written in place
/// by the caller. Both refuse a node id used twice, the trigger's included, at each repeat.
macro_rules! workflow_document {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($trigger:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// Always `2`.
            #[schemars(description = "The document schema version; always \"2\".")]
            pub schema_version: WorkflowDocumentSchemaVersion,
            /// The workflow's name.
            #[schemars(description = format!(
                "The workflow's name: 1 to {WORKFLOW_NAME_MAX_LEN} characters."
            ))]
            pub name: WorkflowName,
            /// The workflow's description.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            pub description: Option<String>,
            $($trigger)*
            /// Every node except the trigger.
            #[schemars(
                description = "Every node except the trigger. Node ids are unique across the \
                               document, the trigger's included."
            )]
            pub nodes: Vec<WorkflowNode>,
            /// The connections.
            #[schemars(
                description = "The connections. main carries items and tool carries a \
                               capability; nothing connects into the trigger, and nothing but a \
                               loop closes a cycle."
            )]
            pub edges: Vec<WorkflowEdge>,
            /// Canvas positions, outside the content hash.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(
                with = "WorkflowLayout",
                description = "Canvas positions; outside the content hash. Omit it and the daemon \
                               lays the graph out."
            )]
            pub layout: Option<WorkflowLayout>,
            /// Test data pinned onto nodes by node id, outside the content hash.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(
                with = "Record<String, Vec<WorkflowPinnedItem>>",
                description = "Test data pinned onto nodes by node id; outside the content hash."
            )]
            pub pin_data: Option<Record<String, Vec<WorkflowPinnedItem>>>,
            /// The workflow's tags, outside the content hash.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(
                with = "TagList",
                description = "The workflow's tags, nested with / and held once ignoring case, \
                               each never empty, with no whitespace and no empty level around a \
                               /; outside the content hash."
            )]
            pub tags: Option<TagList>,
        }

        /// The members' checks, each Notify step's notice that does not read as a
        /// [`WorkflowNotifyNotice`] at its `nodes[i].params.notice`, then each repeated node id at
        /// its `nodes[i].id`, with [`NODE_ID_DUPLICATE_MESSAGE`].
        impl garde::Validate for $name {
            type Context = ();

            fn validate_into(
                &self,
                context: &Self::Context,
                parent: &mut dyn FnMut() -> garde::Path,
                report: &mut garde::Report,
            ) {
                let mut trigger_path = || parent().join("trigger");
                garde::Validate::validate_into(&self.trigger, context, &mut trigger_path, report);
                let mut nodes_path = || parent().join("nodes");
                garde::Validate::validate_into(&self.nodes, context, &mut nodes_path, report);
                for (index, node) in self.nodes.iter().enumerate() {
                    if !is_notify_notice_readable(node) {
                        report.append(
                            parent()
                                .join("nodes")
                                .join(index)
                                .join("params")
                                .join(NOTIFY_NOTICE_PARAM),
                            garde::Error::new(NOTIFY_NOTICE_MESSAGE.as_str()),
                        );
                    }
                }
                let mut pin_data_path = || parent().join("pin_data");
                garde::Validate::validate_into(&self.pin_data, context, &mut pin_data_path, report);
                let mut tags_path = || parent().join("tags");
                garde::Validate::validate_into(&self.tags, context, &mut tags_path, report);
                for index in repeated_node_indices(self.trigger_ids(), &self.nodes) {
                    report.append(
                        parent().join("nodes").join(index).join("id"),
                        garde::Error::new(NODE_ID_DUPLICATE_MESSAGE),
                    );
                }
            }
        }
    };
}

workflow_document! {
    /// A workflow document: exactly one trigger node, the other nodes, and the edges between
    /// them, plus the layout, pinned data and tags outside the hash. What a failure does is set
    /// on the node that failed, never in a document-wide block.
    pub struct WorkflowDocument {
        /// The one trigger node.
        #[schemars(
            description = "The one trigger node; its kind is in the trigger category, such as \
                           trigger.manual. Only the trigger declares inputs."
        )]
        pub trigger: WorkflowTriggerNode,
    }
}

workflow_document! {
    /// The builder's unsaved document. It may not have its trigger yet: the builder opens on the
    /// trigger picker, and a draft saved before one is placed still survives a reload.
    pub struct WorkflowDraftDocument {
        /// The trigger node, once placed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(
            with = "WorkflowTriggerNode",
            description = "The one trigger node; its kind is in the trigger category, such as \
                           trigger.manual. Only the trigger declares inputs."
        )]
        pub trigger: Option<WorkflowTriggerNode>,
    }
}

impl WorkflowDocument {
    /// The trigger's id.
    fn trigger_ids(&self) -> impl Iterator<Item = &WorkflowNodeId> {
        std::iter::once(&self.trigger.id)
    }
}

impl WorkflowDraftDocument {
    /// The trigger's id, once one is placed.
    fn trigger_ids(&self) -> impl Iterator<Item = &WorkflowNodeId> {
        self.trigger.iter().map(|trigger| &trigger.id)
    }
}

/// Whether `node`'s notice reads as a [`WorkflowNotifyNotice`], or `node` is no Notify step or has
/// no notice yet. A node's params are an open record by the ids its kind lists, so the notice is
/// read through its type here; an expression is held to the bound as written.
fn is_notify_notice_readable(node: &WorkflowNode) -> bool {
    if node.kind.0.as_str() != NOTIFY_KIND {
        return true;
    }
    node.params
        .as_map()
        .get(NOTIFY_NOTICE_PARAM)
        .is_none_or(|notice| {
            notice
                .0
                .as_str()
                .and_then(|text| WorkflowNotifyNotice::new(text.to_owned()))
                .is_some()
        })
}

/// The index in `nodes` of each repeat of a node id among the trigger's and the other nodes', in
/// document order; the trigger comes first, so it is never the repeat.
fn repeated_node_indices<'a>(
    trigger_ids: impl Iterator<Item = &'a WorkflowNodeId>,
    nodes: &'a [WorkflowNode],
) -> Vec<usize> {
    let mut seen: HashSet<&WorkflowNodeId> = trigger_ids.collect();
    nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| !seen.insert(&node.id))
        .map(|(index, _)| index)
        .collect()
}

/// The part of a document its content hash covers: its content, never its schema version, its
/// geometry, its pinned data or its tags, so no member the engine reads may sit outside it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDocumentHashedBody {
    /// The workflow's name.
    pub name: WorkflowName,
    /// The workflow's description.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    pub description: Option<String>,
    /// The trigger node.
    pub trigger: WorkflowTriggerNode,
    /// Every node except the trigger.
    pub nodes: Vec<WorkflowNode>,
    /// The connections.
    pub edges: Vec<WorkflowEdge>,
}

/// The hashed body of a document, the only part the content hash reads; a member the document
/// leaves out stays out.
pub fn pick_workflow_document_hashed_body(
    document: &WorkflowDocument,
) -> WorkflowDocumentHashedBody {
    WorkflowDocumentHashedBody {
        name: document.name.clone(),
        description: document.description.clone(),
        trigger: document.trigger.clone(),
        nodes: document.nodes.clone(),
        edges: document.edges.clone(),
    }
}

/// A node's tool parameter: which server's tool, and nothing about its policy. A tool's approval
/// lives only in Settings › MCP servers, read live when the step starts, so `enabled`,
/// `approvalMode` or `idempotencyClass` on a binding is an unknown member and fails the parse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowToolBinding {
    /// The server binding.
    #[garde(dive)]
    pub binding: McpServerBindingRef,
    /// The tool's name.
    pub tool_name: NonEmptyText,
}

/// The TypeScript module of the workflow document.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/document",
    doc: "Workflow definitions: the node-graph document an author writes and the ids that address \
          a definition and its versions.",
    definitions: &[
        Definition::read::<WorkflowDefinitionId>().checked(),
        Definition::read::<WorkflowVersionId>().checked(),
        Definition::read::<WorkflowContentHash>().checked(),
        Definition::read::<WorkflowNodeId>().checked(),
        Definition::read::<WorkflowNodeKindId>().checked(),
        Definition::read::<WorkflowEdgeId>(),
        Definition::read::<WorkflowStickyNoteId>(),
        Definition::read::<WorkflowDocumentSchemaVersion>(),
        Definition::read::<WorkflowNodeOnError>(),
        Definition::read::<WorkflowMergeMode>(),
        Definition::read::<WorkflowNodeRetry>(),
        Definition::read::<WorkflowNode>().checked(),
        Definition::read::<WorkflowTriggerInput>(),
        Definition::read::<WorkflowTriggerNode>(),
        Definition::read::<WorkflowEdge>().checked(),
        Definition::read::<WorkflowCanvasPoint>(),
        Definition::read::<WorkflowViewport>(),
        Definition::read::<WorkflowStickyNote>(),
        Definition::read::<WorkflowLayout>().checked(),
        Definition::read::<WorkflowDocument>().checked(),
        Definition::read::<WorkflowDraftDocument>().checked(),
        Definition::read::<WorkflowToolBinding>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

/// A test node's JSON: `id` of `kind` at version 1, named by its id, with no params.
#[cfg(test)]
pub(crate) fn node(id: &str, kind: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "kind": kind, "kindVersion": 1, "name": id, "order": 0, "params": {}
    })
}

#[cfg(test)]
mod tests {
    use garde::Validate;
    use serde_json::json;

    use super::{
        NODE_ID_DUPLICATE_MESSAGE, NOTIFY_NOTICE_MAX_LEN, NOTIFY_NOTICE_MESSAGE, WorkflowDocument,
        node,
    };

    // A Notify step's notice past its bound is refused at its own place, and one at the bound is
    // kept, so a saved definition never holds a notice the web address's receivers cut. Mutation:
    // the notice check dropped from the document's validation.
    #[test]
    fn a_notify_notice_past_its_bound_is_refused() {
        let document_with = |length: usize| -> WorkflowDocument {
            let mut notify = node("n", "output.notify");
            notify["params"] = json!({ "notice": "\u{e9}".repeat(length) });
            serde_json::from_value(json!({
                "schemaVersion": "2",
                "name": "Deploy",
                "trigger": node("t", "trigger.manual"),
                "nodes": [node("a", "agent.run"), notify],
                "edges": [],
            }))
            .expect("the document reads")
        };
        let report = document_with(NOTIFY_NOTICE_MAX_LEN + 1)
            .validate()
            .expect_err("a notice past its bound is refused");
        let issues: Vec<(String, &str)> = report
            .iter()
            .map(|(path, error)| (path.to_string(), error.message()))
            .collect();
        assert_eq!(
            issues,
            vec![(
                "nodes[1].params.notice".to_owned(),
                NOTIFY_NOTICE_MESSAGE.as_str()
            )]
        );
        document_with(NOTIFY_NOTICE_MAX_LEN)
            .validate()
            .expect("a notice at its bound is kept");
    }

    #[test]
    fn each_repeated_node_id_is_refused_at_its_own_place() {
        let document: WorkflowDocument = serde_json::from_value(json!({
            "schemaVersion": "2",
            "name": "Repeats",
            "trigger": node("t", "trigger.manual"),
            "nodes": [node("a", "agent.run"), node("t", "agent.run"), node("a", "agent.run")],
            "edges": [],
        }))
        .expect("the document reads");
        let report = document
            .validate()
            .expect_err("a repeated node id is refused");
        let issues: Vec<(String, &str)> = report
            .iter()
            .map(|(path, error)| (path.to_string(), error.message()))
            .collect();
        assert_eq!(
            issues,
            vec![
                ("nodes[1].id".to_owned(), NODE_ID_DUPLICATE_MESSAGE),
                ("nodes[2].id".to_owned(), NODE_ID_DUPLICATE_MESSAGE),
            ]
        );
    }
}

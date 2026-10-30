//! The node catalog: every node kind the daemon runs, as `workflow.kind.list` serializes it. One
//! description per kind drives the palette row, the inspector's parameter form, the canvas handles
//! and the daemon's check at save, and an agent reads the same list before it writes a workflow.
//!
//! A kind's two computed parts, the handle set derived from its params and the one-line summary of
//! a configured node, are functions and do not cross the wire: `outputsDeriveFromParams` says the
//! listed outputs are the base case, and whatever holds the kind's code composes the summary.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::handle_id::handle_id;
use crate::wire::integer::SafeInt;
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::literal;
use crate::wire::record::Record;
use crate::wire::text::NonEmptyText;
use crate::wire::{AnyValue, named_scalar};
use crate::workflow::definition::document::WorkflowNodeKindId;

/// The key of a workflow's Notify step's kind.
pub const NOTIFY_KIND: &str = "output.notify";

/// The name a person reads for each node kind the catalog ships, by the kind's key: the
/// `displayName` that kind's spec carries, and the word a run graph's box reads.
pub const WORKFLOW_NODE_KIND_NAMES: &[(&str, &str)] = &[
    ("trigger.manual", "Run manually"),
    ("trigger.schedule", "On a schedule"),
    ("trigger.fileWatch", "On a file change"),
    ("trigger.webhook", "On a webhook"),
    ("trigger.sessionEvent", "On a session event"),
    ("trigger.chat", "From chat"),
    ("trigger.subWorkflow", "Called by a workflow"),
    ("trigger.error", "When a workflow fails"),
    ("agent.run", "Run a sidekick"),
    ("agent.multiAgent", "Run a sidekick team"),
    ("agent.askQuestion", "Ask a question"),
    ("human.approval", "Ask for approval"),
    ("human.form", "Ask for a form"),
    ("human.waitForChatReply", "Wait for a chat reply"),
    ("files.read", "Read files"),
    ("files.write", "Write files"),
    ("files.ingestArtifacts", "Ingest as artifacts"),
    ("files.parse", "Parse"),
    ("files.template", "Render a template"),
    ("browser.open", "Open a page"),
    ("browser.extract", "Extract from a page"),
    ("browser.screenshot", "Screenshot"),
    ("browser.act", "Act on a page"),
    ("developer.shell", "Run a command"),
    ("developer.git", "Git"),
    ("developer.runTests", "Run tests"),
    ("developer.http", "HTTP request"),
    ("developer.mcpTool", "MCP tool"),
    ("developer.callbackTool", "App tool"),
    ("developer.repoDiff", "Read a repo diff"),
    ("developer.code", "Code"),
    ("flow.if", "If"),
    ("flow.switch", "Switch"),
    ("flow.loopItems", "Loop over items"),
    ("flow.merge", "Merge"),
    ("flow.setVars", "Set variables"),
    ("flow.wait", "Wait"),
    ("flow.stopError", "Stop with error"),
    ("flow.executeWorkflow", "Execute workflow"),
    (NOTIFY_KIND, "Notify"),
    ("output.saveArtifact", "Save as artifact"),
    ("output.writeSummary", "Write a summary"),
];

ts_constants! {
    /// The name a person reads for each node kind the catalog ships, by the kind's key.
    WORKFLOW_NODE_KIND_NAMES = WORKFLOW_NODE_KIND_NAMES
        .iter()
        .copied()
        .collect::<BTreeMap<&str, &str>>();
}

/// The categories the palette groups kinds under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeKindCategory {
    /// What starts a run.
    Trigger,
    /// Running an agent.
    Agent,
    /// Asking a person.
    Human,
    /// Reading and writing files.
    Files,
    /// Driving a browser.
    Browser,
    /// Commands, Git, HTTP and code.
    Developer,
    /// Branching, looping and joining.
    Flow,
    /// What a run hands back.
    Output,
}

/// Declares one side's handle specs: a handle id per type, then the spec, tagged on `type`, whose
/// id names its side and type, so a handle is addressable from a stored edge alone.
macro_rules! handle_spec {
    (
        $(#[doc = $doc:literal])+
        $name:ident {
            main: $main_id:ident = $main_prefix:literal,
            tool: $tool_id:ident = $tool_prefix:literal,
        }
    ) => {
        handle_id!(
            /// A `main` handle id on this side: its fixed prefix and a whole number from 0.
            $main_id,
            $main_prefix
        );

        handle_id!(
            /// A `tool` handle id on this side: its fixed prefix and a whole number from 0.
            $tool_id,
            $tool_prefix
        );

        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "type",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {
            /// A handle carrying items.
            Main {
                /// The handle's id.
                id: $main_id,
                /// The handle's label.
                label: NonEmptyText,
                /// The most edges the handle takes; absent, any number.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SafeInt<1>")]
                max_connections: Option<SafeInt<1>>,
                /// Whether the handle must be connected.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                required: Option<bool>,
            },
            /// A handle carrying a capability an agent can call.
            Tool {
                /// The handle's id.
                id: $tool_id,
                /// The handle's label.
                label: NonEmptyText,
                /// The most edges the handle takes; absent, any number.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SafeInt<1>")]
                max_connections: Option<SafeInt<1>>,
                /// Whether the handle must be connected.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                required: Option<bool>,
            },
        }

        impl $name {
            /// The handle's id as an edge writes it.
            pub fn id_text(&self) -> String {
                match self {
                    Self::Main { id, .. } => id.to_string(),
                    Self::Tool { id, .. } => id.to_string(),
                }
            }

            /// Whether the handle carries a capability rather than items.
            pub fn is_tool(&self) -> bool {
                match self {
                    Self::Main { .. } => false,
                    Self::Tool { .. } => true,
                }
            }

            /// The most edges the handle takes; `None` for any number.
            pub fn max_connections(&self) -> Option<u64> {
                match self {
                    Self::Main {
                        max_connections, ..
                    }
                    | Self::Tool {
                        max_connections, ..
                    } => max_connections.map(SafeInt::get),
                }
            }
        }
    };
}

handle_spec! {
    /// One input handle a kind declares. `maxConnections` absent means the handle takes any number
    /// of edges.
    WorkflowInputHandleSpec {
        main: InputMainHandleId = "inputs/main/",
        tool: InputToolHandleId = "inputs/tool/",
    }
}

handle_spec! {
    /// One output handle a kind declares. `maxConnections` absent means the handle takes any
    /// number of edges.
    WorkflowOutputHandleSpec {
        main: OutputMainHandleId = "outputs/main/",
        tool: OutputToolHandleId = "outputs/tool/",
    }
}

/// The type of one leaf parameter, which picks the field the inspector draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowParamType {
    /// One line of text.
    String,
    /// Several lines of text.
    Text,
    /// A number.
    Number,
    /// A switch.
    Boolean,
    /// One of the options.
    Select,
    /// Any of the options.
    Multiselect,
    /// A JSON value.
    Json,
    /// An expression.
    Expression,
    /// A file system path.
    Path,
    /// A glob pattern.
    Glob,
    /// A cron schedule.
    Cron,
    /// A `secret://` reference.
    Secret,
    /// A saved agent.
    Agent,
    /// An MCP server's tool.
    McpTool,
    /// One of the daemon's own callback tools.
    CallbackTool,
    /// A session.
    Session,
    /// One of the person's projects, or none.
    Project,
}

named_scalar! {
    /// A parameter's id, which a node's params are keyed by.
    WorkflowParamId(NonEmptyText)
}

/// One choice a `select` or `multiselect` parameter offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowParamOption {
    /// The value the parameter takes.
    pub value: AnyValue,
    /// The label a person reads.
    pub label: NonEmptyText,
}

/// A leaf parameter: one declared type. `showWhen` is the whole conditional form: the parameter is
/// drawn when each named sibling holds one of the listed values. `sensitive` marks the only
/// parameters a `secret://` reference resolves in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowLeafParamSpec {
    /// The parameter's id.
    pub id: WorkflowParamId,
    /// The label a person reads.
    pub label: NonEmptyText,
    /// The parameter's type.
    #[serde(rename = "type")]
    pub param_type: WorkflowParamType,
    /// Whether the parameter must be filled.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub required: Option<bool>,
    /// Whether a `secret://` reference resolves in the parameter.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub sensitive: Option<bool>,
    /// The value the parameter starts on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AnyValue")]
    pub default: Option<AnyValue>,
    /// The help line.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub help: Option<NonEmptyText>,
    /// The choices.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<WorkflowParamOption>")]
    pub options: Option<Vec<WorkflowParamOption>>,
    /// The sibling values the parameter is drawn under, by sibling id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Record<String, Vec<AnyValue>>")]
    pub show_when: Option<Record<String, Vec<AnyValue>>>,
}

literal! {
    /// The type of a parameter that nests a field list.
    pub enum WorkflowCollectionParamType = "collection";
}

/// A parameter that nests a field list and may repeat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollectionParamSpec {
    /// The parameter's id.
    pub id: WorkflowParamId,
    /// The label a person reads.
    pub label: NonEmptyText,
    /// Always `collection`.
    #[serde(rename = "type")]
    pub param_type: WorkflowCollectionParamType,
    /// The nested fields.
    pub fields: Vec<WorkflowParamSpec>,
    /// Whether the field list repeats.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub multiple: Option<bool>,
}

/// One parameter a kind declares: a leaf of one type, or a collection that nests a field list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum WorkflowParamSpec {
    /// A leaf.
    Leaf(WorkflowLeafParamSpec),
    /// A collection.
    Collection(WorkflowCollectionParamSpec),
}

/// What running a kind can change: nothing, this machine, or something beyond it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeSideEffects {
    /// Nothing.
    None,
    /// This machine.
    Local,
    /// Something beyond this machine.
    External,
}

/// What a kind's run can do: be canceled, resume after a restart, and what it can change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeCapabilities {
    /// Whether a run of the kind can be canceled.
    pub cancelable: bool,
    /// Whether a run of the kind resumes after a restart.
    pub resumable: bool,
    /// What a run of the kind can change.
    pub side_effects: WorkflowNodeSideEffects,
}

/// One kind as the catalog serializes it. `version` is the implementation a newly placed node
/// records; a placed node keeps the version it recorded. Each handle id appears once on its side,
/// since an edge names a handle by id alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowNodeKindSpec {
    /// The kind's key.
    pub kind: WorkflowNodeKindId,
    /// The implementation a newly placed node records.
    pub version: SafeInt<1>,
    /// The palette's group.
    pub category: WorkflowNodeKindCategory,
    /// The name a person reads.
    pub display_name: NonEmptyText,
    /// What the kind does.
    pub description: NonEmptyText,
    /// The kind's icon.
    pub icon: NonEmptyText,
    /// Other words the palette's search finds the kind by.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<NonEmptyText>")]
    pub aliases: Option<Vec<NonEmptyText>>,
    /// The input handles, each id once.
    #[garde(dive)]
    pub inputs: UniqueList<WorkflowInputHandleSpec, 0, { usize::MAX }>,
    /// The output handles, each id once.
    #[garde(dive)]
    pub outputs: UniqueList<WorkflowOutputHandleSpec, 0, { usize::MAX }>,
    /// Whether the listed outputs are the base case of a set the node's params derive.
    pub outputs_derive_from_params: bool,
    /// The parameters.
    pub params: Vec<WorkflowParamSpec>,
    /// Whether the kind runs once per item rather than once over all of them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub per_item: Option<bool>,
    /// What a run of the kind can do.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowNodeCapabilities")]
    pub capabilities: Option<WorkflowNodeCapabilities>,
}

/// The `workflow.kind.list` result: every kind the daemon runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowKindListResponse {
    /// The kinds.
    #[garde(dive)]
    pub kinds: Vec<WorkflowNodeKindSpec>,
}

methods! {
    /// The node catalog's method table.
    pub const WORKFLOW_KIND_METHOD_DESCRIPTORS = [
        /// Lists every node kind the daemon runs, with its handles and parameters.
        WorkflowKindList = query "workflow.kind.list" {
            mutating: false,
            params: EmptyPayload,
            result: WorkflowKindListResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the node catalog.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/kind",
    doc: "The node catalog: every node kind the daemon runs, as `workflow.kind.list` serializes \
          it.",
    definitions: &[
        Definition::read::<WorkflowNodeKindCategory>(),
        Definition::read::<WorkflowInputHandleSpec>(),
        Definition::read::<WorkflowOutputHandleSpec>(),
        Definition::read::<WorkflowParamType>(),
        Definition::read::<WorkflowParamId>(),
        Definition::read::<WorkflowParamOption>(),
        Definition::read::<WorkflowLeafParamSpec>(),
        Definition::read::<WorkflowCollectionParamType>(),
        Definition::read::<WorkflowCollectionParamSpec>(),
        Definition::read::<WorkflowParamSpec>().checked(),
        Definition::read::<WorkflowNodeSideEffects>(),
        Definition::read::<WorkflowNodeCapabilities>(),
        Definition::read::<WorkflowNodeKindSpec>(),
        Definition::read::<WorkflowKindListResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_KIND_METHOD_DESCRIPTORS],
};

impl ListKey for WorkflowInputHandleSpec {
    type Key = String;

    fn list_key(&self) -> String {
        self.id_text()
    }

    // A handle carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

impl ListKey for WorkflowOutputHandleSpec {
    type Key = String;

    fn list_key(&self) -> String {
        self.id_text()
    }

    // A handle carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

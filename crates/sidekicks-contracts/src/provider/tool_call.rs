//! One tool call as its provider names it: the id its activity rows, approvals and child runs
//! share, and what the call does and to what, which a standing rule names by its kind.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::{FreeFormText, branded_free_form_text};

branded_free_form_text! {
    /// A provider's id of one tool call.
    pub struct ToolCallId(PROVIDER_WIRE_HANDLE_MAX_LEN);
}

/// What a tool call does, without its subject: run a command, send input to the running command
/// the call names, change files, read one file or folder, search for a pattern, reach a host, or
/// call a tool none of those covers. A standing rule names the kind it covers, spelled as here.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ToolCallActionKind {
    /// Run a command.
    Command,
    /// Send input to the running command the call names.
    CommandInput,
    /// Change files.
    FileChange,
    /// Read one file or folder.
    FileRead,
    /// Search files or the web for a pattern or a query.
    Search,
    /// Reach a host.
    Network,
    /// Call a tool none of the others covers.
    Tool,
}

/// What one tool call does and to what, read by its provider's driver from the call's own input
/// when it starts: the command line, the input, a file's path, the pattern or query, the host, or
/// the tool's own name for the open kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCallAction {
    /// What it does.
    pub kind: ToolCallActionKind,
    /// What it does it to, cut to the field's cap.
    pub subject: FreeFormText<EVENT_FIELD_MAX_LEN>,
}

/// The TypeScript module of a provider's tool call.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/tool-call",
    doc: "One tool call as its provider names it: the id its activity rows, approvals and child \
          runs share, and what the call does and to what, which a standing rule names by its \
          kind.",
    definitions: &[
        Definition::read::<ToolCallId>(),
        Definition::read::<ToolCallActionKind>(),
        Definition::read::<ToolCallAction>(),
    ],
    constants: &[],
    method_tables: &[],
};

//! The `workflow_run` tool an agent calls from a session: the one definition the desktop lists on
//! an agent definition's tool allowlist and the daemon's callback tool registry serves.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::project::{PROJECT_NAME_MAX_LEN, ProjectName};
use crate::provider::driver::tools::SessionCallbackTool;
use crate::schema::closed_schema_for;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::NonEmptyText;

ts_constants! {
    /// The `workflow_run` tool: starts a named workflow's latest version in the calling session.
    WORKFLOW_RUN_TOOL = workflow_run_tool();
}

/// The `workflow_run` input: a workflow named by its name, which the library holds once, and the
/// project whose repository the run works in, named as `session_options` lists it; the daemon
/// resolves the name to the project. Its members are snake_case, as the model reads and writes
/// them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunToolInput {
    /// The workflow's name.
    #[schemars(description = "The workflow's name: at least one character.")]
    pub definition_name: NonEmptyText,
    /// The project whose repository the run works in.
    #[schemars(description = format!(
        "The project whose repository the run works in, named from session_options, for a \
         workflow with a step that needs a repository; named only from a chat, since a project \
         session's run works in its own repository. Leave it out to run in this session's folder. \
         1 to {PROJECT_NAME_MAX_LEN} characters, not only whitespace, with no NUL character."
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectName")]
    pub project: Option<ProjectName>,
}

/// The `workflow_run` tool: its name, what it does for the model, and its input's schema.
pub fn workflow_run_tool() -> SessionCallbackTool {
    SessionCallbackTool {
        name: "workflow_run".to_owned(),
        description: "Start a workflow run in this session by the workflow's name. The run works \
                      in this session's folder, or in the repository of the project it names."
            .to_owned(),
        input_schema: closed_schema_for::<WorkflowRunToolInput>()
            .and_then(serde_json::from_value)
            .expect("a struct's schema is a JSON object"),
    }
}

/// The TypeScript module of the `workflow_run` tool.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/tool",
    doc: "The `workflow_run` tool an agent calls from a session: the one definition the desktop \
          lists on an agent definition's tool allowlist and the daemon's callback tool registry \
          serves.",
    definitions: &[Definition::read::<WorkflowRunToolInput>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

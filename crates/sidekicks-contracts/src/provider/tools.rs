//! The arguments of the tools the daemon serves the providers on its own tool route: the session
//! messaging pair, and the two that read and stop a tool call that moved to the background. A model
//! calls these, not a client, so no method table lists them. `session_list` takes no arguments, so
//! its input is the empty payload every argument-less call shares.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::number::NonNegativeNumber;
use crate::wire::text::FreeFormText;

/// `session_send`: a message to another session. `to` is that session's name as `session_list`
/// prints it, never an address; `files` are paths the sending session can read, staged into the
/// receiving session as its own attachments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSendArguments {
    /// The receiving session's name.
    #[schemars(description = format!(
        "The receiving session's name exactly as session_list prints it: 1 to \
         {SESSION_NAME_MAX_LEN} characters, not only whitespace, with no NUL character."
    ))]
    pub to: FreeFormText<SESSION_NAME_MAX_LEN>,
    /// The message.
    #[schemars(
        description = "The message: at least one character that is not whitespace, with no NUL \
                       character."
    )]
    pub message: FreeFormText<{ usize::MAX }>,
    /// Files to stage into the receiving session.
    #[schemars(description = format!(
        "Optional. Paths of files this session can read, each 1 to {FILE_PATH_MAX_LEN} \
         characters, with no NUL character."
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FilesystemPath>")]
    pub files: Option<Vec<FilesystemPath>>,
}

/// `task_output`: the status of a tool call that moved to the background and, once it ends, its
/// result. `wait_seconds` is how long the model asks to wait; the daemon waits at most 10 s.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskOutputArguments {
    /// The background call.
    #[schemars(
        description = "The id of the background call, as the call that moved it returned it: at \
                       least one character that is not whitespace, with no NUL character."
    )]
    pub task_id: FreeFormText<{ usize::MAX }>,
    /// How long to wait, in seconds.
    #[schemars(
        description = "Optional. How long to wait for the call to end, in seconds: a number at or \
                       above 0; the wait stops at 10 seconds."
    )]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonNegativeNumber")]
    pub wait_seconds: Option<NonNegativeNumber>,
}

/// `task_stop`: cancels a tool call that moved to the background.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskStopArguments {
    /// The background call.
    #[schemars(
        description = "The id of the background call, as the call that moved it returned it: at \
                       least one character that is not whitespace, with no NUL character."
    )]
    pub task_id: FreeFormText<{ usize::MAX }>,
}

/// The TypeScript module of the tools the daemon serves the providers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/tools",
    doc: "The arguments of the tools the daemon serves the providers on its own tool route.",
    definitions: &[
        Definition::read::<SessionSendArguments>(),
        Definition::read::<TaskOutputArguments>(),
        Definition::read::<TaskStopArguments>(),
    ],
    constants: &[],
    method_tables: &[],
};

//! The arguments of the tools the daemon serves the providers on its own tool route: the two that
//! read and stop a tool call that moved to the background. A model calls these, not a client, so
//! no method table lists them, but the daemon reads them as it reads any message it receives.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::number::NonNegativeNumber;
use crate::wire::text::FreeFormText;

/// `task_output`: the status of a tool call that moved to the background and, once it ends, its
/// result. `wait_seconds` is how long the model asks to wait; the daemon waits at most 10 s.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
        Definition::read::<TaskOutputArguments>(),
        Definition::read::<TaskStopArguments>(),
    ],
    constants: &[],
    method_tables: &[],
};

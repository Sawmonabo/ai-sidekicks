//! `session_send`: a message to another session, arriving in its conversation marked as from the
//! caller.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::session::{SessionReference, path_limits, text_field};

/// `session_send`'s arguments. `files` are paths the sending session can read, staged into the
/// receiving session as its own attachments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSendArguments {
    /// The receiving session.
    #[schemars(description = text_field(
        "A session name or id from session_list. If two sessions share the name, the call fails \
         and lists both; call again with the id.",
        SESSION_NAME_MAX_LEN,
    ))]
    pub to: SessionReference,
    /// The message.
    #[schemars(description = text_field(
        "Plain text. The first line is what the other session sees first.",
        usize::MAX,
    ))]
    pub message: FreeFormText<{ usize::MAX }>,
    /// Files to stage into the receiving session.
    #[schemars(description = format!(
        "Paths you can read. Each one arrives in the other session as an attached file. {}",
        path_limits()
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Vec<FilesystemPath>")]
    pub files: Option<Vec<FilesystemPath>>,
    /// Whether to wait for the answer in the same call.
    #[schemars(
        description = "true waits until the other session finishes the turn your message \
                       started, or needs the person, and returns its answer. Default false."
    )]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub wait: Option<bool>,
}

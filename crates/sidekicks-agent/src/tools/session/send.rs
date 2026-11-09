//! `session_send`: a message to another session, arriving in its conversation marked as from the
//! caller. With `wait: true` the call answers with what `session_wait` answers.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{SessionReference, ToolDescription, path_limits, text_field};

/// How `session_send` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_send`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_send",
    summary: "Send a message to another session. It arrives in that session's conversation \
              marked as from you, while it works or at its next turn; you do not need to wait \
              for it to be idle.",
    body: "{\"to\": \"builder\", \"message\": \"Use the new Money type in checkout; it is in \
           money.ts.\"}\n{\"to\": \"builder\", \"message\": \"Did the token-rotation tests \
           pass?\", \"wait\": true}\n\nThe other session reads only what you send: the message \
           and its files, never your conversation. Make the first line a clear sentence saying \
           what this is about. Send to a name, never an address. Its answer comes back to you \
           as a message from it; pass wait: true to get the answer in this same call \
           instead.\n\nOnly when the person, a workflow step or your saved instructions ask you \
           to involve another session.",
};

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

/// Where a message stands, in the row's own state words: the call's answer, then each later
/// state once, as a note in the same words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionSendResult {
    /// The call returned with the message on its way.
    Sent {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
    },
    /// The message reached a session that is working; it reads it at its next step.
    Delivered {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
    },
    /// The receiving session is paused; the message waits until the person continues it.
    Queued {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
    },
    /// The receiving session's own settings hold messages for its person's approval.
    Held {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
    },
    /// The provider refused the message, or the daemon's own hook did.
    Refused {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
        /// The refusal, in the provider's or the hook's own words.
        reason: String,
    },
    /// The receiving session went idle without reading the message.
    NotDelivered {
        /// The receiving session's name.
        name: String,
        /// The receiving session's id.
        id: String,
    },
}

impl fmt::Display for SessionSendResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sent { name, id } => write!(formatter, "Sent to {name} · {id}."),
            Self::Delivered { name, id } => write!(
                formatter,
                "Delivered to {name} · {id}; it is working and will read it at its next step."
            ),
            Self::Queued { name, .. } => write!(
                formatter,
                "Queued: {name} is paused. It gets the message when the person continues it."
            ),
            Self::Held { name, .. } => write!(
                formatter,
                "Held by {name}: that session's own settings hold messages for its person's \
                 approval. Do not wait for a reply; continue, or choose another approach."
            ),
            Self::Refused { reason, .. } => write!(
                formatter,
                "Refused: {reason}. Not delivered. Do not resend; tell the person, or choose \
                 another approach."
            ),
            Self::NotDelivered { name, .. } => write!(
                formatter,
                "Not delivered: {name} went idle without reading it. Do not resend in a loop; \
                 fold anything still needed into one later message."
            ),
        }
    }
}

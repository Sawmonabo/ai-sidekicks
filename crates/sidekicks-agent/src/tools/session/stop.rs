//! `session_stop`: stops a turn the caller's own message started in another session, and nothing
//! else.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{SessionReference, ToolDescription, text_field};

/// How `session_stop` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_stop`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_stop",
    summary: "Stop a turn that your own message started in another session. Never undoes \
              anything it already did.",
    body: "{\"session\": \"builder\"}\n\nIt stops only turns your session started with \
           session_send or session_start, never the person's own work or another session's \
           request.",
};

/// `session_stop`'s arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionStopArguments {
    /// The session whose turn to stop.
    #[schemars(description = text_field("A session name or id.", SESSION_NAME_MAX_LEN))]
    pub session: SessionReference,
}

/// What `session_stop` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionStopResult {
    /// The turn the caller's message started was stopped.
    Stopped {
        /// The session's name.
        name: String,
    },
    /// Nothing stopped: the person started the session's current turn.
    StartedByPerson {
        /// The session's name.
        name: String,
    },
    /// Nothing stopped: the session is idle.
    Idle {
        /// The session's name.
        name: String,
    },
}

impl fmt::Display for SessionStopResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped { name } => write!(formatter, "Stopped {name}'s turn."),
            Self::StartedByPerson { name } => write!(
                formatter,
                "Nothing stopped: {name}'s current turn was started by the person, not by you."
            ),
            Self::Idle { name } => write!(formatter, "Nothing stopped: {name} is idle."),
        }
    }
}

/// The refusal to stop the calling session itself.
pub fn not_stopped_self(name: &str) -> String {
    format!(
        "Not stopped: {name} is this session. session_stop stops a turn your message started in \
         another session."
    )
}

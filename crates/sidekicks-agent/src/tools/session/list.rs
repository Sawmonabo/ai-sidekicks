//! `session_list`: the person's sessions, one line each.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::project::{PROJECT_NAME_MAX_LEN, ProjectName};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{ToolDescription, text_field};

/// How `session_list` is gated: it only reads what the calling session may already read.
pub const GATE: CallbackToolGate = CallbackToolGate::Read;

/// What a model reads about `session_list`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_list",
    summary: "List the person's sessions: each one's name, id, provider, model, project, \
              computer, whether it is working, idle or waiting on the person, and its last \
              message. The session you are in is marked \"this session\".",
    body: "{\"group\": \"auth work\"}\n\nUse it to find a session before you read, message or \
           wait on it. A session started on another computer shows that computer's name.",
};

/// The result when the list holds no session but the caller's.
pub const EMPTY: &str = "No other sessions right now.";

/// `session_list`'s arguments: each narrows the list, and none is required.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionListArguments {
    /// Only sessions in this group.
    #[schemars(description = text_field(
        "Only sessions in this group. Omit for every session.",
        SESSION_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub group: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Only sessions in this project.
    #[schemars(description = text_field(
        "Only sessions in this project, by name. Omit for every project.",
        PROJECT_NAME_MAX_LEN,
    ))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "ProjectName")]
    pub project: Option<ProjectName>,
    /// Whether to list the archived sessions instead.
    #[schemars(description = "true lists archived sessions instead. Default false.")]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "bool")]
    pub archived: Option<bool>,
}

/// What a listed session is doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionListState {
    /// Running a turn.
    Working {
        /// What the turn is doing, in a few words.
        doing: String,
    },
    /// Between turns.
    Idle,
    /// Stopped on a question or an approval for the person.
    WaitingOnPerson {
        /// What it is asking.
        what: String,
    },
}

impl fmt::Display for SessionListState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Working { doing } => write!(formatter, "working: {doing}"),
            Self::Idle => formatter.write_str("idle"),
            Self::WaitingOnPerson { what } => write!(formatter, "needs the person: {what}"),
        }
    }
}

/// One session as `session_list` prints it; `session_search` prints its hits the same way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionListLine {
    /// The session's name.
    pub name: String,
    /// The session's id.
    pub id: String,
    /// The provider's name as the person reads it.
    pub provider: String,
    /// The model's name as the person reads it; `None` where the provider does not say.
    pub model: Option<String>,
    /// The session's project; `None` for a chat and a session typed in a terminal.
    pub project: Option<String>,
    /// The computer the session runs on.
    pub computer: String,
    /// What the session is doing.
    pub state: SessionListState,
    /// The session's last message, where it has one.
    pub last_message: Option<String>,
    /// Whether this is the calling session, whose line drops its state and last message.
    pub is_calling_session: bool,
}

impl fmt::Display for SessionListLine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} · {} · {}", self.name, self.id, self.provider)?;
        if let Some(model) = &self.model {
            write!(formatter, " {model}")?;
        }
        if let Some(project) = &self.project {
            write!(formatter, " · {project}")?;
        }
        write!(formatter, " · {}", self.computer)?;
        if self.is_calling_session {
            return formatter.write_str(" · this session");
        }
        write!(formatter, " · {}", self.state)?;
        match &self.last_message {
            Some(last_message) => write!(formatter, " · last: \"{last_message}\""),
            None => Ok(()),
        }
    }
}

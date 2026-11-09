//! `session_ask`: a question a hidden copy of another session answers once, leaving the session
//! itself untold and unchanged.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{SessionReference, ToolDescription, text_field};

/// How `session_ask` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_ask`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_ask",
    summary: "Ask another session a question without disturbing it. A hidden copy of that \
              session, with its whole conversation, answers once and is then deleted. The \
              session itself is never told and nothing in it changes.",
    body: "{\"session\": \"review-bot\", \"question\": \"Which files have you flagged so far, \
           and why?\"}\n\nThe copy can read files and run commands that only read. It cannot \
           write, and it does not ask for approval; anything that would need approval is \
           refused, and it answers with what it can see. A copy of a Codex session the person \
           typed in a terminal also runs commands the person pre-approved in their own Codex \
           settings. Use session_send instead when you want the session itself to act or \
           remember.",
};

/// `session_ask`'s arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionAskArguments {
    /// The session whose copy answers.
    #[schemars(description = text_field("A session name or id.", SESSION_NAME_MAX_LEN))]
    pub session: SessionReference,
    /// The question.
    #[schemars(description = text_field("The question, self-contained.", usize::MAX))]
    pub question: FreeFormText<{ usize::MAX }>,
}

/// What the copy answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAskResult {
    /// The asked session's name.
    pub name: String,
    /// The copy's answer.
    pub answer: String,
}

impl fmt::Display for SessionAskResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} (copy) answered: {}", self.name, self.answer)
    }
}

/// The refusal of a question to the calling session itself, whose copy knows no more than it.
pub fn not_asked_self(name: &str) -> String {
    format!("Not asked: {name} is this session.")
}

//! `session_wait`: waits for sessions to finish their turn or to need the person, or lists what
//! the caller waits on. Its results are also what `session_send` and `session_start` answer with
//! `wait: true`. The daemon picks how it waits: where the call holds, it answers with the result;
//! where the call returns at once, the provider's driver words the line ending the caller's turn,
//! and a later turn brings the answer.

use std::fmt;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{SessionReference, ToolDescription, text_limits};

/// How `session_wait` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_wait`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_wait",
    summary: "Wait for one or more sessions to finish their current turn or to need the person, \
              and get each one's answer. Called with no sessions, it lists what you are still \
              waiting on.",
    body: "{\"sessions\": [\"builder\", \"tax-fix\"]}\n{}\n\nUse it for sessions you did not just \
           message or start: one you started earlier, or several at once. After session_send or \
           session_start, pass wait: true instead. Wait only when your next step needs the \
           result; meanwhile do work that does not depend on it.",
};

/// The words a model reads about the sessions to wait on.
fn sessions_words() -> String {
    format!(
        "Session names or ids. Returns as soon as any one finishes or needs the person. Omit to \
         list what you are waiting on. At least one when given, each {}",
        text_limits(SESSION_NAME_MAX_LEN)
    )
}

/// `session_wait`'s arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionWaitArguments {
    /// The sessions to wait on, at least one; absent lists what the caller already waits on.
    #[schemars(description = sessions_words())]
    #[schemars(extend("minItems" = 1))]
    #[garde(length(min = 1))]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(with = "Vec<SessionReference>")]
    pub sessions: Option<Vec<SessionReference>>,
}

/// How the caller came to wait on a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOrigin {
    /// The caller's message started the session's turn.
    YourMessage,
    /// The caller started the session.
    StartedByYou,
}

/// One session the caller waits on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitEntry {
    /// The session's name.
    pub name: String,
    /// How the wait began.
    pub started: WaitOrigin,
    /// How long ago the wait began.
    pub since: Duration,
}

impl fmt::Display for WaitEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let origin = match self.started {
            WaitOrigin::YourMessage => "your message",
            WaitOrigin::StartedByYou => "started by you",
        };
        let age = match self.since.as_secs() / 60 {
            0 => "just now".to_owned(),
            minutes => format!("{minutes} min ago"),
        };
        write!(formatter, "{} ({origin}, {age})", self.name)
    }
}

/// What a held wait answers, the same on every provider: the awaited session's result, or the list
/// of what the caller waits on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionWaitResult {
    /// The awaited session finished its turn.
    Finished {
        /// The session's name.
        name: String,
        /// Its answer.
        answer: String,
    },
    /// The awaited session needs the person.
    NeedsPerson {
        /// The session's name.
        name: String,
        /// What it asks the person.
        what: String,
    },
    /// The sessions the caller waits on, oldest wait first.
    Waiting(Vec<WaitEntry>),
}

impl fmt::Display for SessionWaitResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Finished { name, answer } => write!(formatter, "{name} finished: {answer}"),
            Self::NeedsPerson { name, what } => {
                write!(formatter, "{name} needs the person: {what}")
            }
            Self::Waiting(entries) if entries.is_empty() => {
                formatter.write_str("Not waiting on any session.")
            }
            Self::Waiting(entries) => {
                let listed: Vec<String> = entries.iter().map(WaitEntry::to_string).collect();
                write!(formatter, "Waiting on: {}.", listed.join(", "))
            }
        }
    }
}

/// The refusal to wait on the calling session itself, a turn that would wait on its own end.
pub fn not_waiting_self(name: &str) -> String {
    format!(
        "Not waiting: {name} is this session, and this turn cannot end while it waits on itself."
    )
}

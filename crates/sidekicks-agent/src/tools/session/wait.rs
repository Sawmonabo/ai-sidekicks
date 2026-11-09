//! `session_wait`: waits for sessions to finish their turn or to need the person, or lists what
//! the caller waits on. Its results are also what `session_send` and `session_start` answer with
//! `wait: true`. The daemon picks how it waits: where the call holds, it answers with the result;
//! where the call returns at once, the provider's driver words the line ending the caller's turn,
//! and a later turn brings the answer.

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
           result; meanwhile do work that does not depend on it. When a session failed, its \
           outcome is unknown: check what it did before redoing its work.",
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

/// The refusal to wait on the calling session itself, a turn that would wait on its own end.
pub fn not_waiting_self(name: &str) -> String {
    format!(
        "Not waiting: {name} is this session, and this turn cannot end while it waits on itself."
    )
}

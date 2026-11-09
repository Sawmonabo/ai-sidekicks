//! What a session wait answers on Claude Code, where the call is held until an awaited session
//! finishes its turn or needs the person: that session's answer or its question.

use crate::driver::session_messages::SessionWaitEnd;

/// The text a held wait on `name` answers with once it ends as `end`.
pub(crate) fn compose_claude_wait_end_text(name: &str, end: &SessionWaitEnd) -> String {
    match end {
        SessionWaitEnd::Finished { answer } => format!("{name} finished: {answer}"),
        SessionWaitEnd::NeedsPerson { what } => format!("{name} needs the person: {what}"),
    }
}

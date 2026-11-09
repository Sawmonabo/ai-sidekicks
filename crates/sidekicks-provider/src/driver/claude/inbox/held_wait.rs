//! What a session wait answers on Claude Code, where the call is held until an awaited session
//! finishes its turn or needs the person: that session's answer or its question, or, for a wait
//! called with no sessions, what the caller is still waiting on and since when.

#![expect(
    dead_code,
    reason = "the wait tool reads these texts through the driver interface"
)]

/// How a held wait ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeWaitEnd<'a> {
    /// The awaited session finished the turn the wait was on.
    Finished {
        /// The awaited session's name.
        name: &'a str,
        /// Its answer.
        answer: &'a str,
    },
    /// The awaited session needs the person.
    NeedsPerson {
        /// The awaited session's name.
        name: &'a str,
        /// What it is asking the person.
        what: &'a str,
    },
}

/// Why the caller waits on a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeWaitCause {
    /// The caller sent it a message.
    YourMessage,
    /// The caller started it.
    StartedByYou,
}

/// One session the caller still waits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeAwaitedSession<'a> {
    /// The awaited session's name.
    pub(crate) name: &'a str,
    /// Why the caller waits on it.
    pub(crate) cause: ClaudeWaitCause,
    /// When the wait began.
    pub(crate) since: jiff::Timestamp,
}

/// The text a held wait answers with once it ends as `end`.
pub(crate) fn compose_claude_wait_end_text(end: ClaudeWaitEnd<'_>) -> String {
    match end {
        ClaudeWaitEnd::Finished { name, answer } => format!("{name} finished: {answer}"),
        ClaudeWaitEnd::NeedsPerson { name, what } => format!("{name} needs the person: {what}"),
    }
}

/// The text a wait called with no sessions answers with at `now`, each session with why it is
/// awaited and how many whole minutes ago that began, in the order given; `None` where the caller
/// waits on none.
pub(crate) fn compose_claude_waiting_on_text(
    awaited: &[ClaudeAwaitedSession<'_>],
    now: jiff::Timestamp,
) -> Option<String> {
    if awaited.is_empty() {
        return None;
    }
    let sessions: Vec<String> = awaited
        .iter()
        .map(|session| {
            let cause = match session.cause {
                ClaudeWaitCause::YourMessage => "your message",
                ClaudeWaitCause::StartedByYou => "started by you",
            };
            let minutes = now.duration_since(session.since).as_secs().max(0) / 60;
            format!("{} ({cause}, {minutes} min ago)", session.name)
        })
        .collect();
    Some(format!("Waiting on: {}.", sessions.join(", ")))
}

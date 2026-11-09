//! What every message between sessions shares, whichever driver delivers it or tool writes it: the
//! time form its texts use, a delivery the daemon hands a driver and what became of it, and the
//! cases a wait is worded in.

use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;

/// How a session message writes a time: on the person's clock, 12-hour, as `3:42 PM`; a
/// `jiff` `strftime` format.
pub const PERSON_CLOCK_TIME_FORMAT: &str = "%-I:%M %p";

/// The words for a name no session has, which the session tools and a driver's send hook both
/// answer with.
pub fn no_session_named(name: &str) -> String {
    format!("No session named \"{name}\". Call session_list to see the sessions.")
}

/// A text the daemon delivers into a session: another session's message, the wake-up of a wait,
/// or a reminder coming due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionMessageDelivery {
    /// The receiving session.
    pub target: SessionMessageTarget,
    /// The daemon's id for the delivery, a UUID it minted, which the provider carries back and
    /// every reading of it names.
    pub message_id: QueueItemId,
    /// The session the text comes from: the sender, the awaited session, or for a reminder the
    /// receiving session itself.
    pub sender_session_id: SessionId,
    /// That session's name.
    pub sender_name: String,
    /// What is delivered.
    pub kind: SessionMessageKind,
}

/// The session a delivery goes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionMessageTarget {
    /// A session the daemon hosts.
    Hosted(SessionId),
    /// A session a person typed in a terminal, by the provider's own id for it.
    Terminal(String),
}

/// What a delivery carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionMessageKind {
    /// Another session's message.
    Message {
        /// The message's words.
        body: String,
        /// The sender's permission level, which tells the receiver whether the sender bypasses
        /// permission prompts.
        sender_level: PermissionLevel,
        /// The reply chain the message carries on, in the order received; empty where no chain
        /// reached the sender's run.
        hop_chain: Vec<String>,
    },
    /// The end of a wait the receiving session's earlier call answered at once.
    WakeUp(SessionWaitEnd),
    /// A reminder the receiving session set coming due.
    Reminder {
        /// When it was set, on the person's clock.
        set_at: jiff::Zoned,
        /// When it was due.
        due_at: jiff::Zoned,
        /// The note the session wrote itself.
        note: String,
    },
}

/// How an awaited session ended the wait on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionWaitEnd {
    /// It finished the turn the wait was on.
    Finished {
        /// Its answer.
        answer: String,
    },
    /// It needs the person.
    NeedsPerson {
        /// What it is asking the person.
        what: String,
    },
}

/// What a driver did with a delivery: sent on to the provider, which says nothing yet of its
/// arrival, or refused with the provider's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionMessageSent {
    /// Written to the provider, or held by the daemon for the receiver's next chance; what becomes
    /// of it comes back as readings keyed by its id.
    Sent,
    /// The provider, or the receiver's reach, refused it.
    Refused {
        /// The refusal in the provider's words.
        words: String,
    },
}

/// A case of a session wait that a driver words for the wait tool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionWaitWording {
    /// A wait on `name` was just called; a driver whose provider answers the call at once words
    /// the line ending the caller's turn.
    Called {
        /// The awaited session's name.
        name: String,
    },
    /// The awaited session `name` ended a call the provider held open.
    Ended {
        /// The awaited session's name.
        name: String,
        /// How it ended the wait.
        end: SessionWaitEnd,
    },
    /// A wait called with no sessions at `now`: what the caller still waits on, in that order.
    Pending {
        /// The sessions waited on.
        awaited: Vec<AwaitedSession>,
        /// The time the ages are read at.
        now: jiff::Timestamp,
    },
}

/// Why the caller waits on a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitCause {
    /// The caller sent it a message.
    YourMessage,
    /// The caller started it.
    StartedByYou,
}

/// One session the caller still waits on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AwaitedSession {
    /// The awaited session's name.
    pub name: String,
    /// Why the caller waits on it.
    pub cause: WaitCause,
    /// When the wait began.
    pub since: jiff::Timestamp,
}

/// The line a wait called with no sessions answers at `now`, the one composer of it every
/// provider and the wait tool use: each session with why it is awaited and how many whole minutes
/// ago that began (`just now` under a minute), in the order given, or that the caller waits on
/// none.
pub fn compose_waiting_on_text(awaited: &[AwaitedSession], now: jiff::Timestamp) -> String {
    if awaited.is_empty() {
        return "Not waiting on any session.".to_owned();
    }
    let sessions: Vec<String> = awaited
        .iter()
        .map(|session| {
            let cause = match session.cause {
                WaitCause::YourMessage => "your message",
                WaitCause::StartedByYou => "started by you",
            };
            let age = match now.duration_since(session.since).as_secs().max(0) / 60 {
                0 => "just now".to_owned(),
                minutes => format!("{minutes} min ago"),
            };
            format!("{} ({cause}, {age})", session.name)
        })
        .collect();
    format!("Waiting on: {}.", sessions.join(", "))
}

//! Where a driver reports what became of a message between sessions, as the provider tells it:
//! a held, let-in, refused or undelivered message, a peer message a hosted session took in, and a
//! message another session sent to the daemon's own address. The provider's ids are untrusted, so
//! each is kept as the provider wrote it. A reading made before the publisher is registered is
//! dropped.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// The session message readings' intake, registered through a `PortRegistration`. It never blocks
/// or fails back into the provider's stream.
pub trait SessionMessageReadingPublisher: Send + Sync {
    /// Takes one reading.
    fn publish(&self, reading: SessionMessageReading);
}

/// One thing the provider told of a message between sessions, each message named by the id the
/// provider gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionMessageReading {
    /// The receiver holds the message until its person lets it in.
    Held {
        /// The message's id.
        message_id: String,
    },
    /// A held message the receiver let in; a message taken at once reads as its `Arrived`, never
    /// as this.
    Delivered {
        /// The message's id.
        message_id: String,
    },
    /// The receiver, or a guard on the way, refused the message.
    Refused {
        /// The message's id.
        message_id: String,
        /// The provider's sentence about the refusal, where it sent one.
        reason: Option<String>,
        /// For a drop, the token naming the guard that dropped it, such as `hop-runaway`.
        drop_reason: Option<String>,
    },
    /// The message ended without reaching its receiver, such as a hold that expired.
    NotDelivered {
        /// The message's id.
        message_id: String,
    },
    /// A hosted session took in a message another session sent.
    Arrived(SessionMessageArrival),
    /// A session sent a message to the daemon's own address.
    FarReply(SessionFarReply),
}

/// A message a hosted session took in from another session, as its stream shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMessageArrival {
    /// The session that took the message in.
    pub session_id: SessionId,
    /// The run holding the session's turn as it arrived; `None` for a message replayed while no
    /// run held the turn, which the next turn starts with.
    pub run_id: Option<RunId>,
    /// The id the message arrived under, the daemon's own id for a message it sent.
    pub message_id: String,
    /// The id the sender gave the message; a merged arrival of several carries its first one's.
    pub sender_message_id: Option<String>,
    /// The sender's address.
    pub from: String,
    /// The sender's session id, where the provider names it.
    pub from_session: Option<String>,
    /// The sender's name, where it has one.
    pub from_name: Option<String>,
    /// The ids of the sessions the message passed through, oldest first.
    pub hop_chain: Vec<String>,
    /// The sending process's id, as the operating system verified it.
    pub sender_process_id: Option<u32>,
    /// The message's text, where the provider sent it.
    pub body: Option<String>,
    /// Whether the message starts its turn rather than joining one already under way.
    pub is_turn_start: bool,
}

/// A message a session sent to the daemon's own address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFarReply {
    /// The address the sending session declared.
    pub from: String,
    /// The message's own id.
    pub message_id: String,
    /// The message's text.
    pub body: String,
    /// The ids of the sessions the message passed through, oldest first.
    pub hop_chain: Vec<String>,
    /// The sending session's name, where it has one.
    pub from_name: Option<String>,
}

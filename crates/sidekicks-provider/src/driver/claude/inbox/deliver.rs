//! A message the daemon delivers into a Claude Code session, written as one frame to the session's
//! inbox from the daemon's own: the frame's `uuid` and `msg_id` are both the daemon's message id,
//! and its `<cross-session-message>` element is written exactly as Claude Code writes one, since
//! Claude Code parses an element only when it would write the same text back, and its own loop
//! guard reads the chain only from a parsed element. A session the daemon hosts is written to at
//! its own inbox, which wakes it where it sleeps; a session the person runs in a terminal also has
//! its reply awaited from before the write and is asked for an idle notice after it.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::connect_unix_domain_socket;
use tokio::io::AsyncWriteExt as _;
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory as _};
use uuid::Uuid;

use crate::driver::claude::inbox::forward::SOCKET_ADDRESS_PREFIX;
use crate::driver::claude::inbox::listener::ClaudeSessionInboxes;
use crate::driver::claude::inbox::receipts::{
    ELEMENT_CLOSING, ELEMENT_OPENING, HOP_CHAIN_SEPARATOR,
};
use crate::driver::claude::live_sessions::{ClaudeLiveSession, read_live_sessions};
use crate::driver::claude::session::conversation_file::peer_replies::{
    ClaudePeerReplies, ClaudePeerReplyWait,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_messages::{
    SessionMessageDelivery, SessionMessageKind, SessionMessageSent, SessionMessageTarget,
    no_session_named,
};

/// The frame version Claude Code's own sender writes.
const FRAME_VERSION: u8 = 1;

/// The priority Claude Code's own sender gives a message: taken at the receiver's next chance.
const FRAME_PRIORITY: &str = "next";

/// The control action that asks a session for one notice when it next goes idle.
const IDLE_NOTICE_REQUEST_ACTION: &str = "notify_when_idle";

/// The longest sender name Claude Code keeps, in characters, before its ellipsis.
const SENDER_NAME_MAX_CHARACTERS: usize = 64;

/// A message the daemon delivers into a Claude Code session.
pub(crate) struct ClaudePeerMessage<'a> {
    /// The daemon's id for the message, minted as a UUID: a record joins its turn only when its
    /// `uuid` parses as one, and the stream's peer reader keys the arrival on it.
    pub(crate) message_id: Uuid,
    /// The sending session.
    pub(crate) sender_session_id: SessionId,
    /// The sending session's name.
    pub(crate) sender_name: &'a str,
    /// The sending session's permission level, which tells the receiver whether the sender
    /// bypasses permission prompts.
    pub(crate) sender_level: PermissionLevel,
    /// The reply chain the message carries on, as received; empty where no chain reached it.
    pub(crate) hop_chain: &'a [String],
    /// The message's words.
    pub(crate) body: &'a str,
}

/// The session a message is written to.
pub(crate) enum ClaudeInboxReceiver<'a> {
    /// A session the daemon hosts, at its inbox, which passes the frame to its live process.
    Hosted {
        /// The session's inbox.
        inbox: &'a Path,
    },
    /// A session the person runs in a terminal, as the live-session registry names it.
    Terminal(&'a ClaudeLiveSession),
}

/// A message written whole to its receiver's inbox: sent, which says nothing of its delivery.
pub(crate) struct ClaudeInboxSent {
    /// The wait for a terminal receiver's reply, which settles at its idle notice and stops
    /// awaiting the reply when dropped; `None` for a hosted receiver, whose stream shows it.
    pub(crate) reply_wait: Option<ClaudePeerReplyWait>,
}

/// Why a message did not reach its receiver's inbox whole.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeInboxDeliveryError {
    /// The terminal receiver is gone: the registry no longer lists it, or its row names no
    /// inbox.
    #[error("the terminal session is gone")]
    Gone,
    /// The receiver's reply could not be awaited, so nothing was written.
    #[error("the session's reply could not be awaited: {0}")]
    ReplyUnawaited(#[source] io::Error),
    /// The inbox refused the connection or the write, in the system's words.
    #[error("{0}")]
    Refused(#[source] io::Error),
    /// The delivery is a wake-up or a reminder, which Claude Code is never sent: its waits hold
    /// the call, and it keeps reminders of its own.
    #[error("Claude Code is sent no wake-up or reminder: its waits hold the call")]
    NotAMessage,
}

/// Delivers `delivery`, another session's message, into a Claude Code session from the daemon's
/// inbox: a hosted session's to its own inbox, a terminal session's to the socket its registry
/// file names, found in the registry folders `registry_folders` reads, its reply kept awaited until
/// its idle notice. Answers `Refused` with the no-session words where a terminal receiver is gone
/// and with the system's words where its inbox refused the frame. Fails for a wake-up or a
/// reminder, as the registry folders' read fails, and as the reply's wait fails.
pub(crate) async fn deliver_claude_session_message(
    inboxes: &ClaudeSessionInboxes,
    registry_folders: BoxFuture<'_, Result<Vec<PathBuf>, DriverError>>,
    delivery: &SessionMessageDelivery,
) -> Result<SessionMessageSent, DriverError> {
    let SessionMessageKind::Message {
        body,
        sender_level,
        hop_chain,
    } = &delivery.kind
    else {
        return Err(DriverError::Internal(Box::new(
            ClaudeInboxDeliveryError::NotAMessage,
        )));
    };
    let message = ClaudePeerMessage {
        message_id: Uuid::from(delivery.message_id),
        sender_session_id: delivery.sender_session_id,
        sender_name: &delivery.sender_name,
        sender_level: *sender_level,
        hop_chain,
        body,
    };
    let daemon_inbox = inboxes.daemon_inbox_address();
    let peer_replies = inboxes.peer_replies();
    let written = match &delivery.target {
        SessionMessageTarget::Hosted(session_id) => {
            let inbox = inboxes.session_inbox_address(*session_id);
            let receiver = ClaudeInboxReceiver::Hosted {
                inbox: Path::new(inbox.as_str()),
            };
            deliver_claude_peer_message(daemon_inbox.as_str(), peer_replies, receiver, &message)
                .await
        }
        SessionMessageTarget::Terminal(provider_session_id) => {
            let sessions = read_live_sessions(&registry_folders.await?).await;
            match sessions
                .iter()
                .find(|session| session.session_id.as_ref() == Some(provider_session_id))
            {
                Some(session) => {
                    let receiver = ClaudeInboxReceiver::Terminal(session);
                    deliver_claude_peer_message(
                        daemon_inbox.as_str(),
                        peer_replies,
                        receiver,
                        &message,
                    )
                    .await
                }
                None => Err(ClaudeInboxDeliveryError::Gone),
            }
        }
    };
    match written {
        Ok(ClaudeInboxSent { reply_wait }) => {
            if let Some(reply_wait) = reply_wait {
                peer_replies.keep_until_idle(reply_wait);
            }
            Ok(SessionMessageSent::Sent)
        }
        // A session that is gone is named as no session, in the words a lookup uses, by the id
        // the message was sent to.
        Err(ClaudeInboxDeliveryError::Gone) => Ok(SessionMessageSent::Refused {
            words: no_session_named(&match &delivery.target {
                SessionMessageTarget::Hosted(session_id) => session_id.to_string(),
                SessionMessageTarget::Terminal(provider_session_id) => provider_session_id.clone(),
            }),
        }),
        Err(refusal @ ClaudeInboxDeliveryError::Refused(_)) => Ok(SessionMessageSent::Refused {
            words: refusal.to_string(),
        }),
        Err(error) => Err(DriverError::Internal(Box::new(error))),
    }
}

/// Writes `message` to `receiver`'s inbox from `daemon_inbox`, the daemon's own. A terminal
/// receiver's reply is awaited in `peer_replies` before the message is written, and its idle
/// notice asked for after it under a fresh id. Answers sent, never delivered; fails as
/// [`ClaudeInboxDeliveryError`] says.
pub(crate) async fn deliver_claude_peer_message(
    daemon_inbox: &str,
    peer_replies: &Arc<ClaudePeerReplies>,
    receiver: ClaudeInboxReceiver<'_>,
    message: &ClaudePeerMessage<'_>,
) -> Result<ClaudeInboxSent, ClaudeInboxDeliveryError> {
    let from = format!("{SOCKET_ADDRESS_PREFIX}{daemon_inbox}");
    let frame = compose_message_frame(&from, message);
    match receiver {
        ClaudeInboxReceiver::Hosted { inbox } => {
            write_frame(inbox, &frame)
                .await
                .map_err(ClaudeInboxDeliveryError::Refused)?;
            Ok(ClaudeInboxSent { reply_wait: None })
        }
        ClaudeInboxReceiver::Terminal(session) => {
            let inbox = session
                .socket
                .as_deref()
                .ok_or(ClaudeInboxDeliveryError::Gone)?;
            let notice_id = mint_uuid_v7();
            let reply_wait = peer_replies
                .await_reply(
                    session,
                    message.message_id.to_string(),
                    notice_id.to_string(),
                )
                .await
                .map_err(ClaudeInboxDeliveryError::ReplyUnawaited)?;
            write_frame(inbox, &frame)
                .await
                .map_err(ClaudeInboxDeliveryError::Refused)?;
            let notice_request = json!({
                "msgV": FRAME_VERSION,
                "type": "control",
                "action": IDLE_NOTICE_REQUEST_ACTION,
                "msg_id": notice_id.to_string(),
                "from": from,
                "from_mode": sender_mode(message.sender_level),
            });
            // The message is in, so the delivery stands; only the wait for its reply is lost.
            if let Err(error) = write_frame(inbox, &notice_request).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a terminal session's idle notice could not be asked for, so its reply to a \
                     message is not awaited"
                );
                return Ok(ClaudeInboxSent { reply_wait: None });
            }
            Ok(ClaudeInboxSent {
                reply_wait: Some(reply_wait),
            })
        }
    }
}

// The `user` frame carrying `message` from `from`, under the daemon's id as both its `uuid` and
// its `msg_id`.
fn compose_message_frame(from: &str, message: &ClaudePeerMessage<'_>) -> Value {
    let message_id = message.message_id.to_string();
    json!({
        "msgV": FRAME_VERSION,
        "type": "user",
        "uuid": message_id,
        "msg_id": message_id,
        "message": {"role": "user", "content": compose_message_element(from, message)},
        "priority": FRAME_PRIORITY,
        "from": from,
    })
}

// The element as Claude Code writes one: `from`, `from-session`, `hop-chain` and `from-name` in
// that order, each left out where empty, then `from-mode`, and the body on lines of its own.
fn compose_message_element(from: &str, message: &ClaudePeerMessage<'_>) -> String {
    let hop_chain = if message.hop_chain.is_empty() {
        String::new()
    } else {
        format!(
            " hop-chain=\"{}\"",
            message.hop_chain.join(HOP_CHAIN_SEPARATOR)
        )
    };
    let name = compose_sender_name(message.sender_name);
    let from_name = if name.is_empty() {
        String::new()
    } else {
        format!(" from-name=\"{name}\"")
    };
    format!(
        "{ELEMENT_OPENING} from=\"{from}\" from-session=\"{}\"{hop_chain}{from_name} \
         from-mode=\"{}\">\n{}{ELEMENT_CLOSING}",
        message.sender_session_id,
        sender_mode(message.sender_level),
        message.body
    )
}

// A sender name as Claude Code keeps one: no quote or angle bracket, no control, format,
// line-separator or paragraph-separator character, trimmed, and cut at 64 characters with an
// ellipsis.
fn compose_sender_name(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|character| {
            !matches!(character, '"' | '<' | '>')
                && !matches!(
                    character.general_category(),
                    GeneralCategory::Control
                        | GeneralCategory::Format
                        | GeneralCategory::LineSeparator
                        | GeneralCategory::ParagraphSeparator
                )
        })
        .collect();
    let trimmed = kept.trim_matches(is_ecmascript_whitespace);
    if trimmed.chars().count() > SENDER_NAME_MAX_CHARACTERS {
        let cut: String = trimmed.chars().take(SENDER_NAME_MAX_CHARACTERS).collect();
        format!("{cut}\u{2026}")
    } else {
        trimmed.to_owned()
    }
}

// How the sender tells the receiver its permission class: Claude Code holds a message from a
// session that bypasses permission prompts unless the receiver bypasses them too.
fn sender_mode(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::Yolo => "bypass",
        PermissionLevel::Readonly
        | PermissionLevel::Ask
        | PermissionLevel::Reviewed
        | PermissionLevel::Sandboxed => "prompting",
    }
}

// Writes `frame` as one line on a connection of its own to `inbox`, as Claude Code's own sender
// does, and closes it; Claude Code writes nothing back on it.
async fn write_frame(inbox: &Path, frame: &Value) -> io::Result<()> {
    let mut line = serde_json::to_vec(frame).expect("a frame serializes");
    line.push(b'\n');
    let mut connection = connect_unix_domain_socket(inbox).await?;
    connection.write_all(&line).await?;
    connection.shutdown().await
}

#[cfg(test)]
mod tests;

//! What Claude Code writes back to the daemon's own inbox about a message the daemon sent itself:
//! the status of that message, the notice that its receiver went idle, and the reply a session
//! sends to the daemon's address. Each is read as Claude Code writes it and turned into the
//! session message readings it tells; nothing here answers it.

use std::collections::HashSet;

use serde::Deserialize;

use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::{LenientList, read_lenient};
use crate::port::session_message_reading_publisher::{SessionFarReply, SessionMessageReading};

/// The control action reporting what became of a message: delivered, held, dropped or expired.
const MESSAGE_STATUS_ACTION: &str = "peer_message_status";

/// The control action reporting that a message's receiver went idle.
const IDLE_NOTICE_ACTION: &str = "peer_idle_notice";

/// How a `<cross-session-message>` element opens, before its attributes.
pub(super) const ELEMENT_OPENING: &str = "<cross-session-message";

/// How a `<cross-session-message>` element closes, after its body's last line.
pub(super) const ELEMENT_CLOSING: &str = "\n</cross-session-message>";

/// What separates the session ids in an element's `hop-chain` attribute.
pub(super) const HOP_CHAIN_SEPARATOR: &str = ",";

/// One frame Claude Code wrote to the daemon's inbox about a message the daemon sent, each named by
/// the id of the message it is about.
#[derive(Debug)]
pub(crate) enum ClaudeInboxReceipt {
    /// What became of the message `orig_msg_id`: `status` in Claude Code's words, `status_detail`
    /// saying why an `expired` one ended (`refused` where its receiver refused it), `drop_reason`
    /// naming the guard that dropped a `dropped` one, and `reason`, Claude Code's sentence.
    MessageStatus {
        /// The id of the message the status is about.
        orig_msg_id: String,
        /// `delivered`, `held`, `dropped`, `expired` or `denied`.
        status: String,
        /// Why an `expired` message ended, where Claude Code says.
        status_detail: Option<String>,
        /// The guard that dropped a `dropped` message, such as `hop-runaway`.
        drop_reason: Option<String>,
        /// Claude Code's fixed sentence about the status.
        reason: Option<String>,
        /// Every message one `dropped` status coalesces, `orig_msg_id` the last of them; empty
        /// where Claude Code lists none.
        dropped_msg_ids: Vec<String>,
    },
    /// The receiver of the message `orig_msg_id` went to `state`.
    IdleNotice {
        /// The id of the message whose receiver went idle.
        orig_msg_id: String,
        /// The receiver's state: `idle`, `exited` or `unavailable`.
        state: String,
    },
    /// A session's message to the daemon's address, read from its `<cross-session-message>`
    /// element with the wrapper stripped.
    FarReply {
        /// The address the replying session declared, its element's `from`.
        from: String,
        /// The reply's own message id.
        msg_id: String,
        /// The reply's text, without the element around it.
        body: String,
        /// The ids of the sessions the message passed through, oldest first.
        hop_chain: Vec<String>,
        /// The replying session's name, where it has one.
        from_name: Option<String>,
    },
}

/// One line the daemon's inbox received, by its `type`; any other type is no receipt.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum InboxFrame {
    Control(ControlFrame),
    User(UserFrame),
    #[serde(other)]
    Other,
}

/// A `control` frame's members a receipt reads, each read leniently, so a member of another type
/// reads as absent rather than failing the whole frame.
#[derive(Deserialize)]
struct ControlFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    action: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    orig_msg_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    status: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    status_detail: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    drop_reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    dropped_msg_ids: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    state: Option<String>,
}

/// A `user` frame's members a reply reads.
#[derive(Deserialize)]
struct UserFrame {
    msg_id: Option<String>,
    message: Option<UserMessage>,
}

/// A `user` frame's message, whose content Claude Code writes as one string.
#[derive(Deserialize)]
struct UserMessage {
    content: Option<String>,
}

/// The parts of one `<cross-session-message>` element a reply reads.
struct CrossSessionMessage {
    from: Option<String>,
    hop_chain: Vec<String>,
    from_name: Option<String>,
    body: String,
}

/// The receipt one line of the daemon's inbox holds: a `peer_message_status` or
/// `peer_idle_notice` control frame naming its `orig_msg_id`, or a `user` frame whose string
/// content is one `<cross-session-message>` element. `None` for any other line, an `auth` line,
/// a frame missing what its kind needs, or content Claude Code wrote as anything but a string.
pub(crate) fn read_receipt(line: &[u8]) -> Option<ClaudeInboxReceipt> {
    let frame = serde_json::from_str::<InboxFrame>(&decode_inbound_json(line)).ok()?;
    match frame {
        InboxFrame::Control(control) => read_control(control),
        InboxFrame::User(user) => read_far_reply(user),
        InboxFrame::Other => None,
    }
}

fn read_control(control: ControlFrame) -> Option<ClaudeInboxReceipt> {
    let orig_msg_id = control.orig_msg_id?;
    match control.action?.as_str() {
        MESSAGE_STATUS_ACTION => Some(ClaudeInboxReceipt::MessageStatus {
            orig_msg_id,
            status: control.status?,
            status_detail: control.status_detail,
            drop_reason: control.drop_reason,
            reason: control.reason,
            dropped_msg_ids: control
                .dropped_msg_ids
                .map(|LenientList(ids)| ids)
                .unwrap_or_default(),
        }),
        IDLE_NOTICE_ACTION => Some(ClaudeInboxReceipt::IdleNotice {
            orig_msg_id,
            state: control.state?,
        }),
        _ => None,
    }
}

fn read_far_reply(user: UserFrame) -> Option<ClaudeInboxReceipt> {
    let msg_id = user.msg_id?;
    let element = read_cross_session_message(&user.message?.content?)?;
    Some(ClaudeInboxReceipt::FarReply {
        from: element.from?,
        msg_id,
        body: element.body,
        hop_chain: element.hop_chain,
        from_name: element.from_name,
    })
}

/// The session message readings `receipt` tells: a status by what became of its message, one
/// refusal per message a `dropped` status coalesces, and a far reply as itself. A status of
/// another word, and an idle notice no reply wait awaits, tell none and are logged at debug.
pub(crate) fn session_message_readings(receipt: ClaudeInboxReceipt) -> Vec<SessionMessageReading> {
    match receipt {
        ClaudeInboxReceipt::MessageStatus {
            orig_msg_id,
            status,
            status_detail,
            drop_reason,
            reason,
            dropped_msg_ids,
        } => match status.as_str() {
            "held" => vec![SessionMessageReading::Held {
                message_id: orig_msg_id,
            }],
            "delivered" => vec![SessionMessageReading::Delivered {
                message_id: orig_msg_id,
            }],
            "expired" if status_detail.as_deref() == Some("refused") => {
                vec![SessionMessageReading::Refused {
                    message_id: orig_msg_id,
                    reason,
                    drop_reason: None,
                }]
            }
            "expired" => vec![SessionMessageReading::NotDelivered {
                message_id: orig_msg_id,
            }],
            // One receipt coalesces several drops; each message reads refused once.
            "dropped" => {
                let mut seen = HashSet::new();
                dropped_msg_ids
                    .into_iter()
                    .chain([orig_msg_id])
                    .filter(|message_id| seen.insert(message_id.clone()))
                    .map(|message_id| SessionMessageReading::Refused {
                        message_id,
                        reason: reason.clone(),
                        drop_reason: drop_reason.clone(),
                    })
                    .collect()
            }
            // Claude Code's own receipt reader takes `denied` as the receiver's refusal.
            "denied" => vec![SessionMessageReading::Refused {
                message_id: orig_msg_id,
                reason,
                drop_reason: None,
            }],
            _ => {
                tracing::debug!(
                    orig_msg_id = %orig_msg_id,
                    status = %status,
                    "the daemon's inbox read a message status it has no reading for"
                );
                Vec::new()
            }
        },
        ClaudeInboxReceipt::IdleNotice { orig_msg_id, state } => {
            tracing::debug!(
                orig_msg_id = %orig_msg_id,
                state = %state,
                "the daemon's inbox read an idle notice no reply wait awaits"
            );
            Vec::new()
        }
        ClaudeInboxReceipt::FarReply {
            from,
            msg_id,
            body,
            hop_chain,
            from_name,
        } => vec![SessionMessageReading::FarReply(SessionFarReply {
            from,
            message_id: msg_id,
            body,
            hop_chain,
            from_name,
        })],
    }
}

// One element as Claude Code writes it: `<cross-session-message` and its `name="value"`
// attributes, `>` and a newline, the body, a newline and the closing tag, with nothing around it.
// Claude Code writes no quote or angle bracket inside a value and escapes nothing, so a value runs
// to its closing quote and the body is taken as written; an attribute not read here is skipped.
fn read_cross_session_message(content: &str) -> Option<CrossSessionMessage> {
    let (mut attributes, rest) = content.strip_prefix(ELEMENT_OPENING)?.split_once(">\n")?;
    let body = rest.strip_suffix(ELEMENT_CLOSING)?;
    let mut element = CrossSessionMessage {
        from: None,
        hop_chain: Vec::new(),
        from_name: None,
        body: body.to_owned(),
    };
    while !attributes.is_empty() {
        let (name, rest) = attributes.strip_prefix(' ')?.split_once("=\"")?;
        let (value, rest) = rest.split_once('"')?;
        match name {
            "from" => element.from = Some(value.to_owned()),
            "hop-chain" => {
                element.hop_chain = value
                    .split(HOP_CHAIN_SEPARATOR)
                    .map(str::to_owned)
                    .collect();
            }
            "from-name" => element.from_name = Some(value.to_owned()),
            _ => {}
        }
        attributes = rest;
    }
    Some(element)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ClaudeInboxReceipt, read_receipt};

    fn read(frame: &serde_json::Value) -> Option<ClaudeInboxReceipt> {
        read_receipt(frame.to_string().as_bytes())
    }

    // Killed by a status read without its `orig_msg_id`, by a member of another type failing the
    // whole status (`status_detail` here), by the idle notice's `state` left unread, by the hop
    // chain kept as one string, by the body kept with its tags or newlines, and by an `auth` line
    // or a plain forwarded frame read as a receipt. The inbox's route proves the rest of a status.
    #[test]
    fn the_daemon_s_inbox_reads_each_receipt_claude_code_writes_and_nothing_else() {
        let delivered = read(&json!({"type": "control", "action": "peer_message_status",
            "status": "delivered", "status_detail": 3, "orig_msg_id": "m-1"}));
        let Some(ClaudeInboxReceipt::MessageStatus {
            orig_msg_id,
            status,
            status_detail,
            ..
        }) = delivered
        else {
            panic!("a status with a member of another type reads as a status: {delivered:?}");
        };
        assert_eq!(
            (orig_msg_id.as_str(), status.as_str(), status_detail),
            ("m-1", "delivered", None)
        );

        let idle = read(&json!({"type": "control", "action": "peer_idle_notice",
            "orig_msg_id": "m-2", "state": "idle", "finished_at": 1_790_000_000_123_i64}));
        let Some(ClaudeInboxReceipt::IdleNotice { orig_msg_id, state }) = idle else {
            panic!("an idle notice reads as one: {idle:?}");
        };
        assert_eq!((orig_msg_id.as_str(), state.as_str()), ("m-2", "idle"));

        let content = "<cross-session-message from=\"uds:/tmp/cc-socks/4101.sock\" \
            hop-chain=\"0123456789abcdef01234567,89abcdef0123456789abcdef\" from-name=\"builder\" \
            from-mode=\"prompting\">\namber\n</cross-session-message>";
        let reply = read(&json!({"msgV": 1, "msg_id": "m-3", "type": "user",
            "message": {"role": "user", "content": content},
            "priority": "next", "from": "uds:/tmp/cc-socks/4101.sock"}));
        let Some(ClaudeInboxReceipt::FarReply {
            from,
            msg_id,
            body,
            hop_chain,
            from_name,
        }) = reply
        else {
            panic!("a reply reads as one: {reply:?}");
        };
        assert_eq!(
            (
                from.as_str(),
                msg_id.as_str(),
                body.as_str(),
                from_name.as_deref()
            ),
            (
                "uds:/tmp/cc-socks/4101.sock",
                "m-3",
                "amber",
                Some("builder")
            )
        );
        assert_eq!(
            hop_chain,
            ["0123456789abcdef01234567", "89abcdef0123456789abcdef"]
        );

        for neither in [
            json!({"type": "control", "action": "peer_message_status", "status": "dropped"}),
            json!({"type": "auth", "token": "proof"}),
            json!({"type": "user", "from": "uds:/tmp/cc-socks/4101.sock", "msg_id": "m-4",
                "text": "hello"}),
        ] {
            assert!(read(&neither).is_none(), "{neither} is no receipt");
        }
    }
}

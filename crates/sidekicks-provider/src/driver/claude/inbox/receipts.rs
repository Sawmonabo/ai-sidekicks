//! What Claude Code writes back to the daemon's own inbox about a message the daemon sent itself:
//! the status of that message, the notice that its receiver went idle, and the reply a session
//! sends to the daemon's address. Each is read as Claude Code writes it; nothing here answers it.

use serde::Deserialize;

use crate::inbound_json::decode_inbound_json;

/// The control action reporting what became of a message: delivered, held, dropped or expired.
const MESSAGE_STATUS_ACTION: &str = "peer_message_status";

/// The control action reporting that a message's receiver went idle.
const IDLE_NOTICE_ACTION: &str = "peer_idle_notice";

/// How a reply's element opens, before its attributes.
const ELEMENT_OPENING: &str = "<cross-session-message";

/// How a reply's element closes, after its body's last line.
const ELEMENT_CLOSING: &str = "\n</cross-session-message>";

/// What separates the session ids in a reply's `hop-chain` attribute.
const HOP_CHAIN_SEPARATOR: char = ',';

/// One frame Claude Code wrote to the daemon's inbox about a message the daemon sent, each named by
/// the id of the message it is about.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the send states read the status, the idle notice and the reply"
    )
)]
#[derive(Debug)]
pub(crate) enum ClaudeInboxReceipt {
    /// What became of the message `orig_msg_id`: `status` in Claude Code's words, `status_detail`
    /// saying why an `expired` one ended (`refused` where its receiver refused it), and
    /// `drop_reason` naming the guard that dropped a `dropped` one.
    MessageStatus {
        /// The id of the message the status is about.
        orig_msg_id: String,
        /// `delivered`, `held`, `dropped` or `expired`.
        status: String,
        /// Why an `expired` message ended, where Claude Code says.
        status_detail: Option<String>,
        /// The guard that dropped a `dropped` message, such as `hop-runaway`.
        drop_reason: Option<String>,
    },
    /// The receiver of the message `orig_msg_id` went to `state`, at `finished_at`, the
    /// millisecond of its turn's end.
    IdleNotice {
        /// The id of the message whose receiver went idle.
        orig_msg_id: String,
        /// The receiver's state, `idle`.
        state: String,
        /// The millisecond the receiver's turn ended, since the Unix epoch.
        finished_at: Option<i64>,
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

/// Where the daemon's inbox hands each receipt it reads; the daemon's services take them from
/// here.
pub(crate) trait ClaudeInboxReceiptSink: Send + Sync {
    /// Takes one receipt the daemon's inbox read.
    fn receipt(&self, receipt: ClaudeInboxReceipt);
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

/// A `control` frame's members a receipt reads.
#[derive(Deserialize)]
struct ControlFrame {
    action: String,
    orig_msg_id: Option<String>,
    status: Option<String>,
    status_detail: Option<String>,
    drop_reason: Option<String>,
    state: Option<String>,
    finished_at: Option<i64>,
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
    match control.action.as_str() {
        MESSAGE_STATUS_ACTION => Some(ClaudeInboxReceipt::MessageStatus {
            orig_msg_id,
            status: control.status?,
            status_detail: control.status_detail,
            drop_reason: control.drop_reason,
        }),
        IDLE_NOTICE_ACTION => Some(ClaudeInboxReceipt::IdleNotice {
            orig_msg_id,
            state: control.state?,
            finished_at: control.finished_at,
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

    // Killed by a status read without its `orig_msg_id`, by `drop_reason` or `finished_at` left
    // unread, by the hop chain kept as one string, by the body kept with its tags or newlines, and
    // by an `auth` line or a plain forwarded frame read as a receipt.
    #[test]
    fn the_daemon_s_inbox_reads_each_receipt_claude_code_writes_and_nothing_else() {
        let dropped = read(&json!({"type": "control", "action": "peer_message_status",
            "status": "dropped", "reason": "dropped", "drop_reason": "hop-runaway",
            "orig_msg_id": "m-1", "from": "uds:/tmp/cc-socks/4101.sock"}));
        let Some(ClaudeInboxReceipt::MessageStatus {
            orig_msg_id,
            status,
            status_detail,
            drop_reason,
        }) = dropped
        else {
            panic!("a dropped status reads as a status: {dropped:?}");
        };
        assert_eq!(
            (
                orig_msg_id.as_str(),
                status.as_str(),
                status_detail,
                drop_reason.as_deref()
            ),
            ("m-1", "dropped", None, Some("hop-runaway"))
        );

        let idle = read(&json!({"type": "control", "action": "peer_idle_notice",
            "orig_msg_id": "m-2", "state": "idle", "finished_at": 1_790_000_000_123_i64}));
        let Some(ClaudeInboxReceipt::IdleNotice {
            orig_msg_id,
            state,
            finished_at,
        }) = idle
        else {
            panic!("an idle notice reads as one: {idle:?}");
        };
        assert_eq!(
            (orig_msg_id.as_str(), state.as_str(), finished_at),
            ("m-2", "idle", Some(1_790_000_000_123))
        );

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

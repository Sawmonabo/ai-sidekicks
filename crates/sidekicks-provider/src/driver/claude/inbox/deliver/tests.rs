//! A message written into a Claude Code session's inbox: one frame under the daemon's own id,
//! its element as Claude Code writes one, and for a terminal session the reply awaited from before
//! the write and the idle notice asked for after it.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, bind_socket_listener, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use uuid::Uuid;

use super::{
    ClaudeInboxDeliveryError, ClaudeInboxReceiver, ClaudeInboxSent, ClaudePeerMessage,
    deliver_claude_peer_message,
};
use crate::driver::claude::live_sessions::ClaudeLiveSession;
use crate::driver::claude::session::conversation_file::peer_replies::ClaudePeerReplies;
use crate::driver::claude::session::scripted::daemon_services::RecordingPorts;
use crate::driver::test_registry::new_session_id;
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};

/// How long a step may take before the test fails.
const PATIENCE: Duration = Duration::from_secs(10);

const DAEMON_INBOX: &str = "/tmp/cc-socks/daemon.sock";

const HOP: &str = "0123456789abcdef01234567";

// The replies, publishing to a recording.
fn recording_replies() -> (Arc<ClaudePeerReplies>, Arc<RecordingPorts>) {
    let recording = Arc::new(RecordingPorts::default());
    let readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>> =
        Arc::new(PortRegistration::new("session message readings"));
    readings
        .register(recording.clone())
        .expect("the readings register once");
    (Arc::new(ClaudePeerReplies::new(readings)), recording)
}

// The next line a connection to `listener` writes, as JSON.
async fn next_frame(listener: &Listener) -> Value {
    let connection = tokio::time::timeout(PATIENCE, listener.accept())
        .await
        .expect("a connection comes in time")
        .expect("the connection is accepted");
    let mut line = String::new();
    tokio::time::timeout(PATIENCE, BufReader::new(connection).read_line(&mut line))
        .await
        .expect("a line comes in time")
        .expect("the line reads");
    serde_json::from_str(&line).expect("the line is JSON")
}

// A terminal session listening at `socket`, its registry under `config_folder`.
fn terminal_session(
    config_folder: &Path,
    session_id: Option<&str>,
    socket: &Path,
) -> ClaudeLiveSession {
    ClaudeLiveSession {
        session_id: session_id.map(str::to_owned),
        name: Some("builder".to_owned()),
        status: None,
        socket: Some(socket.to_path_buf()),
        working_folder: Some(PathBuf::from("/work/app")),
        registry_file: config_folder.join("sessions").join("4101.json"),
        process_id: 4101,
    }
}

// Writes the test's message from `sender_session_id` under `message_id` to the hosted `inbox`.
async fn deliver_to_hosted(
    replies: &Arc<ClaudePeerReplies>,
    inbox: &Path,
    sender_session_id: SessionId,
    message_id: Uuid,
    hop_chain: &[String],
) -> Result<ClaudeInboxSent, ClaudeInboxDeliveryError> {
    let message = ClaudePeerMessage {
        message_id,
        sender_session_id,
        sender_name: " plan\"<ner>\u{200B} ",
        sender_level: PermissionLevel::Ask,
        hop_chain,
        body: "Use the new Money type.",
    };
    deliver_claude_peer_message(
        DAEMON_INBOX,
        replies,
        ClaudeInboxReceiver::Hosted { inbox },
        &message,
    )
    .await
}

// Killed by a fresh `uuid` per frame, by the sender's name written for its id in `from-session`,
// by a sender name kept with the quote, bracket or format character Claude Code strips (the
// element would lose its parse), by an empty chain written as `hop-chain=""`, and by `from` left
// as anything but the daemon's inbox.
#[tokio::test]
async fn a_hosted_session_gets_one_frame_under_the_daemon_s_id_from_the_daemon_s_inbox() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let inbox = scratch.path().join("session.sock");
    let listener = bind_socket_listener(&inbox).expect("the inbox listens");
    let (replies, _recording) = recording_replies();
    let sender_session_id = new_session_id();
    let message_id = mint_uuid_v7();
    let hop_chain = [HOP.to_owned()];

    let sent = deliver_to_hosted(&replies, &inbox, sender_session_id, message_id, &hop_chain)
        .await
        .expect("the frame is written");
    let frame = next_frame(&listener).await;
    deliver_to_hosted(&replies, &inbox, sender_session_id, message_id, &[])
        .await
        .expect("the frame is written");
    let unchained = next_frame(&listener).await;

    assert!(sent.reply_wait.is_none());
    let id = message_id.to_string();
    assert_eq!(frame["uuid"], json!(id));
    assert_eq!(frame["msg_id"], json!(id));
    Uuid::parse_str(frame["uuid"].as_str().expect("a uuid")).expect("the uuid parses");
    assert_eq!(frame["type"], "user");
    assert_eq!(frame["from"], json!(format!("uds:{DAEMON_INBOX}")));
    assert_eq!(
        frame["message"]["content"],
        json!(format!(
            "<cross-session-message from=\"uds:{DAEMON_INBOX}\" \
             from-session=\"{sender_session_id}\" hop-chain=\"{HOP}\" from-name=\"planner\" \
             from-mode=\"prompting\">\nUse the new Money type.\n</cross-session-message>"
        ))
    );
    assert_eq!(
        unchained["message"]["content"],
        json!(format!(
            "<cross-session-message from=\"uds:{DAEMON_INBOX}\" \
             from-session=\"{sender_session_id}\" from-name=\"planner\" \
             from-mode=\"prompting\">\nUse the new Money type.\n</cross-session-message>"
        ))
    );
}

// Killed by the reply awaited after the write (a wait that cannot start would follow a frame
// already written), by the idle notice asked for before the message or
// under the message's own id, and by the reply wait dropped on the way out (the notice would find
// no wait).
#[tokio::test]
async fn a_terminal_session_gets_the_message_then_its_idle_notice_with_the_reply_awaited_first() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let socket = scratch.path().join("terminal.sock");
    let listener = bind_socket_listener(&socket).expect("the terminal session listens");
    let config_folder = scratch.path().join("config");
    let project_folder = config_folder.join("projects").join("-work-app");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    let terminal_id = "0d9e8f7a-1111-4222-8333-444455556666";
    let transcript = project_folder.join(format!("{terminal_id}.jsonl"));
    std::fs::write(&transcript, "").expect("the transcript is made");
    let (replies, recording) = recording_replies();
    let message = ClaudePeerMessage {
        message_id: mint_uuid_v7(),
        sender_session_id: new_session_id(),
        sender_name: "planner",
        sender_level: PermissionLevel::Yolo,
        hop_chain: &[],
        body: "Ship it.",
    };

    let unnamed = terminal_session(&config_folder, None, &socket);
    let unawaited = deliver_claude_peer_message(
        DAEMON_INBOX,
        &replies,
        ClaudeInboxReceiver::Terminal(&unnamed),
        &message,
    )
    .await
    .err();
    assert!(
        matches!(unawaited, Some(ClaudeInboxDeliveryError::ReplyUnawaited(_))),
        "{unawaited:?}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err(),
        "nothing is written when the reply cannot be awaited"
    );

    let receiver = terminal_session(&config_folder, Some(terminal_id), &socket);
    let sent = deliver_claude_peer_message(
        DAEMON_INBOX,
        &replies,
        ClaudeInboxReceiver::Terminal(&receiver),
        &message,
    )
    .await
    .expect("the frames are written");
    let written = next_frame(&listener).await;
    let notice_request = next_frame(&listener).await;
    let message_id = message.message_id.to_string();
    let mut record = std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .expect("the transcript opens");
    writeln!(
        record,
        "{}",
        json!({"type": "user", "uuid": message_id, "parentUuid": null, "turnOrigin": "peer",
            "message": {"role": "user", "content": "Ship it."}})
    )
    .expect("the record is written");
    drop(record);
    let notice_id = notice_request["msg_id"]
        .as_str()
        .expect("the notice request names its id")
        .to_owned();

    assert_eq!(written["uuid"], json!(message_id));
    assert!(
        written["message"]["content"]
            .as_str()
            .is_some_and(|content| content
                .ends_with("from-mode=\"bypass\">\nShip it.\n</cross-session-message>")),
        "{written}"
    );
    assert_eq!(notice_request["type"], "control");
    assert_eq!(notice_request["action"], "notify_when_idle");
    assert_eq!(notice_request["from"], json!(format!("uds:{DAEMON_INBOX}")));
    assert_ne!(notice_id, message_id);
    assert!(replies.take_idle_notice(&notice_id).await);
    assert!(
        recording
            .message_readings()
            .contains(&SessionMessageReading::Delivered { message_id }),
        "{:?}",
        recording.message_readings()
    );
    drop(sent);
}

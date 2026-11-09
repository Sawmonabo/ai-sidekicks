//! A session's inbox across its sleep: the frame that reaches it asleep wakes it and arrives, the
//! inbox keeps its name, and Claude Code's answer finds the frame's own sender while what each
//! receipt the daemon's inbox reads tells reaches the session message readings.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::{BoxFuture, ready};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, UnixDomainStream, bind_socket_listener, connect_unix_domain_socket,
    short_socket_folder,
};
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

use super::ClaudeSessionInboxes;
use crate::driver::claude::inbox::deliver::deliver_claude_session_message;
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::scripted::daemon_services::RecordingPorts;
use crate::driver::claude::session::scripted::scripted_live_session;
use crate::driver::claude::session::slots::ClaudeSessionSlots;
use crate::driver::claude::session::transport::channel::MockClaudeProcessChannel;
use crate::driver::session_messages::{
    SessionMessageDelivery, SessionMessageKind, SessionMessageSent, SessionMessageTarget,
};
use crate::driver::test_registry::{new_message_id, new_session_id};
use crate::port::session_inbox_address::SessionInboxAddresser;
use crate::port::session_message_reading_publisher::{
    SessionFarReply, SessionMessageReading, SessionMessageReadingPublisher,
};
use crate::port::session_wake::SessionWaker;

/// How long a step of the exchange may take before the test fails.
const PATIENCE: Duration = Duration::from_secs(10);

// The session's inbox and the daemon's own as sockets in one scratch folder.
struct ScratchAddresser {
    folder: PathBuf,
}

impl SessionInboxAddresser for ScratchAddresser {
    fn session_inbox_address(
        &self,
        _session_id: &SessionId,
        _place: Option<&Place>,
    ) -> FilesystemPath {
        socket_address(&self.folder.join("session.sock"))
    }

    fn daemon_inbox_address(&self, _place: Option<&Place>) -> FilesystemPath {
        socket_address(&self.folder.join("daemon.sock"))
    }
}

fn socket_address(path: &Path) -> FilesystemPath {
    FilesystemPath::new(path.display().to_string()).expect("a scratch socket path is a path")
}

// Brings the session's process up on each wake, its inbox socket the one given.
struct ProcessWaker {
    slots: ClaudeSessionSlots,
    process_socket: PathBuf,
    wakes: AtomicUsize,
}

impl SessionWaker for ProcessWaker {
    fn wake_for_message(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        self.wakes.fetch_add(1, Ordering::SeqCst);
        let mut live = scripted_live_session(session_id, Arc::new(MockClaudeProcessChannel::new()));
        live.messaging_socket = Some(self.process_socket.clone());
        let installed =
            self.slots
                .claim_create(session_id)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)
                .and_then(|claim| {
                    claim.install(Arc::new(live)).map(drop).map_err(|live| {
                        format!("session {} was taken first", live.session_id).into()
                    })
                });
        async move { installed }.boxed()
    }
}

// The next complete line any connection to `listener` writes, as JSON.
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

// Writes each of `frames` as one line, in order, on a new connection to `socket`, held open until
// dropped.
async fn send_frames(socket: &Path, frames: &[Value]) -> UnixDomainStream {
    let mut connection = connect_unix_domain_socket(socket)
        .await
        .expect("the socket takes a connection");
    let mut lines = String::new();
    for frame in frames {
        lines.push_str(&frame.to_string());
        lines.push('\n');
    }
    connection
        .write_all(lines.as_bytes())
        .await
        .expect("the frames are written");
    connection
}

// Killed by a wake that binds the inbox again under another name (the second frame finds no
// listener), by a held first line dropped across the wake (the process reads nothing), by a frame
// passed on with its sender's own `from` (no answer could reach the daemon), by an answer not
// passed back to that sender, by a receipt tried before the route (the answer would be read as a
// receipt, not reach its sender), by a receipt or a line of neither kind sent to a sender, by the
// readings port read once at the bind (it is registered after), by a coalesced drop read for its
// `orig_msg_id` only or with an id repeated, and by a refused `expired` read as not delivered.
#[tokio::test]
async fn a_frame_to_a_sleeping_session_wakes_it_and_arrives_from_the_daemon_s_inbox() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let folder = scratch.path().to_path_buf();
    let process = bind_socket_listener(&folder.join("process.sock")).expect("the process listens");
    let sender_socket = folder.join("sender.sock");
    let sender = bind_socket_listener(&sender_socket).expect("the sender listens");
    let slots = ClaudeSessionSlots::new(Arc::new(|_predecessor| {}));
    let waker = Arc::new(ProcessWaker {
        slots: slots.clone(),
        process_socket: folder.join("process.sock"),
        wakes: AtomicUsize::new(0),
    });
    let wakes = Arc::new(PortRegistration::new("session wakes"));
    wakes
        .register(Arc::clone(&waker) as Arc<dyn SessionWaker>)
        .expect("the wake registers once");
    let addresser = ScratchAddresser {
        folder: folder.clone(),
    };
    let session_id = new_session_id();
    let session_inbox = addresser.session_inbox_address(&session_id, None);
    let daemon_inbox = addresser.daemon_inbox_address(None);
    let readings = Arc::new(PortRegistration::new("session message readings"));
    let inboxes = Arc::new(ClaudeSessionInboxes::new(
        Arc::new(addresser),
        wakes,
        slots,
        Arc::new(ClaudeIdleSleep::default()),
        Arc::clone(&readings),
    ));
    inboxes.bind(session_id).await;
    let recording = Arc::new(RecordingPorts::default());
    readings
        .register(Arc::clone(&recording) as Arc<dyn SessionMessageReadingPublisher>)
        .expect("the readings register once");

    let _asleep = send_frames(
        Path::new(session_inbox.as_str()),
        &[
            json!({"type": "user", "from": format!("uds:{}", sender_socket.display()),
            "msg_id": "first", "text": "hello"}),
        ],
    )
    .await;
    let arrived = next_frame(&process).await;
    let reply = "<cross-session-message from=\"uds:/tmp/cc-socks/4101.sock\" \
        hop-chain=\"0123456789abcdef01234567\" from-name=\"builder\">\namber\n\
        </cross-session-message>";
    // The answer goes last, so once it reaches the sender every line before it was read.
    let _receipts = send_frames(
        Path::new(daemon_inbox.as_str()),
        &[
            json!({"type": "control", "action": "peer_message_status", "status": "dropped",
                "drop_reason": "duplicate", "reason": "Dropped as a duplicate.",
                "orig_msg_id": "c", "dropped_msg_ids": ["a", "b", "c"]}),
            json!({"type": "control", "action": "peer_message_status", "status": "expired",
                "status_detail": "refused", "reason": "The receiver refused it.",
                "orig_msg_id": "refused"}),
            json!({"type": "control", "action": "peer_message_status", "status": "expired",
                "reason": "It expired.", "orig_msg_id": "expired"}),
            json!({"type": "control", "action": "peer_message_status", "status": "held",
                "reason": "Held for the person.", "orig_msg_id": "held"}),
            json!({"msgV": 1, "msg_id": "reply", "type": "user",
                "message": {"role": "user", "content": reply}}),
            json!({"type": "auth", "token": "proof"}),
            json!({"type": "control", "action": "peer_message_status", "status": "delivered",
                "from": "uds:/elsewhere.sock", "orig_msg_id": "first"}),
        ],
    )
    .await;
    let answered = next_frame(&sender).await;
    let _awake = send_frames(
        Path::new(session_inbox.as_str()),
        &[json!({"type": "user", "from": "uds:/other.sock", "msg_id": "second", "text": "again"})],
    )
    .await;
    let second = next_frame(&process).await;

    assert_eq!(waker.wakes.load(Ordering::SeqCst), 1);
    assert_eq!(arrived["text"], "hello");
    assert_eq!(arrived["msg_id"], "first");
    assert_eq!(arrived["from"], format!("uds:{}", daemon_inbox.as_str()));
    assert_eq!(answered["orig_msg_id"], "first");
    assert_eq!(answered["from"], format!("uds:{}", session_inbox.as_str()));
    assert_eq!(second["msg_id"], "second");
    let dropped = |message_id: &str| SessionMessageReading::Refused {
        message_id: message_id.to_owned(),
        reason: Some("Dropped as a duplicate.".to_owned()),
        drop_reason: Some("duplicate".to_owned()),
    };
    assert_eq!(
        recording.message_readings(),
        [
            dropped("a"),
            dropped("b"),
            dropped("c"),
            SessionMessageReading::Refused {
                message_id: "refused".to_owned(),
                reason: Some("The receiver refused it.".to_owned()),
                drop_reason: None,
            },
            SessionMessageReading::NotDelivered {
                message_id: "expired".to_owned(),
            },
            SessionMessageReading::Held {
                message_id: "held".to_owned(),
            },
            SessionMessageReading::FarReply(SessionFarReply {
                from: "uds:/tmp/cc-socks/4101.sock".to_owned(),
                message_id: "reply".to_owned(),
                body: "amber".to_owned(),
                hop_chain: vec!["0123456789abcdef01234567".to_owned()],
                from_name: Some("builder".to_owned()),
            }),
        ]
    );
    inboxes.release_all();
}

// Killed by the hosted arm writing to the session's process socket rather than its own inbox: the
// process would read the frame with no wake, which a sleeping session's dead process never would.
// And by the frame sent under a fresh id rather than the daemon's message id.
#[tokio::test]
async fn a_message_to_a_sleeping_session_goes_to_its_inbox_and_wakes_it() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let folder = scratch.path().to_path_buf();
    let process = bind_socket_listener(&folder.join("process.sock")).expect("the process listens");
    let slots = ClaudeSessionSlots::new(Arc::new(|_predecessor| {}));
    let waker = Arc::new(ProcessWaker {
        slots: slots.clone(),
        process_socket: folder.join("process.sock"),
        wakes: AtomicUsize::new(0),
    });
    let wakes = Arc::new(PortRegistration::new("session wakes"));
    wakes
        .register(Arc::clone(&waker) as Arc<dyn SessionWaker>)
        .expect("the wake registers once");
    let inboxes = Arc::new(ClaudeSessionInboxes::new(
        Arc::new(ScratchAddresser { folder }),
        wakes,
        slots,
        Arc::new(ClaudeIdleSleep::default()),
        Arc::new(PortRegistration::new("session message readings")),
    ));
    let session_id = new_session_id();
    inboxes.bind(session_id).await;
    let message_id = new_message_id();
    let delivery = SessionMessageDelivery {
        target: SessionMessageTarget::Hosted(session_id),
        message_id,
        sender_session_id: new_session_id(),
        sender_name: "planner".to_owned(),
        kind: SessionMessageKind::Message {
            body: "Use the new Money type.".to_owned(),
            sender_level: PermissionLevel::Ask,
            hop_chain: Vec::new(),
        },
    };

    let sent = deliver_claude_session_message(&inboxes, ready(Ok(Vec::new())).boxed(), &delivery)
        .await
        .expect("the message is written");
    let arrived = next_frame(&process).await;

    assert_eq!(sent, SessionMessageSent::Sent);
    assert_eq!(waker.wakes.load(Ordering::SeqCst), 1);
    assert_eq!(arrived["type"], "user");
    assert_eq!(arrived["uuid"], message_id.to_string());
    assert_eq!(arrived["msg_id"], message_id.to_string());
    inboxes.release_all();
}

// Wakes nothing: each wake fails, as one whose session could not be brought up.
struct FailingWaker;

impl SessionWaker for FailingWaker {
    fn wake_for_message(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        ready(Err("the session could not be woken".into())).boxed()
    }
}

// Killed by a failed wake that only records its failure: the message it lost would read nothing,
// and its send would never reach a final state.
#[tokio::test]
async fn a_message_whose_wake_fails_reads_not_delivered() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let folder = scratch.path().to_path_buf();
    let session_inbox = folder.join("session.sock");
    let wakes = Arc::new(PortRegistration::new("session wakes"));
    wakes
        .register(Arc::new(FailingWaker) as Arc<dyn SessionWaker>)
        .expect("the wake registers once");
    let readings = Arc::new(PortRegistration::new("session message readings"));
    let recording = Arc::new(RecordingPorts::default());
    readings
        .register(Arc::clone(&recording) as Arc<dyn SessionMessageReadingPublisher>)
        .expect("the readings register once");
    let inboxes = Arc::new(ClaudeSessionInboxes::new(
        Arc::new(ScratchAddresser { folder }),
        wakes,
        ClaudeSessionSlots::new(Arc::new(|_predecessor| {})),
        Arc::new(ClaudeIdleSleep::default()),
        readings,
    ));
    let session_id = new_session_id();
    inboxes.bind(session_id).await;

    let _asleep = send_frames(
        &session_inbox,
        &[
            json!({"type": "user", "from": "uds:/tmp/cc-socks/4101.sock", "msg_id": "lost",
            "text": "hello"}),
        ],
    )
    .await;
    tokio::time::timeout(PATIENCE, async {
        while recording.message_readings().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the lost message is read in time");

    assert_eq!(
        recording.message_readings(),
        [SessionMessageReading::NotDelivered {
            message_id: "lost".to_owned(),
        }]
    );
    inboxes.release_all();
}

// Killed by a name shared across a session's processes (a fork and the predecessor it replaces
// would bind one path), by a socket outside the inbox's folder, and by a folder left unmade, where
// a pinned socket has no fallback.
#[test]
fn each_process_socket_is_fresh_beside_the_session_s_inbox() {
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let folder = scratch.path().join("cc-socks");
    let addresser = ScratchAddresser {
        folder: folder.clone(),
    };
    let inboxes = ClaudeSessionInboxes::new(
        Arc::new(addresser),
        Arc::new(PortRegistration::new("session wakes")),
        ClaudeSessionSlots::new(Arc::new(|_predecessor| {})),
        Arc::new(ClaudeIdleSleep::default()),
        Arc::new(PortRegistration::new("session message readings")),
    );
    let session_id = new_session_id();

    let first = inboxes
        .mint_process_socket(session_id)
        .expect("a socket is named");
    let second = inboxes
        .mint_process_socket(session_id)
        .expect("a socket is named");

    assert_ne!(first, second);
    assert_eq!(first.parent(), Some(folder.as_path()));
    assert_eq!(second.parent(), Some(folder.as_path()));
    assert!(folder.is_dir());
}

// A socket named as the daemon names one that no process listens on goes; one a live process
// answers stays, and so does a socket of any other name. Killed by a sweep that removes every
// socket it lists, and by one that reaches past the daemon's own names.
#[tokio::test]
async fn the_sweep_removes_only_the_daemons_sockets_no_process_answers() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let scratch = short_socket_folder().expect("a scratch folder is made");
    let folder = scratch.path();
    let live = folder.join("a000000000000000.sock");
    let _listening = bind_socket_listener(&live).expect("the live process listens");
    let left = folder.join("b000000000000000.sock");
    let other = folder.join("4242-claude.sock");
    // A listener that ends without removing its socket, as a process that crashed leaves it.
    for socket in [&left, &other] {
        let mut ended = bind_socket_listener(socket).expect("a socket is made");
        ended.do_not_reclaim_name_on_drop();
    }
    assert!(
        left.exists() && other.exists(),
        "the ended listeners leave their sockets"
    );

    super::remove_left_sockets(folder)
        .await
        .expect("the folder is swept");

    assert!(live.exists(), "the live process's socket stays");
    assert!(!left.exists(), "the left socket goes");
    assert!(other.exists(), "a socket the daemon did not name stays");
}

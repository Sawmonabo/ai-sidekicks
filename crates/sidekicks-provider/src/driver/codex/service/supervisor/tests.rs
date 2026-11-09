use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::short_socket_folder;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::test_service::{
    ExitsHeard, TestCodexProgram, UnheardEvents, bind_test_listener,
    start_scripted_account_service_reporting_to, test_codex_service_dependencies,
    write_failing_codex,
};
use super::{CodexService, CodexServiceSocket};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::session::inbound::{CodexSessionInbound, codex_session_inbound};
use crate::driver::codex::session::state::CODEX_THREAD_FRAME_ROUTER_CONFIG;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::test_registry::new_session_id;

/// How long the test watches for a free check that must not come.
const QUIET_WAIT: Duration = Duration::from_millis(300);

/// How long the test waits for a free check that must come, long enough for a loaded machine.
const CHECK_WAIT: Duration = Duration::from_secs(10);

/// A conversation the person's own terminal holds on the joined service.
const PERSON_S_THREAD: &str = "person-thread-1";

// A listener answering as Codex's own managed daemon with the person's conversation loaded,
// telling `loaded_reads` of each `thread/loaded/list` and sending the daemon's connection each
// notice `notices` carries.
fn answer_as_a_used_managed_daemon(
    listener: Listener,
    loaded_reads: mpsc::UnboundedSender<()>,
    notices: mpsc::UnboundedReceiver<Value>,
) {
    let notices = Arc::new(tokio::sync::Mutex::new(Some(notices)));
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let loaded_reads = loaded_reads.clone();
            let notices = Arc::clone(&notices);
            tokio::spawn(async move {
                // A probe that only connects ends before the upgrade.
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                // The daemon's own connection, the first upgraded, takes the notices.
                let mut notices = notices.lock().await.take();
                loop {
                    let notice = async {
                        match notices.as_mut() {
                            Some(notices) => notices.recv().await,
                            None => std::future::pending().await,
                        }
                    };
                    let reply = tokio::select! {
                        Some(notice) = notice => notice,
                        message = socket.next() => {
                            let Some(Ok(Message::Text(text))) = message else {
                                return;
                            };
                            let request: Value =
                                serde_json::from_str(&text).expect("the daemon sends JSON");
                            let result = match request["method"].as_str() {
                                _ if request.get("id").is_none() => continue,
                                Some("initialize") => {
                                    json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"})
                                }
                                Some("thread/loaded/list") => {
                                    let _heard = loaded_reads.send(());
                                    json!({"data": [PERSON_S_THREAD]})
                                }
                                _ => json!({}),
                            };
                            json!({"id": request["id"], "result": result})
                        }
                    };
                    if socket
                        .send(Message::Text(reply.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
}

// Whether a free check reads the loaded conversations within `wait`.
async fn is_checked(loaded_reads: &mut mpsc::UnboundedReceiver<()>, wait: Duration) -> bool {
    tokio::time::timeout(wait, loaded_reads.recv())
        .await
        .is_ok()
}

// Killed by dropping either trigger of the joined service's free check, the last session's leave
// or a `thread/closed` with no session held, or by checking while a session is still held.
#[tokio::test(flavor = "multi_thread")]
async fn a_joined_service_checks_it_is_free_once_the_daemon_holds_no_session_on_it() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let socket = folder.path().join("s.sock");
    let Some(listener) = bind_test_listener(&socket) else {
        return;
    };
    let (loaded_sender, mut loaded_reads) = mpsc::unbounded_channel();
    let (notices, notices_received) = mpsc::unbounded_channel();
    answer_as_a_used_managed_daemon(listener, loaded_sender, notices_received);
    let codex_home = folder.path().join("home");
    std::fs::create_dir(&codex_home).expect("the home is made");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: write_failing_codex(folder.path()),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let startup_timeout = dependencies.startup_timeout;
    let service = CodexService::new(
        CodexServiceHome {
            codex_home,
            kind: CodexHomeKind::PersonalFolder,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Terminal,
        dependencies,
        Vec::new(),
    );
    service
        .ensure_started(startup_timeout)
        .await
        .expect("the start joins the used managed daemon");
    // The start's own read.
    loaded_reads
        .recv()
        .await
        .expect("the start read what is loaded");
    let sessions: Vec<SessionId> = (0..2).map(|_| new_session_id()).collect();
    for session_id in &sessions {
        service.attach_session(codex_session_inbound(*session_id).0);
    }
    let closed = json!({"jsonrpc": "2.0", "method": "thread/closed",
        "params": {"threadId": PERSON_S_THREAD}});

    let is_joined = service.kind() == CodexServiceKind::Joined;
    service.detach_session(&sessions[0]);
    let is_checked_with_one_left = is_checked(&mut loaded_reads, QUIET_WAIT).await;
    notices.send(closed.clone()).expect("the listener runs");
    let is_checked_on_a_close_with_one_left = is_checked(&mut loaded_reads, QUIET_WAIT).await;
    service.detach_session(&sessions[1]);
    let is_checked_once_none_left = is_checked(&mut loaded_reads, CHECK_WAIT).await;
    notices.send(closed).expect("the listener runs");
    let is_checked_on_a_close_with_none_left = is_checked(&mut loaded_reads, CHECK_WAIT).await;
    service
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(is_joined);
    assert!(!is_checked_with_one_left);
    assert!(!is_checked_on_a_close_with_one_left);
    assert!(is_checked_once_none_left);
    assert!(is_checked_on_a_close_with_none_left);
}

// A request the service leaves unanswered from 0 s times out at 60 s, and the service is ended at
// 120 s with 120 silent seconds. Killed by a watch that waits its whole limit after the timeout,
// which ends the service at 180 s.
#[tokio::test(start_paused = true)]
async fn a_service_silent_since_a_request_is_ended_at_the_limit_after_its_send() {
    let (heard, mut exits, _recoveries) = ExitsHeard::new();
    let scripted = start_scripted_account_service_reporting_to(Arc::new(heard));
    scripted.mark_started();
    let connection = scripted
        .service
        .connection()
        .expect("the scripted connection is up");
    let sent = tokio::time::Instant::now();
    tokio::spawn(async move { connection.request("thread/read", &json!({})).await });

    let exit = exits.recv().await.expect("the service's end is told");
    let ended_after = sent.elapsed();

    assert_eq!(ended_after, Duration::from_secs(120));
    let Some(ProcessExit::Silent(silent)) = exit else {
        panic!("the service ended as {exit:?}");
    };
    assert_eq!(silent.silent_seconds.get(), 120);
}

/// A helper a spawn item on the session's conversation names.
const SPAWNED_HELPER: &str = "helper-thread";

// The spawn item naming `SPAWNED_HELPER`: v1's completed `spawnAgent` call, or v2's activity.
fn spawn_item(is_v1: bool) -> Value {
    if is_v1 {
        json!({"type": "collabAgentToolCall", "id": "call-1", "tool": "spawnAgent",
            "status": "completed", "senderThreadId": TEST_THREAD,
            "receiverThreadIds": [SPAWNED_HELPER], "agentsStates": {}})
    } else {
        json!({"type": "subAgentActivity", "id": "call-1", "kind": "started",
            "agentThreadId": SPAWNED_HELPER, "agentPath": "/root/scout"})
    }
}

// A helper a spawn item on a session's conversation names is that session's on the service, so the
// helper's own frames reach the session's queue, one sent ahead of the item too; a frame on the
// session's conversation sent last marks where the reader has routed to. Killed by the service
// registering a helper only on `thread/started` and, for the frame ahead of the item, by the reader
// not holding it: the helper's `turn/started` is reported unrouted and dropped.
#[rstest]
#[case::v1(true, false)]
#[case::v2(false, false)]
#[case::child_frame_before_the_item(false, true)]
#[tokio::test]
async fn a_spawned_helpers_frames_reach_its_parents_session(
    #[case] is_v1: bool,
    #[case] is_child_frame_first: bool,
) {
    let mut session = TestCodexSession::start().await;
    let script = &session.scripted.script;
    let send = |method: &str, params: Value| {
        script.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    };
    let send_spawn_item = || {
        send(
            "item/completed",
            json!({"threadId": TEST_THREAD, "turnId": "turn-1", "item": spawn_item(is_v1)}),
        );
    };

    if !is_child_frame_first {
        send_spawn_item();
    }
    send(
        "turn/started",
        json!({"threadId": SPAWNED_HELPER,
            "turn": {"id": "turn-helper", "items": [], "status": "inProgress"}}),
    );
    if is_child_frame_first {
        send_spawn_item();
    }
    send(
        "thread/status/changed",
        json!({"threadId": TEST_THREAD, "status": {"type": "idle"}}),
    );
    let mut reached = Vec::new();
    loop {
        let item = tokio::time::timeout(CHECK_WAIT, session.task.next_item())
            .await
            .expect("the marker frame reaches the session");
        let CodexSessionInbound::Frame { method, params } = item else {
            continue;
        };
        if method == "thread/status/changed" {
            break;
        }
        let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
        reached.push((method, params["threadId"].clone()));
    }

    assert!(
        reached.contains(&("turn/started".to_owned(), json!(SPAWNED_HELPER))),
        "{reached:?}"
    );
}

// The frames that reach the session up to the marker `status`, each by its method and thread.
async fn reached_until(session: &mut TestCodexSession, status: &str) -> Vec<(String, Value)> {
    let mut reached = Vec::new();
    loop {
        let item = tokio::time::timeout(CHECK_WAIT, session.task.next_item())
            .await
            .expect("the marker reaches the session");
        let CodexSessionInbound::Frame { method, params } = item else {
            continue;
        };
        let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
        if method == "thread/status/changed" && params["status"]["type"] == status {
            return reached;
        }
        reached.push((method, params["threadId"].clone()));
    }
}

// A frame of a conversation no session registers is reported at its deadline, though no later
// frame is routed, so a registration after the deadline releases nothing. Killed by an expiry run
// only as the next frame is routed (the late registration hands the frame to the session).
#[tokio::test(start_paused = true)]
async fn a_held_frame_expires_at_its_deadline_with_no_later_frame() {
    let mut session = TestCodexSession::start().await;
    let send = |session: &TestCodexSession, method: &str, params: Value| {
        session
            .scripted
            .script
            .send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    };
    let marker = |session: &TestCodexSession, status: &str| {
        send(
            session,
            "thread/status/changed",
            json!({"threadId": TEST_THREAD, "status": {"type": status}}),
        );
    };
    send(
        &session,
        "turn/started",
        json!({"threadId": "late-helper",
            "turn": {"id": "turn-late", "items": [], "status": "inProgress"}}),
    );
    marker(&session, "active");
    reached_until(&mut session, "active").await;
    tokio::time::sleep(
        CODEX_THREAD_FRAME_ROUTER_CONFIG.pending_registration_timeout + Duration::from_secs(1),
    )
    .await;
    session
        .task
        .record
        .service
        .register_thread("late-helper".to_owned(), session.task.record.session_id);
    marker(&session, "idle");

    assert_eq!(reached_until(&mut session, "idle").await, Vec::new());
}

// A session attached to a service hears that a reading of its settings began before the warnings
// the service already sent, at each attach, and each session holding a conversation there hears
// it again when a new connection starts, which takes the earlier connection's warnings away.
// Killed by the attach or the connection's start pushing no reading's start, by a second attach
// skipping the warnings told at the first, and by the start keeping the warnings.
#[tokio::test]
async fn each_reading_of_the_settings_begins_before_its_warnings() {
    let scripted = start_scripted_account_service_reporting_to(Arc::new(UnheardEvents));
    let service = &scripted.service;
    let session_id = new_session_id();
    let warning = serde_json::value::to_raw_value(
        &json!({"summary": "bad line", "path": "/c/config.toml", "range": {"start": {"line": 4}}}),
    )
    .expect("a warning serializes");
    assert_eq!(
        service
            .lock_routing()
            .config_warnings
            .record_warning(warning, &[]),
        Vec::<SessionId>::new()
    );
    let (sender, mut queue) = codex_session_inbound(session_id);

    service.attach_session(sender.clone());
    service.register_thread(TEST_THREAD.to_owned(), session_id);
    let attached = [queue.try_next(), queue.try_next()];
    service.attach_session(sender);
    let attached_again = [queue.try_next(), queue.try_next()];
    service.start_connection();
    let reconnected = [queue.try_next(), queue.try_next()];

    assert!(matches!(
        attached,
        [
            Some(CodexSessionInbound::SettingsReadingBegan),
            Some(CodexSessionInbound::Frame { .. }),
        ]
    ));
    assert!(matches!(
        attached_again,
        [
            Some(CodexSessionInbound::SettingsReadingBegan),
            Some(CodexSessionInbound::Frame { .. }),
        ]
    ));
    assert!(matches!(
        reconnected,
        [Some(CodexSessionInbound::SettingsReadingBegan), None]
    ));
}

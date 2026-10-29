use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
use serde_json::value::RawValue;
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
use super::{
    CodexService, CodexServiceSocket, CodexWindowsSandboxReadiness, read_windows_sandbox_readiness,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::test_registry::new_session_id;

// Fails when a status Codex did not name as ready, or one this daemon does not know, reads as
// ready, which would offer a sandbox that cannot run a command.
#[rstest]
#[case::ready(r#"{"status":"ready"}"#, CodexWindowsSandboxReadiness::Ready)]
#[case::not_configured(
    r#"{"status":"notConfigured"}"#,
    CodexWindowsSandboxReadiness::NotConfigured
)]
#[case::update_required(
    r#"{"status":"updateRequired"}"#,
    CodexWindowsSandboxReadiness::UpdateRequired
)]
#[case::an_unknown_status(
    r#"{"status":"warmingUp"}"#,
    CodexWindowsSandboxReadiness::NotConfigured
)]
#[case::no_status(r"{}", CodexWindowsSandboxReadiness::NotConfigured)]
fn the_windows_sandbox_offers_only_on_ready(
    #[case] reply: &str,
    #[case] readiness: CodexWindowsSandboxReadiness,
) {
    let reply = RawValue::from_string(reply.to_owned()).expect("the reply is JSON");

    assert_eq!(read_windows_sandbox_readiness(&reply), readiness);
}

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
    service.shutdown(DaemonStopIntent::Stop).await;

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

//! A naming pass whose live leg spends the whole deadline, so its one-shot pass gets no time.

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::{TITLE_THREAD, TITLE_TURN};
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::lifecycle::naming::CODEX_NAMING_DEADLINE;
use crate::driver::codex::service::supervisor::test_service::bind_test_listener;
use crate::driver::codex::session::test_session::{TestCodexSession, turn_reply};
use crate::driver::session_control::NameSessionParams;
use crate::driver::test_registry::test_driver_services;

// Serves the title pass's connection as Codex up to its turn's start, which it never ends; answers
// the interrupt the daemon sent.
async fn serve_unended_title_turn(listener: Listener) -> Value {
    let stream = listener
        .accept()
        .await
        .expect("the daemon dials the service");
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .expect("the daemon upgrades its connection");
    while let Some(Ok(message)) = socket.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        let id = &request["id"];
        if id.is_null() {
            continue;
        }
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"userAgent": "codex/0.163.0 (test)"}),
            Some("config/read") => json!({"config": {}, "origins": {}}),
            Some("model/list") => json!({"data": [], "nextCursor": null}),
            Some("thread/start") => json!({
                "thread": {"id": TITLE_THREAD, "sessionId": "codex-session"},
                "sandbox": {"type": "readOnly", "networkAccess": false},
            }),
            Some("turn/start") => turn_reply(TITLE_TURN),
            Some("turn/interrupt") => {
                let reply = json!({"id": id, "result": {}});
                socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .expect("the daemon reads");
                return request;
            }
            method => panic!("the title pass sent {method:?}"),
        };
        socket
            .send(Message::Text(
                json!({"id": id, "result": result}).to_string().into(),
            ))
            .await
            .expect("the daemon reads");
    }
    panic!("the daemon let the connection go with its turn running");
}

// Killed by giving the one-shot pass a fresh deadline after the live one spent it: the one-shot
// pass would run, and on this service, which runs no program, fail the pass.
#[tokio::test(start_paused = true)]
async fn a_live_pass_that_spends_the_deadline_leaves_the_one_shot_pass_no_time() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let driver = CodexDriver::new(&test_driver_services());
    driver.views.show(&session.task.record);
    let served = tokio::spawn(serve_unended_title_turn(listener));
    let started = Instant::now();

    let named = driver
        .name_session(NameSessionParams {
            session_id: session.task.record.session_id,
            place: None,
            first_message: "Fix the login page".to_owned(),
            first_reply: "Looking at the form.".to_owned(),
            cancel: CancellationToken::new(),
        })
        .await;

    assert_eq!(named.expect("a pass past its deadline names nothing"), None);
    assert!(started.elapsed() >= CODEX_NAMING_DEADLINE);
    let interrupt = served.await.expect("the service served the pass");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": TITLE_THREAD, "turnId": TITLE_TURN})
    );
}

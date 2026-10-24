//! A live session's close, through the driver.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;

use super::{LiveCodexSession, TEST_TURN};
use crate::database::writer::test_file::TestDatabase;
use crate::provider::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::provider::driver::codex::run::start::record::CodexTurnRequest;
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::state::CodexTurnMessage;
use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, turn_completed, turn_reply,
};
use crate::provider::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::provider::driver::session_control::CloseSessionParams;
use crate::session::run::transitions::RUN_TERMINAL_EVENT_TYPES_SQL;

/// How long a close may take before the test counts it as stuck.
const CLOSE_BOUND: Duration = Duration::from_secs(10);

// Real time under a timeout, since the run engine writes the run's end through the database
// writer. Killed by dropping the interrupt from `close_session` and by sending it after the
// let-go: Codex would run the turn on unsubscribed.
#[tokio::test]
async fn a_close_interrupts_the_live_turn_and_ends_its_run_before_letting_the_conversation_go() {
    close_live_turn(true).await;
}

// Real time, the close waiting out its bound. Killed by dropping the `end_turn_on_close` call, and
// by dropping the close's bound on the interrupt: the run would stay `running` past its session's
// close, or the close would wait on Codex past the test's bound.
#[tokio::test]
async fn a_close_whose_interrupt_codex_never_answers_ends_its_run_as_closed_past_its_bound() {
    close_live_turn(false).await;
}

// Closes a session whose run is on a live turn, Codex answering the close's interrupt when
// `is_interrupt_answered`, and checks the run ended as closed before the conversation went.
async fn close_live_turn(is_interrupt_answered: bool) {
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        mut scripted,
        database,
        ..
    } = LiveCodexSession::start(&[]).await;

    let close = driver.close_session(CloseSessionParams { session_id });
    tokio::pin!(close);
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                if sent["method"] == "thread/unsubscribe" {
                    assert_eq!(
                        terminal_events(&database, run_id),
                        [("agent.run.interrupted".to_owned(), Some(true))],
                        "the run ended as closed before its conversation was let go"
                    );
                }
                if is_interrupt_answered || sent["method"] != "turn/interrupt" {
                    answer_close_request(&scripted.script, &sent);
                }
                methods.push(sent);
            }
        }
    }

    assert_interrupted_before_let_go(&methods, TEST_TURN);
    assert_eq!(
        terminal_events(&database, run_id),
        [("agent.run.interrupted".to_owned(), Some(true))]
    );
}

// Real time under a timeout, as above. Killed by dropping the interrupt from `close_session` and
// by sending it after the let-go: the turn Codex names once the close began would run on.
#[tokio::test]
async fn a_close_interrupts_a_turn_whose_start_codex_answers_after_the_close_began() {
    let session = LiveCodexSession::idle().await;
    let LiveCodexSession {
        driver,
        session_id,
        run_id,
        binding_id,
        mut scripted,
        ..
    } = session;
    let parts = Arc::clone(driver.parts().expect("the driver composes"));
    let inbound = parts
        .slots
        .require_live(session_id)
        .expect("the session is live");
    let start = tokio::spawn({
        let parts = Arc::clone(&parts);
        async move {
            let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
            parts
                .run_start
                .start_turn(
                    &inbound,
                    run_id,
                    binding_id,
                    turn_request(),
                    None,
                    &deadline,
                )
                .await
        }
    });
    let turn_start = tokio::time::timeout(CLOSE_BOUND, scripted.script.next_sent())
        .await
        .expect("the run's turn start is sent");
    assert_eq!(turn_start["method"], "turn/start");

    let close = driver.close_session(CloseSessionParams { session_id });
    tokio::pin!(close);
    // Time for the close to withdraw the start before Codex names its turn; the start's refusal
    // below shows it did.
    let named = tokio::time::sleep(Duration::from_millis(200));
    tokio::pin!(named);
    let mut is_named = false;
    let mut methods = Vec::new();
    let deadline = tokio::time::sleep(CLOSE_BOUND);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            () = &mut named, if !is_named => {
                is_named = true;
                scripted.script.answer(&turn_start, &turn_reply("turn-2"));
            }
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                answer_close_request(&scripted.script, &sent);
                methods.push(sent);
            }
        }
    }

    assert_interrupted_before_let_go(&methods, "turn-2");
    assert!(
        matches!(
            start.await.expect("the start's task ends"),
            Err(CodexError::TurnWithdrawn { .. })
        ),
        "the close withdrew the start before Codex named its turn"
    );
}

// Answers what a close sends: an interrupt, with its turn's end as Codex sends it on the abort,
// the running-command list as empty, and the rest with nothing.
fn answer_close_request(script: &ScriptedService, sent: &Value) {
    match sent["method"].as_str() {
        Some("turn/interrupt") => {
            script.answer(sent, &json!({}));
            let turn_id = sent["params"]["turnId"]
                .as_str()
                .expect("an interrupt names its turn");
            script.send(&turn_completed(TEST_THREAD, turn_id, "interrupted"));
        }
        Some("thread/backgroundTerminals/list") => {
            script.answer(sent, &json!({"data": [], "nextCursor": null}));
        }
        _ => script.answer(sent, &json!({})),
    }
}

// That `turn_id` was interrupted once, before the conversation was unsubscribed.
fn assert_interrupted_before_let_go(methods: &[Value], turn_id: &str) {
    let position = |method: &str| methods.iter().position(|sent| sent["method"] == method);
    let interrupt = position("turn/interrupt").expect("the close interrupts the turn");
    let unsubscribe = position("thread/unsubscribe").expect("the close lets the conversation go");
    assert!(
        interrupt < unsubscribe,
        "the interrupt goes before the let-go"
    );
    assert_eq!(methods[interrupt]["params"]["turnId"], turn_id);
    assert_eq!(
        methods
            .iter()
            .filter(|sent| sent["method"] == "turn/interrupt")
            .count(),
        1
    );
}

// A one-message turn.
fn turn_request() -> CodexTurnRequest {
    CodexTurnRequest {
        messages: vec![CodexTurnMessage {
            text: "Go on.".to_owned(),
            skills: Vec::new(),
            attachments: Vec::new(),
        }],
        client_message_ids: vec!["message-1".to_owned()],
        model: None,
        output_speed: None,
        output_speed_for_turn: None,
        output_schema: None,
        level: Some(PermissionLevel::Ask),
    }
}

// Each terminal event of `run_id`, with whether its end was the daemon's intended close.
fn terminal_events(database: &TestDatabase, run_id: RunId) -> Vec<(String, Option<bool>)> {
    database
        .reader()
        .prepare(&format!(
            "SELECT type, payload FROM session_events WHERE run_id = ?1 AND type IN ({}) \
             ORDER BY sequence",
            *RUN_TERMINAL_EVENT_TYPES_SQL
        ))
        .expect("the test reads the run's events")
        .query_map([run_id.text().as_str()], |row| {
            let payload: String = row.get(1)?;
            let payload: Value = serde_json::from_str(&payload).expect("a stored payload is JSON");
            Ok((row.get(0)?, payload["intendedClose"].as_bool()))
        })
        .expect("the run's events read")
        .collect::<Result<_, _>>()
        .expect("each event reads")
}

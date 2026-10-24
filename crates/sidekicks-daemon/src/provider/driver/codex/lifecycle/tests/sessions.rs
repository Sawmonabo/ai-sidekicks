//! A live session's close, through the driver.

use std::time::Duration;

use serde_json::json;

use super::LiveCodexSession;
use crate::provider::driver::session_control::CloseSessionParams;
use crate::provider::driver::test_registry::terminal_events;

// Real time under a timeout, since the run engine writes the run's end through the database
// writer. Killed by dropping the `end_turn_on_close` call from `close_session`: the run would stay
// `running` past its session's close, and nothing would end it before its conversation went.
#[tokio::test]
async fn a_close_ends_the_run_in_flight_before_its_conversation_is_let_go() {
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
    let mut let_go_requests = 0;
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => panic!("the close ends within its bound"),
            closed = &mut close => {
                closed.expect("the session closes");
                break;
            }
            sent = scripted.script.next_sent() => {
                let_go_requests += 1;
                assert_eq!(
                    terminal_events(&database, run_id),
                    [("agent.run.interrupted".to_owned(), Some(true))],
                    "the run ended as closed before its conversation was let go"
                );
                let reply = if sent["method"] == "thread/backgroundTerminals/list" {
                    json!({"data": [], "nextCursor": null})
                } else {
                    json!({})
                };
                scripted.script.answer(&sent, &reply);
            }
        }
    }

    assert!(
        let_go_requests > 0,
        "the conversation was let go on its service"
    );
    assert_eq!(
        terminal_events(&database, run_id),
        [("agent.run.interrupted".to_owned(), Some(true))]
    );
}

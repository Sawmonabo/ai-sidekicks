//! A Codex command's row as a live session's task keeps it, and the person's stop of a command the
//! relay does not hold.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

use super::{LiveCodexSession, TEST_TURN};
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed};
use crate::driver::contract::error::DriverError;
use crate::port::running_command_publisher::RunningCommandParams;

const CALL: &str = "call-1";

fn command_frame(method: &str, item: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": { "threadId": TEST_THREAD, "turnId": TEST_TURN, "item": item },
    })
}

// Yields until `holds` reads true, failing after a bound.
async fn wait_until(mut holds: impl FnMut() -> bool) {
    for _turn in 0..2_000 {
        if holds() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the condition never held");
}

// A command's row survives its turn's end and its service's exit, a stop of it reaches Codex's
// own terminate for its process although the relay holds no record of it, and only its item's end
// ends the row. Killed by closing the row at its turn's end or at the service's exit
// (`provider_exited`), and by answering a stop the relay cannot place without sending Codex's
// terminate.
#[tokio::test]
async fn a_commands_row_outlives_its_turn_and_service_and_its_stop_reaches_codex() {
    let mut session = LiveCodexSession::start(&[]).await;
    let sets = unbound_running_command_sets();
    assert!(
        session
            .driver
            .ports
            .command_output
            .register(Arc::clone(&sets) as _)
            .is_ok()
    );
    let session_id = session.session_id;
    let item = json!({ "type": "commandExecution", "id": CALL, "command": "sleep 60",
        "processId": "7" });

    session
        .scripted
        .script
        .send(&command_frame("item/started", &item));
    wait_until(|| sets.has_running_commands(session_id)).await;
    session
        .scripted
        .script
        .send(&turn_completed(TEST_THREAD, TEST_TURN, "completed"));
    let parts = Arc::clone(session.driver.parts().expect("the driver composes"));
    parts
        .recovery
        .end_turns_on_exit(&session.scripted.service, None)
        .await;
    assert!(
        sets.has_running_commands(session_id),
        "the row outlives both"
    );

    let params = RunningCommandParams {
        session_id,
        binding_id: session.binding_id.clone(),
        command_id: CommandId::new(CALL.to_owned()).expect("a call id"),
    };
    let (driver, scripted) = (&session.driver, &mut session.scripted);
    for terminated in [false, true] {
        let answering = async {
            let request = tokio::time::timeout(
                Duration::from_secs(10),
                scripted.next_request("thread/backgroundTerminals/terminate"),
            )
            .await
            .expect("the stop sends Codex's terminate");
            assert_eq!(
                request["params"],
                json!({ "threadId": TEST_THREAD, "processId": "7" })
            );
            scripted
                .script
                .answer(&request, &json!({ "terminated": terminated }));
        };
        let (stopped, ()) = tokio::join!(driver.stop_command(params.clone()), answering);
        match stopped {
            Ok(()) => assert!(terminated),
            Err(DriverError::Refused(refusal)) => {
                assert!(!terminated);
                assert_eq!(refusal.code, RefusalCode::AgentCommandNotStopped);
            }
            Err(other) => panic!("the stop failed otherwise: {other:?}"),
        }
    }
    assert!(
        sets.has_running_commands(session_id),
        "a stop leaves the row"
    );

    session.scripted.script.send(&command_frame(
        "item/completed",
        &json!({ "type": "commandExecution", "id": CALL, "command": "sleep 60",
            "processId": "7", "exitCode": 143 }),
    ));
    wait_until(|| !sets.has_running_commands(session_id)).await;
}

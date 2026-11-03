//! A paused run whose turn the daemon's restart cut while it was pausing, continued by the
//! person: its next turn takes up the cut work before the messages that waited for it.

use serde_json::Value;
use sidekicks_contracts::run::queue::MessageContent;

use super::{DEADLOCK_BOUND, live_run};
use crate::driver::codex::session::establishment::continuation::CODEX_CONTINUATION_TEXT;
use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_reply};
use crate::driver::run_control::{ResumeRunParams, WaitingMessage};
use crate::driver::test_registry::new_message_id;

// A continue owed its continuation starts the run's next turn with Codex's continuation words,
// then the waiting message. Killed by the flag ignored (the turn holds the message alone).
#[tokio::test]
async fn a_continue_owed_its_continuation_starts_with_it() {
    let mut session = TestCodexSession::start().await;
    let (control, run_id) = live_run(&mut session).await;
    session.task.record.remove_active_turn("turn-1");
    session
        .task
        .run_routes
        .retire_turn_route(&mut session.task.record, "turn-1");
    let inbound = session.task.record.inbound.clone();
    let params = ResumeRunParams {
        session_id: session.task.record.session_id,
        run_id,
        messages: vec![WaitingMessage {
            id: new_message_id(),
            content: MessageContent::new("carry on".to_owned()).expect("the words"),
            attachments: Vec::new(),
            skills: Vec::new(),
        }],
        is_continuation_owed: true,
    };
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let flow = async {
        task.handle_next().await;
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/start");
        script.answer(&sent, &turn_reply("turn-2"));
        task.handle_next().await;
        sent
    };

    let (continued, sent): (_, Value) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(control.continue_run(&inbound, params), flow) }),
    )
    .await
    .expect("the continue's turn starts");

    continued.expect("the run's next turn starts");
    let input = &sent["params"]["input"];
    assert_eq!(input[0]["text"], CODEX_CONTINUATION_TEXT);
    assert_eq!(input[1]["text"], "carry on");
}

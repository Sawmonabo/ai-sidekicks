//! The person's answers that reach their held lead by neither the steer nor their own turn fail
//! the lead's run as a provider failure and go back to the queue.

use std::time::Duration;

use serde_json::json;
use sidekicks_std::mutex_lock::lock;

use super::CodexAnswerSteer;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::session::establishment::continuation::CODEX_CONTINUATION_TEXT;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::test_registry::{new_message_id, new_run_id};
use crate::run::state_entry::RunStateEntry;

// How long the test waits before it calls the steer's flow hung.
const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

// The answers' words the test's steer carries.
const ANSWER_TEXT: &str = "You asked to approve Bash: npm publish. The person approved it.";

// A lead whose held continuation ended before the answers' steer was sent is owed their own
// turn; when Codex refuses that turn, the run fails as a provider failure and the queue is told to
// give the answers back. Killed by the failure only logged (the run never moves and the queue is
// never told, so the lead is left running with its answers claimed).
#[tokio::test]
async fn a_refused_answer_turn_fails_the_lead_and_gives_its_answers_back() {
    let mut session = TestCodexSession::start().await;
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    let session_id = session.task.record.session_id;
    session.task.record.answer_turn_owed_run_ids.insert(run_id);
    let steers = session.answer_steers();
    let steer = CodexAnswerSteer {
        run_id,
        turn_id: "turn-1".to_owned(),
        message_id: new_message_id(),
        answer_text: ANSWER_TEXT.to_owned(),
        binding: CodexRunBinding {
            session_id,
            binding_id,
            agent_id: session.daemon_turn_bindings.agent_id,
            step_bound: None,
        },
    };
    let inbound = session.task.record.inbound.clone();
    let script = &mut session.scripted.script;
    let refused = async {
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "turn/start");
        script.send(&json!({
            "jsonrpc": "2.0",
            "id": sent["id"],
            "error": {"code": -32600, "message": "the turn is refused"},
        }));
        sent
    };

    let ((), sent) = tokio::time::timeout(
        DEADLOCK_BOUND,
        session
            .task
            .drive(async { tokio::join!(steers.deliver(steer, &inbound), refused) }),
    )
    .await
    .expect("the answers' turn is refused");

    let text = sent["params"]["input"][0]["text"]
        .as_str()
        .expect("the turn holds words");
    assert!(text.starts_with(CODEX_CONTINUATION_TEXT), "{text}");
    assert!(text.ends_with(ANSWER_TEXT), "{text}");
    let moves = session.engine.moves_of_run(run_id);
    assert!(
        matches!(moves.as_slice(), [RunStateEntry::Failed { .. }]),
        "{moves:?}"
    );
    assert_eq!(*lock(&session.queue.continues_given_back), [run_id]);
    assert!(session.task.record.answer_turn_owed_run_ids.is_empty());
}

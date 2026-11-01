//! The questions a live session's agent asks without waiting for the answer.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{LiveCodexSession, TEST_TURN};
use crate::driver::codex::session::test_fixture::TEST_THREAD;
use crate::port::question::test_card::QuestionCard;
use crate::port::question::{ProviderQuestion, QuestionPort};

// A reply frame of `method` carrying `item_id`'s whole item, delivered `delivery` with one question.
fn reply_frame(method: &str, item_id: &str, delivery: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "item": {
                "type": "agentMessage",
                "id": item_id,
                "text": "Which environment?\n- Staging\n- Production",
                "phase": "final_answer",
                "delivery": delivery,
                "questions": [{"title": "Which environment?", "options": ["Staging", "Production"]}],
            },
        },
    })
}

// Real time under a timeout, since the session's task applies each frame on its own task. The
// last async reply is the barrier: the test card keeps one question open per run, so it waits for
// its run behind the first, and every earlier frame's record lands before it. Kills: the run moved
// (the question recorded as one its agent waits on), the question recorded twice (from its start
// too), and the delivery not read (the null reply recorded).
#[tokio::test]
async fn an_async_question_is_recorded_once_from_its_end_with_its_run_left_running() {
    let session = LiveCodexSession::start(&[]).await;
    let card = Arc::new(QuestionCard::default());
    let port: Arc<dyn QuestionPort> = card.clone();
    assert!(session.questions.register(port).is_ok());
    let script = &session.scripted.script;
    for (method, item_id, delivery) in [
        ("item/started", "asked", json!("async")),
        ("item/completed", "asked", json!("async")),
        ("item/started", "plain", Value::Null),
        ("item/completed", "plain", Value::Null),
        ("item/completed", "barrier", json!("async")),
    ] {
        script.send(&reply_frame(method, item_id, &delivery));
    }
    card.wait_until_waiting(1).await;

    let read = |questions: &[ProviderQuestion]| -> Vec<(String, bool)> {
        questions
            .iter()
            .map(|question| (question.request_id.clone(), question.is_agent_waiting))
            .collect()
    };
    let taken = card.taken();
    assert_eq!(read(&taken), [("asked".to_owned(), false)]);
    assert_eq!(read(&card.waiting()), [("barrier".to_owned(), false)]);
    assert_eq!(taken[0].run_id, session.run_id);
    assert_eq!(taken[0].questions[0].text.as_str(), "Which environment?");
    assert!(taken[0].questions[0].several_answers);
    assert!(
        session.engine.moves_of_run(session.run_id).is_empty(),
        "the run is not moved"
    );
}

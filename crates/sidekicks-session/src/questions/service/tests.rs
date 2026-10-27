//! The questions service's tests: a held question's answer and the refusals that send nothing,
//! each way a question ends unanswered, a question's turn while its run waits on another, and the
//! queued answers of a question its agent does not wait for.

mod answers;
mod endings;
mod queued_answers;
mod run_turn;

use futures::FutureExt as _;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_provider::port::question::ToolServerQuestionAnswer;

use super::QuestionError;
use super::test_fixture::{Fixture, HandedAnswers, choice_page};
use crate::run::engine::test_fixture::stored_run_state;

/// The secret the tests answer with, which no stored row may hold.
const SECRET: &str = "the-secret-value-41";

/// A stand-in tool-server task that records each answer it is sent.
struct RecordingTaskAnswer(HandedAnswers);

impl ToolServerQuestionAnswer for RecordingTaskAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> futures::future::BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        self.0
            .lock()
            .expect("the test's record is never poisoned")
            .push(("task".to_owned(), answers));
        async { Ok(()) }.boxed()
    }
}

impl Fixture {
    /// The payloads of the log's events of `event_type`, oldest first.
    fn payloads(&self, event_type: &str) -> Vec<Value> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare("SELECT payload FROM session_events WHERE type = ?1 ORDER BY sequence")
            .expect("the read prepares");
        statement
            .query_map([event_type], |row| row.get::<_, String>(0))
            .expect("the payloads read")
            .map(|payload| {
                serde_json::from_str(&payload.expect("each payload reads"))
                    .expect("each payload is JSON")
            })
            .collect()
    }

    /// The stored state of the fixture's run.
    fn run_state(&self) -> String {
        stored_run_state(&self.database, &self.run_id).0
    }

    /// How many answers the stand-in driver was handed.
    fn handed_count(&self) -> usize {
        self.handed.lock().expect("never poisoned").len()
    }
}

/// `choice_page` as a tool server's form field, which must be answered.
fn form_field_page() -> Value {
    let mut page = choice_page();
    page["required"] = json!(true);
    page
}

/// A question page asking for a secret.
fn secret_page() -> Value {
    json!({ "text": "The token?", "options": [], "severalAnswers": false, "secret": true })
}

/// The refusal code and detail `failure` carries; panics when the answer failed rather than being
/// refused.
fn refusal_of(failure: QuestionError) -> (RefusalCode, Value) {
    let QuestionError::Refused(refusal) = failure else {
        panic!("the answer is refused, not failed: {failure}");
    };
    (
        refusal.code,
        refusal.detail.map_or(Value::Null, |detail| json!(detail)),
    )
}

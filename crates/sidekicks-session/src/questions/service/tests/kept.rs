//! A question's answer kept while no provider request held it, and a question asked again under a
//! new request, which returns to its record by its pages.

use serde_json::json;
use sidekicks_contracts::question::QuestionAnswer;

use super::{SECRET, secret_page};
use crate::questions::kept_answers::OwedQuestionContinue;
use crate::questions::service::test_fixture::{Fixture, choice_page};

impl Fixture {
    /// How many kept rows the database holds.
    fn kept_rows(&self) -> i64 {
        self.database
            .reader()
            .query_row("SELECT COUNT(*) FROM question_kept_answers", [], |row| {
                row.get(0)
            })
            .expect("the kept rows count")
    }
}

// An answer given while no request holds its question, as after a restart, settles it answered,
// writes the person's turn and moves the run back to `running` with nothing sent, and keeps the
// answer: the same pages asked again under a new request are answered with it once, through the
// driver, with no second record, and a third ask records a question of its own. A continue's
// claim leaves the question asked again its answer, and once given back the continue owes it no
// longer, the question asked again having taken it. Killed by the old refusal kept, by the claim
// left unwritten (the third ask is answered too), by the run left waiting, by a continue's claim
// that also takes the call's hand (the question asked again records a question), and by the
// continue still owing an answer the question asked again took.
#[tokio::test]
async fn an_answer_no_held_request_takes_is_kept_and_answers_the_question_asked_again_once() {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture.questions.forget_held_request(&question_id);

    let resolved = fixture
        .resolve(
            question_id,
            json!([{ "kind": "picked", "labels": ["Beta"] }]),
        )
        .await
        .expect("the answer is kept, not refused");

    assert_eq!(resolved.kept, Some((fixture.session_id, fixture.run_id)));
    assert_eq!(fixture.state(question_id), "answered");
    assert_eq!(fixture.run_state(), "running");
    assert_eq!(fixture.handed_count(), 0);
    assert_eq!(fixture.payloads("user.message.sent")[0]["message"], "Beta");
    assert_eq!(
        fixture
            .questions
            .owed_continues(fixture.session_id)
            .await
            .expect("the owed continues read"),
        vec![OwedQuestionContinue {
            question_id,
            run_id: fixture.run_id,
            question: "Which one?".to_owned(),
            answer: "Beta".to_owned(),
        }]
    );
    assert!(
        fixture
            .questions
            .claim_continue(question_id)
            .await
            .expect("the continue's claim is written")
    );

    let asked_again = fixture.ask("request-2", json!([choice_page()]), true).await;

    assert_eq!(asked_again, question_id);
    assert_eq!(fixture.payloads("question.asked").len(), 1);
    let handed = fixture.handed.lock().expect("never poisoned").clone();
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].0, "request-2");
    assert!(matches!(
        &handed[0].1[..],
        [QuestionAnswer::Picked { labels }] if labels.as_slice()[0].as_str() == "Beta"
    ));
    assert_eq!(fixture.run_state(), "running");
    fixture
        .questions
        .release_continue(question_id)
        .await
        .expect("the continue's claim is given back");
    assert_eq!(
        fixture
            .questions
            .owed_continues(fixture.session_id)
            .await
            .expect("the owed continues read"),
        Vec::new()
    );

    let asked_third = fixture.ask("request-3", json!([choice_page()]), true).await;

    assert_ne!(asked_third, question_id);
    assert_eq!(fixture.payloads("question.asked").len(), 2);
    assert_eq!(fixture.handed_count(), 1);
    assert_eq!(fixture.run_state(), "waitingForInput");
}

// A secret answer given while no request holds its question writes no kept row and is answered
// to the question asked again from memory; the continue reads it answered secretly. Killed by the
// secret written to the row.
#[tokio::test]
async fn a_secret_answer_is_kept_in_memory_only() {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([secret_page()]), true).await;
    fixture.questions.forget_held_request(&question_id);

    let resolved = fixture
        .resolve(question_id, json!([{ "kind": "secret", "value": SECRET }]))
        .await
        .expect("the answer is kept, not refused");

    assert_eq!(resolved.kept, Some((fixture.session_id, fixture.run_id)));
    assert_eq!(fixture.kept_rows(), 0);
    assert_eq!(fixture.state(question_id), "answered");
    let owed = fixture
        .questions
        .owed_continues(fixture.session_id)
        .await
        .expect("the owed continues read");
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].answer, "Answered (secret)");

    let asked_again = fixture.ask("request-2", json!([secret_page()]), true).await;

    assert_eq!(asked_again, question_id);
    assert_eq!(fixture.payloads("question.asked").len(), 1);
    let handed = fixture.handed.lock().expect("never poisoned").clone();
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].0, "request-2");
    assert!(matches!(
        &handed[0].1[..],
        [QuestionAnswer::Secret { value }] if value.as_str() == SECRET
    ));
}

// An open question its provider asks again after a restart under a new request id, the same
// pages, returns to its record: no second record, the run still waiting, and the answer goes back
// under the new request. Killed by the pages' match dropped, which records a second question.
#[tokio::test]
async fn a_question_asked_again_under_a_new_id_is_held_under_the_open_question_of_its_digest() {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture.questions.forget_held_request(&question_id);

    let asked_again = fixture.ask("request-2", json!([choice_page()]), true).await;

    assert_eq!(asked_again, question_id);
    assert_eq!(fixture.payloads("question.asked").len(), 1);
    assert_eq!(fixture.run_state(), "waitingForInput");
    let resolved = fixture
        .resolve(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await
        .expect("the answer lands");
    assert_eq!(resolved.kept, None);
    assert_eq!(fixture.kept_rows(), 0);
    let handed = fixture.handed.lock().expect("never poisoned").clone();
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].0, "request-2");
}

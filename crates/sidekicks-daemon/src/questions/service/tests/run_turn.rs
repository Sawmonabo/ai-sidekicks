//! A question asked while its run waits on another: recorded at once waiting for the run, opened
//! only once the run reads running, and canceled with the run's end while it still waits.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::question::QuestionId;

use super::{Fixture, HandedAnswers, RecordingTaskAnswer, choice_page, failed};
use crate::provider::port::question::{
    QuestionTurn, QuestionTurnEnd, ToolServerQuestionAnswer, take_question_in_turn,
};
use crate::questions::service::HeldRequestAnswerer;
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions};

/// A tool server's answerer that records what it is sent into `sent`.
fn task_answer(sent: &HandedAnswers) -> Arc<dyn ToolServerQuestionAnswer> {
    Arc::new(RecordingTaskAnswer(Arc::clone(sent)))
}

/// The sequence of the log's newest event of `event_type`.
fn sequence_of(fixture: &Fixture, event_type: &str) -> i64 {
    fixture
        .database
        .reader()
        .query_row(
            "SELECT MAX(sequence) FROM session_events WHERE type = ?1",
            [event_type],
            |row| row.get(0),
        )
        .expect("the event's sequence reads")
}

/// The id of the `index`th question the log records.
fn asked_id(fixture: &Fixture, index: usize) -> QuestionId {
    serde_json::from_value(fixture.payloads("question.asked")[index]["questionId"].clone())
        .expect("the record names its question")
}

// A tool server's question asked while its run waits on the first is recorded at once waiting for
// the run, the run unmoved, and opens in the write after the first answer's write moves the run
// back to `running`; a third still waiting when the run ends is canceled with the end and its turn
// ends settled. Killed by refusing the take while the run waits, by waking on the answer's
// delivery rather than the run's write, and by never waking at the run's end.
#[tokio::test]
async fn a_question_asked_while_its_run_waits_opens_once_the_first_answer_moves_the_run() {
    let fixture = Fixture::new().await;
    let sent = HandedAnswers::default();
    let first = fixture
        .ask_answered_by(
            "request-1",
            json!([choice_page()]),
            true,
            HeldRequestAnswerer::ToolServerTask(task_answer(&sent)),
        )
        .await;
    let second = take_question_in_turn(
        &fixture.questions,
        fixture.question("request-2", json!([choice_page()]), true),
        Some(task_answer(&sent)),
        QuestionTurn::line_up(fixture.run_id),
        std::future::pending(),
    );
    tokio::pin!(second);
    while fixture.payloads("question.asked").len() < 2 {
        tokio::select! {
            _ = &mut second => panic!("the second question was taken while its run waited"),
            () = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
    }
    let waiting = asked_id(&fixture, 1);
    assert_eq!(
        fixture.payloads("question.asked")[1]["state"],
        "waitingForRun"
    );
    assert_eq!(fixture.state(waiting), "waitingForRun");
    assert_eq!(fixture.state(first), "open");
    assert_eq!(fixture.run_state(), "waitingForInput");

    let (answered, taken) = tokio::join!(
        fixture.answer(first, json!([{ "kind": "picked", "labels": ["Alpha"] }])),
        &mut second
    );

    answered.expect("the first question is answered");
    assert_eq!(taken.expect("the turn ends"), QuestionTurnEnd::Taken);
    assert_eq!(fixture.state(waiting), "open");
    assert_eq!(fixture.run_state(), "waitingForInput");
    let opened = fixture.payloads("question.opened");
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["questionId"], json!(waiting));
    assert!(
        sequence_of(&fixture, "question.opened") > sequence_of(&fixture, "user.message.sent"),
        "it opens only after the answer's write"
    );

    let third = take_question_in_turn(
        &fixture.questions,
        fixture.question("request-3", json!([choice_page()]), true),
        Some(task_answer(&sent)),
        QuestionTurn::line_up(fixture.run_id),
        std::future::pending(),
    );
    tokio::pin!(third);
    while fixture.payloads("question.asked").len() < 3 {
        tokio::select! {
            _ = &mut third => panic!("the third question was taken while its run waited"),
            () = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
    }
    let (ended, third_end) = tokio::join!(
        fixture.engine.transition(
            RunStateChange::new(fixture.run_id, failed()),
            RunStateChangeCompanions::default(),
        ),
        &mut third
    );

    ended.expect("the run ends");
    assert_eq!(third_end.expect("the turn ends"), QuestionTurnEnd::Settled);
    assert_eq!(fixture.state(asked_id(&fixture, 2)), "canceled");
    assert_eq!(fixture.state(waiting), "canceled");
}

// A question whose asker left by the time it was recorded is withdrawn after its record's write,
// whether it was recorded waiting for its run or opened at once, so no record lands after its
// withdrawal: `withdrawn`, the run as it was before. Killed by leaving out the withdrawal on an
// asker that left, or by reading the asker only while the question waits.
#[rstest]
#[case::recorded_waiting(true, "waitingForInput")]
#[case::opened_at_once(false, "running")]
#[tokio::test]
async fn a_question_whose_asker_left_is_withdrawn_after_its_record(
    #[case] is_run_waiting: bool,
    #[case] run_state: &str,
) {
    let fixture = Fixture::new().await;
    let sent = HandedAnswers::default();
    if is_run_waiting {
        fixture
            .ask_answered_by(
                "request-1",
                json!([choice_page()]),
                true,
                HeldRequestAnswerer::ToolServerTask(task_answer(&sent)),
            )
            .await;
    }

    let ended = take_question_in_turn(
        &fixture.questions,
        fixture.question("request-2", json!([choice_page()]), true),
        Some(task_answer(&sent)),
        QuestionTurn::line_up(fixture.run_id),
        std::future::ready(()),
    )
    .await;

    assert_eq!(ended.expect("the turn ends"), QuestionTurnEnd::AskerLeft);
    let left = asked_id(&fixture, usize::from(is_run_waiting));
    assert_eq!(fixture.state(left), "canceled");
    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], "withdrawn");
    assert_eq!(fixture.run_state(), run_state);
}

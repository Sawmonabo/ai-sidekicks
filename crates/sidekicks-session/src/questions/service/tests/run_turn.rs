//! A question asked while its run waits on another: recorded at once waiting for the run, opened
//! only once the run reads running, and canceled with the run's end while it still waits; and a
//! question its provider withdraws while it waits, or while its record is still being written.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::question::{QuestionAskedState, QuestionId};
use sidekicks_provider::port::question::{
    ProviderQuestionWithdrawal, QuestionLinePlace, QuestionTurnEnd, ToolServerQuestionAnswer,
    take_question_in_turn,
};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;

use super::RecordingTaskAnswer;
use crate::questions::service::HeldRequestAnswerer;
use crate::questions::service::test_fixture::{Fixture, HandedAnswers, choice_page, failed};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

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

/// Drives `take` until the log records `count` questions and the request `request_id` is held, so
/// a withdrawal of it finds it, woken by each hold and each record that lands; fails the test
/// should the take end first, as a question taken while its run waited, or 60 s pass.
async fn drive_until_asked(
    fixture: &Fixture,
    count: usize,
    request_id: &str,
    mut take: Pin<&mut impl Future>,
) {
    let asked = async {
        loop {
            let held_or_recorded = fixture.questions.held_or_recorded.notified();
            let mut held_or_recorded = std::pin::pin!(held_or_recorded);
            // Registered before the reads, so a hold or a record after them still wakes it.
            held_or_recorded.as_mut().enable();
            if fixture.payloads("question.asked").len() >= count
                && fixture
                    .questions
                    .held_question_of(fixture.session_id, request_id)
                    .is_some()
            {
                return;
            }
            tokio::select! {
                _ = &mut take => panic!("the question was taken while its run waited"),
                () = held_or_recorded => {}
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(60), asked)
        .await
        .expect("the question is recorded");
}

/// Awaits `work`, failing the test past 60 s.
async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), work)
        .await
        .expect("the work ends in time")
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
        QuestionLinePlace::line_up(fixture.run_id),
        std::future::pending(),
    );
    tokio::pin!(second);
    drive_until_asked(&fixture, 2, "request-2", second.as_mut()).await;
    let waiting = asked_id(&fixture, 1);
    assert_eq!(
        fixture.payloads("question.asked")[1]["state"],
        "waitingForRun"
    );
    assert_eq!(fixture.state(waiting), "waitingForRun");
    assert_eq!(fixture.state(first), "open");
    assert_eq!(fixture.run_state(), "waitingForInput");

    let (answered, taken) = bounded(async {
        tokio::join!(
            fixture.answer(first, json!([{ "kind": "picked", "labels": ["Alpha"] }])),
            &mut second
        )
    })
    .await;

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
        QuestionLinePlace::line_up(fixture.run_id),
        std::future::pending(),
    );
    tokio::pin!(third);
    drive_until_asked(&fixture, 3, "request-3", third.as_mut()).await;
    let (ended, third_end) = bounded(async {
        tokio::join!(
            fixture.engine.transition(
                RunStateChange::new(fixture.run_id, failed()),
                RunStateChangeCompanions::default(),
            ),
            &mut third
        )
    })
    .await;

    ended.expect("the run ends");
    assert_eq!(third_end.expect("the turn ends"), QuestionTurnEnd::Settled);
    assert_eq!(fixture.state(asked_id(&fixture, 2)), "canceled");
    assert_eq!(fixture.state(waiting), "canceled");
}

// A question whose asker left by the time it was recorded is recorded waiting for its run, even
// when it could have opened at once, and withdrawn after its record's write, so no record lands
// after its withdrawal and it never opens: `withdrawn`, the run never moved by it. Killed by
// leaving out the withdrawal on an asker that left, or by letting it open at its record.
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
        QuestionLinePlace::line_up(fixture.run_id),
        std::future::ready(()),
    )
    .await;

    assert_eq!(ended.expect("the turn ends"), QuestionTurnEnd::AskerLeft);
    let left_index = usize::from(is_run_waiting);
    assert_eq!(
        fixture.payloads("question.asked")[left_index]["state"],
        "waitingForRun"
    );
    assert_eq!(fixture.state(asked_id(&fixture, left_index)), "canceled");
    assert_eq!(
        fixture.payloads("question.opened").len(),
        0,
        "it never opens"
    );
    assert_eq!(
        fixture.payloads("agent.run.waitingForInput").len(),
        usize::from(is_run_waiting),
        "the run waits only on the first question"
    );
    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], "withdrawn");
    assert_eq!(fixture.run_state(), run_state);
}

// A driver's question its provider withdraws while it waits for its run ends its take at once,
// settled, the run still waiting on the first question, so the run's line moves on: at the head of
// the line, and second in it, behind a question still waiting. Killed by leaving out the wake of
// the run's waiters in the withdrawal, and, second in line, by waiting for the place alone.
#[rstest]
#[case::head_of_the_line(false)]
#[case::second_in_line(true)]
#[tokio::test]
async fn a_waiting_question_its_provider_withdraws_ends_its_turn_at_once(
    #[case] is_behind_another: bool,
) {
    let fixture = Fixture::new().await;
    fixture.ask("request-1", json!([choice_page()]), true).await;
    let head = take_question_in_turn(
        &fixture.questions,
        fixture.question("request-2", json!([choice_page()]), true),
        None,
        QuestionLinePlace::line_up(fixture.run_id),
        std::future::pending(),
    );
    tokio::pin!(head);
    drive_until_asked(&fixture, 2, "request-2", head.as_mut()).await;
    let mut behind = is_behind_another.then(|| {
        Box::pin(take_question_in_turn(
            &fixture.questions,
            fixture.question("request-3", json!([choice_page()]), true),
            None,
            QuestionLinePlace::line_up(fixture.run_id),
            std::future::pending(),
        ))
    });
    let (withdrawn_id, withdrawn) = match behind.as_mut() {
        Some(behind) => {
            drive_until_asked(&fixture, 3, "request-3", behind.as_mut()).await;
            ("request-3", behind.as_mut())
        }
        None => ("request-2", head.as_mut()),
    };

    let (withdrawal, ended) = bounded(async {
        tokio::join!(
            fixture
                .questions
                .withdraw_question(ProviderQuestionWithdrawal {
                    session_id: fixture.session_id,
                    request_id: withdrawn_id.to_owned(),
                }),
            withdrawn
        )
    })
    .await;

    withdrawal.expect("the withdrawal is taken");
    assert_eq!(ended.expect("the turn ends"), QuestionTurnEnd::Settled);
    let withdrawn_index = if is_behind_another { 2 } else { 1 };
    assert_eq!(
        fixture.state(asked_id(&fixture, withdrawn_index)),
        "canceled"
    );
    if is_behind_another {
        assert_eq!(fixture.state(asked_id(&fixture, 1)), "waitingForRun");
    }
    assert_eq!(fixture.run_state(), "waitingForInput");
}

// A withdrawal that lands while its question's record is still being written waits for the record
// and then cancels the question, moving the run back to `running`, so no question stays open for
// a request its provider dropped. The session's appends are held so the record stops inside its
// write. Killed by holding the request only after the record's write, which answers the withdrawal
// as a request no question holds.
#[tokio::test]
async fn a_withdrawal_during_its_questions_record_ends_the_question() {
    let fixture = Fixture::new().await;
    let appends_held = SESSION_APPEND_LOCK.acquire(fixture.session_id).await;
    let held_alone = SESSION_APPEND_LOCK.queue_handle_count(fixture.session_id);
    let record = fixture.questions.take_question(
        fixture.question("request-1", json!([choice_page()]), true),
        HeldRequestAnswerer::Driver,
    );
    tokio::pin!(record);
    bounded(async {
        tokio::select! {
            _ = &mut record => panic!("the question was recorded while its appends were held"),
            () = SESSION_APPEND_LOCK.wait_for_queue_past(fixture.session_id, held_alone) => {}
        }
    })
    .await;
    let withdrawal = fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-1".to_owned(),
        });
    tokio::pin!(withdrawal);
    assert!(
        futures::poll!(withdrawal.as_mut()).is_pending(),
        "the withdrawal waits for the question's record"
    );

    drop(appends_held);
    let (recorded, withdrawn) = bounded(async { tokio::join!(record, withdrawal) }).await;

    let question_id = recorded.expect("the question is recorded");
    withdrawn.expect("the withdrawal is taken");
    assert_eq!(fixture.state(question_id), "canceled");
    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], "withdrawn");
    assert_eq!(fixture.run_state(), "running");
    assert!(
        fixture
            .questions
            .held_question_of(fixture.session_id, "request-1")
            .is_none()
    );
}

// A withdrawal that lands while a question asked in its turn is recorded, its open refused because
// its run waits on another question, finds the request held throughout and cancels the question
// once it is recorded waiting for its run: the open and the waiting record share one question id
// and lock. Killed by a waiting record under a new id, which the withdrawal, waiting on the first
// id's lock, finds unheld and lets go.
#[tokio::test]
async fn a_withdrawal_during_a_records_fall_back_to_waiting_ends_the_question() {
    let fixture = Fixture::new().await;
    fixture.ask("request-0", json!([choice_page()]), true).await;
    let record = fixture.questions.record_question_in_turn(
        fixture.question("request-1", json!([choice_page()]), true),
        HeldRequestAnswerer::Driver,
        true,
    );
    tokio::pin!(record);
    drive_until_asked(&fixture, 1, "request-1", record.as_mut()).await;
    let withdrawal = fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-1".to_owned(),
        });
    tokio::pin!(withdrawal);
    assert!(
        futures::poll!(withdrawal.as_mut()).is_pending(),
        "the withdrawal waits for the question's record"
    );

    let (recorded, withdrawn) = bounded(async { tokio::join!(record, withdrawal) }).await;

    assert_eq!(
        recorded.expect("the question is recorded"),
        QuestionAskedState::WaitingForRun
    );
    withdrawn.expect("the withdrawal is taken");
    assert_eq!(fixture.state(asked_id(&fixture, 1)), "canceled");
    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], "withdrawn");
    assert_eq!(fixture.run_state(), "waitingForInput");
    assert!(
        fixture
            .questions
            .held_question_of(fixture.session_id, "request-1")
            .is_none()
    );
}

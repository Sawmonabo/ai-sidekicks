//! A held question's answer through whoever asked it, and the answers its record refuses.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAskedState, QuestionId, QuestionSettledState,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::events::content::codec::{StoredBodyColumns, stored_body_columns_sql};

use super::{RecordingTaskAnswer, SECRET, form_field_page, refusal_of, secret_page};
use crate::questions::service::HeldRequestAnswerer;
use crate::questions::service::test_fixture::{Fixture, HandedAnswers, choice_page};

// A held question moves its run to `waitingForInput` with its record; its answer goes once to
// whoever sends it on, the driver under the provider's request id or the tool-server task that
// asked, and never to the other, before one write settles it `answered`, appends the person's
// turn with the device and the secret masked, and moves the run back to `running`; the secret is
// in no stored row. A second answer reads the state back and sends nothing. Killed by writing
// before the answer goes out, by sending a task's answer to the driver, by storing the secret, by
// a missing device, and by dropping the settled-state read.
#[rstest]
#[case::through_the_driver(false)]
#[case::through_the_tool_server_task(true)]
#[tokio::test]
async fn a_held_questions_answer_goes_to_its_asker_then_settles_it_in_one_write(
    #[case] is_asked_by_a_task: bool,
) {
    let fixture = Fixture::new().await;
    let sent_to_task = HandedAnswers::default();
    let answered_by = if is_asked_by_a_task {
        HeldRequestAnswerer::ToolServerTask(Arc::new(RecordingTaskAnswer(Arc::clone(
            &sent_to_task,
        ))))
    } else {
        HeldRequestAnswerer::Driver
    };
    let question_id = fixture
        .ask_answered_by(
            "request-1",
            json!([choice_page(), secret_page()]),
            true,
            answered_by,
        )
        .await;
    assert_eq!(fixture.run_state(), "waitingForInput");
    assert_eq!(fixture.state(question_id), "open");

    let answers = json!([
        { "kind": "picked", "labels": ["Beta"] },
        { "kind": "secret", "value": SECRET },
    ]);
    let first = fixture.answer(question_id, answers.clone()).await;
    let second = fixture.answer(question_id, answers).await;

    assert_eq!(
        first.expect("the answer lands"),
        QuestionSettledState::Answered
    );
    assert_eq!(
        second.expect("a second answer reads the state"),
        QuestionSettledState::Answered
    );
    let sent_to_task = sent_to_task.lock().expect("never poisoned").clone();
    let handed = if is_asked_by_a_task {
        assert_eq!(fixture.handed_count(), 0);
        assert_eq!(sent_to_task.len(), 1);
        sent_to_task[0].clone()
    } else {
        assert_eq!(sent_to_task.len(), 0);
        assert_eq!(fixture.handed_count(), 1);
        let handed = fixture.handed.lock().expect("never poisoned")[0].clone();
        assert_eq!(handed.0, "request-1");
        handed
    };
    assert!(matches!(&handed.1[1], QuestionAnswer::Secret { value } if value.as_str() == SECRET));
    assert_eq!(fixture.state(question_id), "answered");
    assert_eq!(fixture.run_state(), "running");
    let turns = fixture.payloads("user.message.sent");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["answersQuestionId"], json!(question_id));
    assert_eq!(turns[0]["deviceId"], "device-1");
    assert_eq!(turns[0]["message"], "Beta\nAnswered (secret)");
    // A stored body may be compressed, so each is decoded before it is searched.
    let reader = fixture.database.reader();
    let mut statement = reader
        .prepare(&format!(
            "SELECT event.payload, {} FROM session_events AS event",
            stored_body_columns_sql("event"),
        ))
        .expect("the log's read prepares");
    let holding_rows = statement
        .query_map([], |row| {
            let payload: String = row.get(0)?;
            let body = StoredBodyColumns::read(row, 1)?.decode(1)?;
            Ok(payload.contains(SECRET) || body.is_some_and(|body| body.contains(SECRET)))
        })
        .expect("the log reads")
        .collect::<rusqlite::Result<Vec<bool>>>()
        .expect("the log reads");
    assert!(!holding_rows.contains(&true));
}

/// What a refused answer is given for.
#[derive(Clone, Copy, Debug)]
enum RefusedRecord {
    /// A two-page question its agent waits on: a form field, then a secret.
    Waited,
    /// A one-page question its agent does not wait for.
    Unwaited,
    /// A one-page question waiting for its run.
    WaitingForRun,
    /// An id no record holds.
    Unknown,
}

// The answers are checked against the record before anything goes out: a short list is refused
// `question.answersIncomplete`, an answer its question cannot take `question.answerInvalid` with
// its page and reason, an id no record holds `question.notFound`, a question its agent does not
// wait for `question.notWaiting`, and one that waits for its run `question.waitingForRun`; none
// of them reaches the driver, the record keeps its state and the run where it was. Killed by
// removing the count check, any one reason's check, the waiting check, or the check of a question
// waiting for its run.
#[rstest]
#[case::one_answer_short(
    RefusedRecord::Waited,
    json!([{ "kind": "skipped" }]),
    RefusalCode::QuestionAnswersIncomplete,
    None,
    "waitingForInput"
)]
#[case::a_secret_on_a_plain_question(
    RefusedRecord::Waited,
    json!([{ "kind": "secret", "value": SECRET }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "secretOnPlain")),
    "waitingForInput"
)]
#[case::text_on_a_secret_question(
    RefusedRecord::Waited,
    json!([{ "kind": "skipped" }, { "kind": "typed", "text": "plain" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((1, "secretOnPlain")),
    "waitingForInput"
)]
#[case::a_label_not_offered(
    RefusedRecord::Waited,
    json!([{ "kind": "picked", "labels": ["Gamma"] }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "labelNotOffered")),
    "waitingForInput"
)]
#[case::several_on_a_single_choice(
    RefusedRecord::Waited,
    json!([{ "kind": "picked", "labels": ["Alpha", "Beta"] }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "severalOnSingle")),
    "waitingForInput"
)]
#[case::text_on_a_form_fields_choice(
    RefusedRecord::Waited,
    json!([{ "kind": "typed", "text": "Gamma" }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "textOnChoice")),
    "waitingForInput"
)]
#[case::a_question_its_agent_does_not_wait_for(
    RefusedRecord::Unwaited,
    json!([{ "kind": "skipped" }]),
    RefusalCode::QuestionNotWaiting,
    None,
    "running"
)]
#[case::a_question_waiting_for_its_run(
    RefusedRecord::WaitingForRun,
    json!([{ "kind": "skipped" }]),
    RefusalCode::QuestionWaitingForRun,
    None,
    "running"
)]
#[case::an_id_no_record_holds(
    RefusedRecord::Unknown,
    json!([{ "kind": "skipped" }]),
    RefusalCode::QuestionNotFound,
    None,
    "running"
)]
#[tokio::test]
async fn an_answer_its_record_cannot_take_is_refused_with_nothing_sent(
    #[case] record: RefusedRecord,
    #[case] answers: Value,
    #[case] code: RefusalCode,
    #[case] invalid: Option<(usize, &str)>,
    #[case] run_state: &str,
) {
    let fixture = Fixture::new().await;
    let recorded = match record {
        RefusedRecord::Waited => Some((
            fixture
                .ask("request-1", json!([form_field_page(), secret_page()]), true)
                .await,
            "open",
        )),
        RefusedRecord::Unwaited => Some((
            fixture
                .ask("request-1", json!([choice_page()]), false)
                .await,
            "open",
        )),
        RefusedRecord::WaitingForRun => Some((
            fixture
                .questions
                .record_question(
                    fixture.question("request-1", json!([choice_page()]), true),
                    HeldRequestAnswerer::Driver,
                    QuestionAskedState::WaitingForRun,
                )
                .await
                .expect("the question is recorded"),
            "waitingForRun",
        )),
        RefusedRecord::Unknown => None,
    };
    let question_id = recorded.map_or_else(
        || QuestionId::try_from(mint_uuid_v7()).expect("a minted UUID"),
        |(question_id, _)| question_id,
    );

    let (refused, detail) = refusal_of(
        fixture
            .answer(question_id, answers)
            .await
            .expect_err("the answer is refused"),
    );

    assert_eq!(refused, code);
    if let Some((page, reason)) = invalid {
        assert_eq!(
            (detail["page"].clone(), detail["reason"].clone()),
            (json!(page), json!(reason))
        );
    }
    assert_eq!(fixture.handed_count(), 0);
    if let Some((question_id, state)) = recorded {
        assert_eq!(fixture.state(question_id), state);
    }
    assert_eq!(fixture.run_state(), run_state);
}

// An agent's question takes typed text on a page with options, which only a form field refuses:
// the text reaches the driver and settles the question. Killed by refusing text on every page
// with options.
#[tokio::test]
async fn typed_text_on_an_agents_choice_reaches_the_driver() {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;

    let settled = fixture
        .answer(question_id, json!([{ "kind": "typed", "text": "Gamma" }]))
        .await;

    assert_eq!(
        settled.expect("the text is taken"),
        QuestionSettledState::Answered
    );
    assert_eq!(fixture.handed_count(), 1);
    let handed = fixture.handed.lock().expect("never poisoned")[0].clone();
    assert!(matches!(&handed.1[0], QuestionAnswer::Typed { text } if text.as_str() == "Gamma"));
}

// A question open from before the daemon's restart, its held request lost with the restart, that
// its provider asks again under the same request returns to its record: no second record and no
// second `question.asked`, the run still `waitingForInput`, and the answer goes back under the
// request sent again. Killed by dropping the match, which records the question again and fails
// to move a run already waiting, and by leaving the request unheld, which refuses the answer.
#[tokio::test]
async fn a_question_asked_again_after_a_restart_returns_to_its_open_record() {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture.questions.forget_held_request(&question_id);

    let asked_again = fixture
        .questions
        .take_question(
            fixture.question("request-1", json!([choice_page()]), true),
            HeldRequestAnswerer::Driver,
        )
        .await
        .expect("the question asked again is taken");

    assert_eq!(asked_again, question_id);
    assert_eq!(fixture.payloads("question.asked").len(), 1);
    assert_eq!(fixture.run_state(), "waitingForInput");
    let open: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM questions WHERE state = 'open'",
            [],
            |row| row.get(0),
        )
        .expect("the open questions count");
    assert_eq!(open, 1);
    fixture
        .answer(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await
        .expect("the answer lands");
    let handed = fixture.handed.lock().expect("never poisoned").clone();
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].0, "request-1");
    assert_eq!(fixture.state(question_id), "answered");
}

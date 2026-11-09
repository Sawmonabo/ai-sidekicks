//! A workflow wait's question: asked once per wait, settled by the write that ends the wait in its
//! own session and again by a rebuild, its form's schema kept as asked, and its answers handed to
//! the wait, which may refuse one.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAnswerInvalidReason, QuestionAskedPayload, QuestionId, QuestionPrompt,
    QuestionResolveState, QuestionWaitOutcome, QuestionWaitSettledPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_store::database::writer::test_file::test_session_id;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use sidekicks_store::events::session::read::{SessionEventFilter, SessionEventReads};

use super::refusal_of;
use crate::questions::QuestionSettledState;
use crate::questions::projection::QuestionsProjection;
use crate::questions::service::test_fixture::Fixture;
use crate::questions::store::read_asked;
use crate::questions::waits::{QuestionWaitAnswer, QuestionWaitError, QuestionWaits};

/// A fresh wait id.
fn fresh_wait_id() -> UuidTextForm {
    UuidTextForm::from(mint_uuid_v7())
}

/// A reply wait's one page, which takes typed text and no skip.
fn reply_page() -> Value {
    json!({
        "text": "What should the summary say?",
        "options": [],
        "severalAnswers": false,
        "secret": false,
        "required": true,
    })
}

/// Asks `pages` as the question `wait_id` holds in `session_id`, with `form_schema` where given.
async fn ask_wait(
    fixture: &Fixture,
    session_id: SessionId,
    wait_id: UuidTextForm,
    pages: Value,
    form_schema: Option<Value>,
) -> QuestionId {
    let pages = serde_json::from_value::<Vec<QuestionPrompt>>(pages).expect("the test's pages");
    fixture
        .questions
        .ask_for_wait(
            session_id,
            wait_id,
            BoundedVec::new(pages).expect("the test asks one page or more"),
            form_schema.map(|schema| serde_json::from_value(schema).expect("the test's schema")),
        )
        .await
        .expect("the wait's question is recorded")
}

/// Every question row's id and state, in id order.
fn question_rows(fixture: &Fixture) -> Vec<(String, String)> {
    let reader = fixture.database.reader();
    let mut statement = reader
        .prepare("SELECT id, state FROM questions ORDER BY id")
        .expect("the read prepares");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the rows read")
        .collect::<rusqlite::Result<_>>()
        .expect("every row reads")
}

/// Writes the fixture's session's question rows again from its log, as a rebuild does.
async fn rebuild(fixture: &Fixture) {
    let reader = fixture.database.reader();
    let envelopes = SessionEventReads::new(&reader, |_: &SessionId| None)
        .read_after(&fixture.session_id, -1, -1, SessionEventFilter::default())
        .expect("the log reads");
    let mut statements = QuestionsProjection.clear_statements(&fixture.session_id);
    let mut fold = QuestionsProjection.fold(&fixture.session_id);
    for envelope in &envelopes {
        let event = SessionEvent::from_envelope(envelope).expect("each event reads");
        fold.apply(envelope, &event, &mut statements)
            .expect("each event folds");
    }
    fixture
        .writer
        .write(statements)
        .await
        .expect("the rebuild writes");
}

/// A door of the workflow waits that keeps each answer it is handed and answers as scripted.
struct RecordingWaits {
    handed: Mutex<Vec<QuestionWaitAnswer>>,
    refusal: Option<(usize, QuestionAnswerInvalidReason)>,
}

impl QuestionWaits for RecordingWaits {
    fn answer_wait(
        &self,
        answer: QuestionWaitAnswer,
    ) -> BoxFuture<'_, Result<QuestionSettledState, QuestionWaitError>> {
        self.handed
            .lock()
            .expect("the test's record is never poisoned")
            .push(answer);
        let answered = match self.refusal {
            Some((page, reason)) => Err(QuestionWaitError::Refused { page, reason }),
            None => Ok(QuestionSettledState::Answered),
        };
        async move { answered }.boxed()
    }
}

/// A wait asked twice, as a restart asks a stored wait again, writes one `question.asked` and
/// answers one id. Kills: the open question's read skipped.
#[tokio::test]
async fn a_wait_asked_twice_asks_one_question() {
    let fixture = Fixture::new().await;
    let wait_id = fresh_wait_id();

    let first = ask_wait(
        &fixture,
        fixture.session_id,
        wait_id,
        json!([reply_page()]),
        None,
    )
    .await;
    let second = ask_wait(
        &fixture,
        fixture.session_id,
        wait_id,
        json!([reply_page()]),
        None,
    )
    .await;

    assert_eq!(first, second);
    assert_eq!(fixture.payloads("question.asked").len(), 1);
}

/// `question.wait.settled` settles in its own write the open question its wait holds in its own
/// session, `answered` for an answer and `canceled` for a timeout or an end, leaves another
/// session's question under the same wait id open, and a rebuild writes the same rows. Kills: the
/// session dropped from the settle's key; the fold's arm missing; `timedOut` read as answered.
#[rstest]
#[case::answered(QuestionWaitOutcome::Answered, "answered")]
#[case::timed_out(QuestionWaitOutcome::TimedOut, "canceled")]
#[case::ended(QuestionWaitOutcome::Ended, "canceled")]
#[tokio::test]
async fn a_waits_settled_mark_settles_its_sessions_question_live_and_in_a_rebuild(
    #[case] outcome: QuestionWaitOutcome,
    #[case] settled: &str,
) {
    let fixture = Fixture::new().await;
    let wait_id = fresh_wait_id();
    let held = ask_wait(
        &fixture,
        fixture.session_id,
        wait_id,
        json!([reply_page()]),
        None,
    )
    .await;
    let other = ask_wait(
        &fixture,
        test_session_id(),
        wait_id,
        json!([reply_page()]),
        None,
    )
    .await;

    let event = SessionEvent::QuestionWaitSettled(QuestionWaitSettledPayload {
        session_id: fixture.session_id,
        wait_id,
        outcome,
    });
    fixture
        .questions
        .appender
        .append(
            SessionEventDraft::of_session(fixture.session_id, &event)
                .expect("the event passes its checks"),
            SessionEventLinkage::default(),
        )
        .await
        .expect("the mark is appended");

    assert_eq!(fixture.state(held), settled);
    assert_eq!(fixture.state(other), "open");
    let live = question_rows(&fixture);
    rebuild(&fixture).await;
    assert_eq!(question_rows(&fixture), live);
}

/// A form wait's schema reads back from its record with its fields in the order it was asked,
/// not sorted. Kills: the schema stored through a re-sorted copy.
#[tokio::test]
async fn a_form_waits_schema_keeps_its_fields_order() {
    let fixture = Fixture::new().await;
    let schema = json!({
        "type": "object",
        "properties": {
            "zone": { "type": "string", "title": "Zone" },
            "amount": { "type": "integer", "title": "Amount" },
            "label": { "type": "string", "title": "Label" },
        },
    });
    let question_id = ask_wait(
        &fixture,
        fixture.session_id,
        fresh_wait_id(),
        json!([reply_page()]),
        Some(schema),
    )
    .await;

    let asked = read_asked(&fixture.database.reader(), fixture.session_id, &question_id)
        .expect("the record reads")
        .expect("the record is in the log");
    let QuestionAskedPayload::Wait(asked) = asked else {
        panic!("a wait's record is a wait's");
    };
    let form_schema = asked
        .form_schema
        .expect("a form's record carries its schema");
    let properties = form_schema.as_map()["properties"]
        .0
        .as_object()
        .expect("the schema's fields")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(properties, ["zone", "amount", "label"]);
}

/// A wait's question hands its checked answers to the wait with the record as asked, a skip of a
/// page that is not required among them, and a refusal from the wait answers
/// `question.answerInvalid` at its page with the question left open. Kills: a skip refused on a
/// page that is not required; the wait's refusal answered as a fault or at another page.
#[rstest]
#[case::taken(None)]
#[case::refused_by_the_wait(Some((1, QuestionAnswerInvalidReason::FieldValueInvalid)))]
#[tokio::test]
async fn a_waits_answers_go_to_the_wait(
    #[case] refusal: Option<(usize, QuestionAnswerInvalidReason)>,
) {
    let fixture = Fixture::new().await;
    let waits = Arc::new(RecordingWaits {
        handed: Mutex::new(Vec::new()),
        refusal,
    });
    fixture
        .questions
        .waits()
        .register(Arc::clone(&waits) as Arc<dyn QuestionWaits>)
        .expect("the waits register once");
    let mut optional_page = reply_page();
    optional_page["required"] = json!(false);
    let wait_id = fresh_wait_id();
    let question_id = ask_wait(
        &fixture,
        fixture.session_id,
        wait_id,
        json!([reply_page(), optional_page]),
        None,
    )
    .await;

    let answered = fixture
        .answer(
            question_id,
            json!([{ "kind": "typed", "text": "Ship it" }, { "kind": "skipped" }]),
        )
        .await;

    let handed = waits.handed.lock().expect("never poisoned");
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].wait_id, wait_id);
    assert_eq!(handed[0].asked.question_id, question_id);
    assert!(matches!(handed[0].answers[1], QuestionAnswer::Skipped {}));
    match refusal {
        None => assert_eq!(
            answered.expect("the wait takes the answers"),
            QuestionResolveState::Answered
        ),
        Some((page, reason)) => {
            let (code, detail) = refusal_of(answered.expect_err("the wait refuses"));
            assert_eq!(code, RefusalCode::QuestionAnswerInvalid);
            assert_eq!(
                (detail["page"].clone(), detail["reason"].clone()),
                (json!(page), json!(reason))
            );
            assert_eq!(fixture.state(question_id), "open");
        }
    }
}

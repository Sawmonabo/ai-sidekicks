//! The question record over a test database holding one running run bound to the table's first
//! provider, whose driver is a stand-in that records each answer it is handed: a held question's
//! answer, the refusals that send nothing, each way a question ends unanswered, and the queued
//! answers of a question its agent does not wait for, rebuilt from the log.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionId, QuestionPrompt, QuestionResolveRequest, QuestionSettledState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::list::BoundedVec;
use tempfile::TempDir;

use super::{QUESTION_STATEMENT_CAPACITY, QuestionError, QuestionsService};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::read::DamagedFromSequenceReader;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::provider::driver::contract::{MockProviderDriver, ProviderRequestAnswer};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::provider::port::question::{ProviderQuestion, ProviderQuestionWithdrawal};
use crate::questions::projection::{QuestionsProjection, question_projection_statements};
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::projection_rebuild::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildRequest, ProjectionRebuildService,
};
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};
use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use crate::uuid_v7::mint_uuid_v7;

/// The secret the tests answer with, which no stored row may hold.
const SECRET: &str = "the-secret-value-41";

/// Each answer the stand-in driver was handed: its request id and its answers.
type HandedAnswers = Arc<Mutex<Vec<(String, Vec<QuestionAnswer>)>>>;

/// A running run bound to a stand-in driver, its engine, the log with the queued answers'
/// statements, and the questions service.
struct Fixture {
    database: TestDatabase,
    writer: Arc<DatabaseWriter>,
    appender: SessionEventAppender,
    engine: Arc<RunEngine>,
    questions: QuestionsService,
    session_id: SessionId,
    run_id: RunId,
    handed: HandedAnswers,
    _home: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new();
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: Some(Box::new(question_projection_statements)),
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        bind_run_to_first_provider(&database, run_id);
        let handed = HandedAnswers::default();
        let recorded = Arc::clone(&handed);
        let mut driver = MockProviderDriver::new();
        driver.expect_respond_to_request().returning(move |params| {
            let ProviderRequestAnswer::Question { answers } = params.response else {
                panic!("the questions service answers only questions");
            };
            recorded
                .lock()
                .expect("the test's record is never poisoned")
                .push((params.request_id, answers));
            async { Ok(()) }.boxed()
        });
        let engine = test_engine(&database, Arc::clone(&event_log), home.path());
        let appender =
            SessionEventAppender::new(Arc::clone(&event_log), SESSION_EVENT_VERSION.clone());
        let questions = QuestionsService::new(
            Arc::new(SessionEventAppender::new(
                event_log,
                SESSION_EVENT_VERSION.clone(),
            )),
            Arc::new(DatabaseReadPool::new(
                database.path(),
                QUESTION_STATEMENT_CAPACITY,
            )),
            Arc::clone(&engine),
            Arc::new(registry_of_first_provider(Arc::new(driver))),
        );
        Self {
            database,
            writer,
            appender,
            engine,
            questions,
            session_id,
            run_id,
            handed,
            _home: home,
        }
    }

    /// Asks `pages` under `request_id`, held by the run when `is_agent_waiting`.
    async fn ask(&self, request_id: &str, pages: Value, is_agent_waiting: bool) -> QuestionId {
        self.questions
            .take_question(ProviderQuestion {
                session_id: self.session_id,
                run_id: self.run_id,
                request_id: request_id.to_owned(),
                questions: serde_json::from_value::<Vec<QuestionPrompt>>(pages)
                    .expect("the test's pages read"),
                is_agent_waiting,
            })
            .await
            .expect("the question is recorded")
    }

    /// Answers `question_id` with `answers` from a device.
    async fn answer(
        &self,
        question_id: QuestionId,
        answers: Value,
    ) -> Result<QuestionSettledState, QuestionError> {
        self.questions
            .resolve_question(
                QuestionResolveRequest {
                    question_id,
                    answers: BoundedVec::new(
                        serde_json::from_value(answers).expect("the test's answers read"),
                    )
                    .expect("the test answers at least once"),
                },
                DeviceId::new("device-1".to_owned()).expect("a device id"),
            )
            .await
            .map(|resolved| resolved.state)
    }

    /// Appends `event`, given as its type and payload, as the queue would.
    async fn append(&self, event_type: &str, payload: Value) {
        let event: SessionEvent =
            serde_json::from_value(json!({ "type": event_type, "payload": payload }))
                .expect("the test writes a valid event");
        self.appender
            .append(
                SessionEventDraft::of_session(self.session_id, &event)
                    .expect("the event passes its checks"),
                SessionEventLinkage::default(),
            )
            .await
            .expect("the test's event is appended");
    }

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

    /// The state `question_id`'s row holds.
    fn state(&self, question_id: QuestionId) -> String {
        self.database
            .reader()
            .query_row(
                "SELECT state FROM questions WHERE id = ?1",
                [question_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the question's row reads")
    }

    fn run_state(&self) -> String {
        stored_run_state(&self.database, &self.run_id).0
    }

    fn handed_count(&self) -> usize {
        self.handed.lock().expect("never poisoned").len()
    }
}

fn choice_page() -> Value {
    json!({
        "text": "Which one?",
        "options": [{ "label": "Alpha" }, { "label": "Beta" }],
        "severalAnswers": false,
        "secret": false,
    })
}

fn secret_page() -> Value {
    json!({ "text": "The token?", "options": [], "severalAnswers": false, "secret": true })
}

fn refusal_of(failure: QuestionError) -> (RefusalCode, Value) {
    let QuestionError::Refused(refusal) = failure else {
        panic!("the answer is refused, not failed: {failure}");
    };
    (
        refusal.code,
        refusal.detail.map_or(Value::Null, |detail| json!(detail)),
    )
}

// A held question moves its run to `waitingForInput` with its record; its answer goes to the
// driver once, under the provider's request id, before one write settles it `answered`, appends
// the person's turn with the device and the secret masked, and moves the run back to `running`;
// the secret is in no stored row. A second answer reads the state back and sends nothing. Killed
// by writing before the driver call, by storing the secret, by a missing device, and by dropping
// the settled-state read.
#[tokio::test]
async fn a_held_questions_answer_goes_to_the_driver_then_settles_it_in_one_write() {
    let fixture = Fixture::new().await;
    let question_id = fixture
        .ask("request-1", json!([choice_page(), secret_page()]), true)
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
    assert_eq!(fixture.handed_count(), 1);
    let handed = fixture.handed.lock().expect("never poisoned")[0].clone();
    assert_eq!(handed.0, "request-1");
    assert!(matches!(&handed.1[1], QuestionAnswer::Secret { value } if value.as_str() == SECRET));
    assert_eq!(fixture.state(question_id), "answered");
    assert_eq!(fixture.run_state(), "running");
    let turns = fixture.payloads("user.message.sent");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["answersQuestionId"], json!(question_id));
    assert_eq!(turns[0]["deviceId"], "device-1");
    assert_eq!(turns[0]["message"], "Beta\nAnswered (secret)");
    let holding_rows: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT count(*) FROM session_events
              WHERE instr(payload, ?1) > 0 OR instr(CAST(content_payload AS TEXT), ?1) > 0",
            [SECRET],
            |row| row.get(0),
        )
        .expect("the log reads");
    assert_eq!(holding_rows, 0);
}

// The answers are checked against the record before anything goes out: a short list is refused
// `question.answersIncomplete`, an answer its question cannot take `question.answerInvalid` with
// its page and reason, an id no record holds `question.notFound`, and a question its agent does
// not wait for `question.notWaiting`; none of them reaches the driver. Killed by removing the
// count check, any one reason's check, or the waiting check.
#[rstest]
#[case::one_answer_short(json!([{ "kind": "skipped" }]), RefusalCode::QuestionAnswersIncomplete, None)]
#[case::a_secret_on_a_plain_question(
    json!([{ "kind": "secret", "value": SECRET }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "secretOnPlain"))
)]
#[case::text_on_a_secret_question(
    json!([{ "kind": "skipped" }, { "kind": "typed", "text": "plain" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((1, "secretOnPlain"))
)]
#[case::a_label_not_offered(
    json!([{ "kind": "picked", "labels": ["Gamma"] }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "labelNotOffered"))
)]
#[case::several_on_a_single_choice(
    json!([{ "kind": "picked", "labels": ["Alpha", "Beta"] }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "severalOnSingle"))
)]
#[tokio::test]
async fn an_answer_its_record_cannot_take_is_refused_with_nothing_sent(
    #[case] answers: Value,
    #[case] code: RefusalCode,
    #[case] invalid: Option<(usize, &str)>,
) {
    let fixture = Fixture::new().await;
    let question_id = fixture
        .ask("request-1", json!([choice_page(), secret_page()]), true)
        .await;

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
    assert_eq!(fixture.state(question_id), "open");
}

#[tokio::test]
async fn an_unknown_or_unwaited_question_is_refused_with_nothing_sent() {
    let fixture = Fixture::new().await;
    let unwaited = fixture
        .ask("request-1", json!([choice_page()]), false)
        .await;
    let unknown = QuestionId::try_from(mint_uuid_v7()).expect("a minted UUID");
    let skip = json!([{ "kind": "skipped" }]);

    let unwaited = refusal_of(
        fixture
            .answer(unwaited, skip.clone())
            .await
            .expect_err("refused"),
    );
    let unknown = refusal_of(fixture.answer(unknown, skip).await.expect_err("refused"));

    assert_eq!(unwaited.0, RefusalCode::QuestionNotWaiting);
    assert_eq!(unknown.0, RefusalCode::QuestionNotFound);
    assert_eq!(fixture.run_state(), "running");
    assert_eq!(fixture.handed_count(), 0);
}

/// How a held question ends unanswered.
#[derive(Clone, Copy, Debug)]
enum QuestionEnd {
    /// The provider withdraws it.
    Withdrawn,
    /// The provider withdraws it after an interrupt of its run was asked for.
    WithdrawnUnderInterrupt,
    /// Its run is interrupted.
    RunInterrupted,
    /// Its run fails, as any end but an interrupt.
    RunFailed,
}

// A held question that ends unanswered is canceled once, in the write that moves or ends its run,
// with the reason the run's own state gives: a withdrawal `withdrawn` and the run back to
// `running`, unless an interrupt of the run is recorded, which makes it `interrupted`; an
// interrupted end `interrupted`; any other end `runEnded`. Killed by a cancellation in a second
// write, by a reason read from the report rather than the run, and by a run left waiting.
#[rstest]
#[case::withdrawn(QuestionEnd::Withdrawn, "withdrawn", "running")]
#[case::withdrawn_under_an_interrupt(
    QuestionEnd::WithdrawnUnderInterrupt,
    "interrupted",
    "running"
)]
#[case::run_interrupted(QuestionEnd::RunInterrupted, "interrupted", "interrupted")]
#[case::run_failed(QuestionEnd::RunFailed, "runEnded", "failed")]
#[tokio::test]
async fn a_held_question_ends_canceled_with_its_runs_reason(
    #[case] end: QuestionEnd,
    #[case] reason: &str,
    #[case] run_state: &str,
) {
    let fixture = Fixture::new().await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;
    let withdrawal = ProviderQuestionWithdrawal {
        session_id: fixture.session_id,
        request_id: "request-1".to_owned(),
    };

    match end {
        QuestionEnd::Withdrawn => {}
        QuestionEnd::WithdrawnUnderInterrupt => {
            fixture
                .database
                .reader()
                .execute(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', 'requested', '{}', 1, ?1, '')",
                    [
                        mint_uuid_v7().to_string(),
                        fixture.run_id.text().as_str().to_owned(),
                    ],
                )
                .expect("the test records the interrupt");
        }
        QuestionEnd::RunInterrupted | QuestionEnd::RunFailed => {
            let entry = if matches!(end, QuestionEnd::RunInterrupted) {
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                }
            } else {
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: None,
                    provider_failure_detail: None,
                    process_exit: None,
                }
            };
            fixture
                .engine
                .transition(
                    RunStateChange::new(fixture.run_id, entry),
                    RunStateChangeCompanions::default(),
                )
                .await
                .expect("the run ends");
        }
    }
    // A withdrawal after the run's end finds the question settled and writes nothing.
    fixture
        .questions
        .withdraw_question(withdrawal)
        .await
        .expect("the withdrawal is taken");

    let canceled = fixture.payloads("question.canceled");
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["reason"], reason);
    assert_eq!(fixture.state(question_id), "canceled");
    assert_eq!(fixture.run_state(), run_state);
}

fn table_rows(connection: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = connection.prepare(sql).expect("the read prepares");
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("the rows read")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("every row reads")
}

fn question_rows(connection: &Connection) -> (Vec<Vec<SqlValue>>, Vec<Vec<SqlValue>>) {
    (
        table_rows(connection, "SELECT * FROM questions ORDER BY id"),
        table_rows(
            connection,
            "SELECT * FROM question_answer_items ORDER BY queue_item_id",
        ),
    )
}

// A question its agent does not wait for stays open while a send naming it is queued, stays open
// when that item is withdrawn, and is answered when the agent takes a queued answer; of two
// devices' answers the first taken wins and unpairs the other, and an item that answers nothing
// answers nothing. The rows a rebuild writes from the log, with a held question answered and one
// withdrawn beside them, are the rows the live writes wrote. Killed by answering at send time, by
// answering on another item's admission, and by a fold arm that drops an event.
#[tokio::test]
async fn queued_answers_settle_a_question_its_agent_does_not_wait_for_and_rebuild_as_written() {
    let fixture = Fixture::new().await;
    let withdrawn = fixture.ask("request-1", json!([choice_page()]), true).await;
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-1".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let held = fixture.ask("request-2", json!([choice_page()]), true).await;
    fixture
        .answer(held, json!([{ "kind": "picked", "labels": ["Alpha"] }]))
        .await
        .expect("the held question is answered");
    let unwaited = fixture
        .ask("request-3", json!([choice_page()]), false)
        .await;
    let [withdrawn_item, unrelated_item, first_item, second_item] =
        [(); 4].map(|()| mint_uuid_v7().to_string());
    let send = |queue_item_id: String| {
        json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "runId": fixture.run_id,
            "actor": "device-1",
            "deviceId": "device-1",
            "message": "Which one?\nAlpha",
            "answersQuestionId": unwaited,
        })
    };
    let queue_event = |state: &str, queue_item_id: String| {
        let mut payload = json!({
            "sessionId": fixture.session_id,
            "queueItemId": queue_item_id,
            "state": state,
        });
        if state == "admitted" {
            payload["runId"] = json!(fixture.run_id);
        }
        payload
    };

    fixture
        .append("user.message.sent", send(withdrawn_item.clone()))
        .await;
    let after_send = fixture.state(unwaited);
    fixture
        .append(
            "agent.queueItem.canceled",
            queue_event("canceled", withdrawn_item),
        )
        .await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", unrelated_item),
        )
        .await;
    let after_withdrawal = fixture.state(unwaited);
    fixture
        .append("user.message.sent", send(first_item.clone()))
        .await;
    fixture.append("user.message.sent", send(second_item)).await;
    fixture
        .append(
            "agent.queueItem.admitted",
            queue_event("admitted", first_item),
        )
        .await;

    assert_eq!(after_send, "open");
    assert_eq!(after_withdrawal, "open");
    assert_eq!(fixture.state(unwaited), "answered");
    assert_eq!(fixture.state(withdrawn), "canceled");
    let reader = fixture.database.reader();
    let live = question_rows(&reader);
    assert!(
        live.1.is_empty(),
        "the first taken answer unpairs the other"
    );

    let pool = Arc::new(DatabaseReadPool::new(
        fixture.database.path(),
        PROJECTION_REBUILD_STATEMENT_CAPACITY + SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let reads_whole: Arc<DamagedFromSequenceReader> =
        Arc::new(|_session_id: &SessionId| -> Option<i64> { None });
    ProjectionRebuildService::new(
        Arc::clone(&pool),
        Arc::clone(&fixture.writer),
        Arc::new(SessionService::new(pool, reads_whole)),
        Arc::new(DatabaseDamageWatch::new()),
        vec![Box::new(QuestionsProjection)],
    )
    .rebuild(ProjectionRebuildRequest {
        session_id: fixture.session_id,
        is_forced: true,
        before_sequence: None,
        stop: None,
    })
    .await
    .expect("the session's questions are rebuilt");

    assert_eq!(question_rows(&reader), live);
}

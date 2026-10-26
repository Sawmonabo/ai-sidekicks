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
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::list::BoundedVec;
use tempfile::TempDir;

use super::{HeldRequestAnswerer, QUESTION_STATEMENT_CAPACITY, QuestionError, QuestionsService};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::content::codec::{StoredBodyColumns, stored_body_columns_sql};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage, UnsequencedEventEnvelope,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::read::DamagedFromSequenceReader;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::provider::driver::contract::{MockProviderDriver, ProviderRequestAnswer};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, ToolServerQuestionAnswer,
};
use crate::questions::projection::{QuestionsProjection, question_projection_statements};
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::projection_rebuild::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildRequest, ProjectionRebuildService,
};
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::read::{LiveRun, RunRead};
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};
use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The secret the tests answer with, which no stored row may hold.
const SECRET: &str = "the-secret-value-41";

/// Each answer the stand-in driver was handed: its request id and its answers.
type HandedAnswers = Arc<Mutex<Vec<(String, Vec<QuestionAnswer>)>>>;

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
        Self::with_driver(false).await
    }

    /// The fixture whose stand-in driver, when `is_run_ended_on_answer`, fails the run as it takes
    /// an answer, as a provider that exits at that moment does.
    async fn with_driver(is_run_ended_on_answer: bool) -> Self {
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
            projection_statements: Some(Box::new(|envelope: &UnsequencedEventEnvelope| {
                Ok(question_projection_statements(envelope))
            })),
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        bind_run_to_first_provider(&database, run_id);
        let engine = test_engine(&database, Arc::clone(&event_log), home.path());
        let handed = HandedAnswers::default();
        let recorded = Arc::clone(&handed);
        let ending_engine = is_run_ended_on_answer.then(|| Arc::clone(&engine));
        let mut driver = MockProviderDriver::new();
        driver.expect_respond_to_request().returning(move |params| {
            let ProviderRequestAnswer::Question { answers } = params.response else {
                panic!("the questions service answers only questions");
            };
            recorded
                .lock()
                .expect("the test's record is never poisoned")
                .push((params.request_id, answers));
            let ending_engine = ending_engine.clone();
            async move {
                if let Some(engine) = ending_engine {
                    engine
                        .transition(
                            RunStateChange::new(run_id, failed()),
                            RunStateChangeCompanions::default(),
                        )
                        .await
                        .expect("the run ends");
                }
                Ok(())
            }
            .boxed()
        });
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

    /// Asks `pages` under `request_id`, held by the run when `is_agent_waiting`, its answer sent
    /// on through the driver.
    async fn ask(&self, request_id: &str, pages: Value, is_agent_waiting: bool) -> QuestionId {
        self.ask_answered_by(
            request_id,
            pages,
            is_agent_waiting,
            HeldRequestAnswerer::Driver,
        )
        .await
    }

    /// Asks as [`Self::ask`] does, its answer sent on by `answered_by`.
    async fn ask_answered_by(
        &self,
        request_id: &str,
        pages: Value,
        is_agent_waiting: bool,
        answered_by: HeldRequestAnswerer,
    ) -> QuestionId {
        self.questions
            .take_question(
                ProviderQuestion {
                    session_id: self.session_id,
                    run_id: self.run_id,
                    request_id: request_id.to_owned(),
                    questions: serde_json::from_value::<Vec<QuestionPrompt>>(pages)
                        .expect("the test's pages read"),
                    is_agent_waiting,
                },
                answered_by,
            )
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

/// `choice_page` as a tool server's form field, which must be answered.
fn form_field_page() -> Value {
    let mut page = choice_page();
    page["required"] = json!(true);
    page
}

fn secret_page() -> Value {
    json!({ "text": "The token?", "options": [], "severalAnswers": false, "secret": true })
}

/// A run's failed end, as any end but an interrupt.
fn failed() -> RunStateEntry {
    RunStateEntry::Failed {
        intended_close: None,
        failure_cause: None,
        provider_failure_detail: None,
        process_exit: None,
    }
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

// The answers are checked against the record before anything goes out: a short list is refused
// `question.answersIncomplete`, an answer its question cannot take `question.answerInvalid` with
// its page and reason, an id no record holds `question.notFound`, and a question its agent does
// not wait for `question.notWaiting`; none of them reaches the driver. Killed by removing the
// count check, any one reason's check, or the waiting check.
#[rstest]
#[case::one_answer_short(
    json!([{ "kind": "skipped" }]),
    RefusalCode::QuestionAnswersIncomplete,
    None
)]
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
#[case::text_on_a_form_fields_choice(
    json!([{ "kind": "typed", "text": "Gamma" }, { "kind": "skipped" }]),
    RefusalCode::QuestionAnswerInvalid,
    Some((0, "textOnChoice"))
)]
#[tokio::test]
async fn an_answer_its_record_cannot_take_is_refused_with_nothing_sent(
    #[case] answers: Value,
    #[case] code: RefusalCode,
    #[case] invalid: Option<(usize, &str)>,
) {
    let fixture = Fixture::new().await;
    let question_id = fixture
        .ask("request-1", json!([form_field_page(), secret_page()]), true)
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
    /// A restart finds its run waiting and ends it.
    Restart,
}

// A held question that ends unanswered is canceled once, in the write that moves or ends its run,
// with the reason the run's own state gives: a withdrawal `withdrawn` and the run back to
// `running`, unless an interrupt of the run is recorded, which makes it `interrupted`; an
// interrupted end `interrupted`; any other end, a restart's among them, `runEnded`. Killed by a
// cancellation in a second write, by a reason read from the report rather than the run, and by a
// run left waiting.
#[rstest]
#[case::withdrawn(QuestionEnd::Withdrawn, "withdrawn", "running")]
#[case::withdrawn_under_an_interrupt(
    QuestionEnd::WithdrawnUnderInterrupt,
    "interrupted",
    "running"
)]
#[case::run_interrupted(QuestionEnd::RunInterrupted, "interrupted", "interrupted")]
#[case::run_failed(QuestionEnd::RunFailed, "runEnded", "failed")]
#[case::restart(QuestionEnd::Restart, "runEnded", "failed")]
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
                failed()
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
        QuestionEnd::Restart => {
            let (_, version) = stored_run_state(&fixture.database, &fixture.run_id);
            fixture
                .engine
                .settle_run_after_restart(
                    &LiveRun {
                        run_id: fixture.run_id,
                        run: RunRead {
                            version,
                            session_id: fixture.session_id,
                            state: RunState::WaitingForInput,
                        },
                        parent_run_id: None,
                        reached_by: None,
                    },
                    "not resumed",
                    None,
                )
                .await
                .expect("the restart ends the run");
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

// A run that ends while its driver takes a held question's answer settles the question `canceled`
// in its end's write; the answer reads that state back and lets the request go, with no turn
// written. Killed by reading the state back only on the settle's refusal, and by keeping the
// request held.
#[tokio::test]
async fn an_answer_whose_run_ends_meanwhile_reads_canceled_and_lets_the_request_go() {
    let fixture = Fixture::with_driver(true).await;
    let question_id = fixture.ask("request-1", json!([choice_page()]), true).await;

    let state = fixture
        .answer(
            question_id,
            json!([{ "kind": "picked", "labels": ["Alpha"] }]),
        )
        .await;

    assert_eq!(
        state.expect("the answer reads the run's end"),
        QuestionSettledState::Canceled
    );
    assert_eq!(fixture.handed_count(), 1);
    assert!(fixture.questions.held_request(&question_id).is_none());
    assert_eq!(fixture.state(question_id), "canceled");
    assert_eq!(
        fixture.payloads("question.canceled")[0]["reason"],
        "runEnded"
    );
    assert_eq!(fixture.payloads("user.message.sent"), Vec::<Value>::new());
    assert_eq!(fixture.run_state(), "failed");
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
    .rebuild(
        ProjectionRebuildRequest {
            session_id: fixture.session_id,
            is_forced: true,
            before_sequence: None,
            stop: None,
        },
        None,
    )
    .await
    .expect("the session's questions are rebuilt");

    assert_eq!(question_rows(&reader), live);
}

//! The question record over a test database holding one running run bound to the table's first
//! provider, whose driver is a stand-in that records each answer it is handed: a held question's
//! answer and the refusals that send nothing, each way a question ends unanswered, a question's
//! turn while its run waits on another, and the queued answers of a question its agent does not
//! wait for.

mod answers;
mod endings;
pub(crate) mod queued_answers;
mod run_turn;

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
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

use super::{HeldRequestAnswerer, QUESTION_STATEMENT_CAPACITY, QuestionError, QuestionsService};
use crate::questions::projection::question_projection_statements;
use crate::questions::schema::schema_parts;
use crate::run::engine::RunEngine;
use crate::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderRequestAnswer};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::port::question::{ProviderQuestion, ToolServerQuestionAnswer};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage, UnsequencedEventEnvelope,
};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

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
pub(crate) struct Fixture {
    /// The test database the run, the log and the question rows are in.
    pub(crate) database: TestDatabase,
    /// The writer every write of the fixture goes through.
    pub(crate) writer: Arc<DatabaseWriter>,
    appender: SessionEventAppender,
    engine: Arc<RunEngine>,
    questions: QuestionsService,
    /// The session the run and its questions belong to.
    pub(crate) session_id: SessionId,
    run_id: RunId,
    handed: HandedAnswers,
    _home: TempDir,
}

impl Fixture {
    /// The fixture whose stand-in driver takes every answer and leaves the run running.
    pub(crate) async fn new() -> Self {
        Self::with_driver(false).await
    }

    /// The fixture whose stand-in driver, when `is_run_ended_on_answer`, fails the run as it takes
    /// an answer, as a provider that exits at that moment does.
    async fn with_driver(is_run_ended_on_answer: bool) -> Self {
        let database = TestDatabase::new(schema_parts());
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
                self.question(request_id, pages, is_agent_waiting),
                answered_by,
            )
            .await
            .expect("the question is recorded")
    }

    /// The run's question asking `pages` under `request_id`, held by the run when
    /// `is_agent_waiting`.
    fn question(&self, request_id: &str, pages: Value, is_agent_waiting: bool) -> ProviderQuestion {
        ProviderQuestion {
            session_id: self.session_id,
            run_id: self.run_id,
            request_id: request_id.to_owned(),
            questions: serde_json::from_value::<Vec<QuestionPrompt>>(pages)
                .expect("the test's pages read"),
            is_agent_waiting,
        }
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

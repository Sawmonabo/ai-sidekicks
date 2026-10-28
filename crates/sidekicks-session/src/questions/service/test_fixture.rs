//! The question record over a test database holding one running run bound to the table's first
//! provider, whose driver is a stand-in that records each answer it is handed, and the queued
//! answers of a question its agent does not wait for, written through it.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAskedState, QuestionId, QuestionPrompt, QuestionResolveRequest,
    QuestionSettledState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderRequestAnswer};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, WaitingQuestionOpening,
};
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
use tempfile::TempDir;

use super::{HeldRequestAnswerer, QUESTION_STATEMENT_CAPACITY, QuestionError, QuestionsService};
use crate::questions::projection::question_projection_statements;
use crate::questions::schema::schema_parts;
#[cfg(test)]
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{insert_running_run, test_engine};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

/// Each answer the stand-in driver was handed: its request id and its answers.
pub(super) type HandedAnswers = Arc<Mutex<Vec<(String, Vec<QuestionAnswer>)>>>;

/// A running run bound to a stand-in driver, its engine, the log with the queued answers'
/// statements, and the questions service.
pub struct Fixture {
    /// The test database the run, the log and the question rows are in.
    pub database: TestDatabase,
    /// The writer every write of the fixture goes through.
    pub writer: Arc<DatabaseWriter>,
    appender: SessionEventAppender,
    /// The run engine the questions service settles runs through.
    #[cfg(test)]
    pub(super) engine: Arc<RunEngine>,
    /// The questions service under test.
    pub(super) questions: QuestionsService,
    /// The session the run and its questions belong to.
    pub session_id: SessionId,
    /// The running run the questions are asked in.
    pub(super) run_id: RunId,
    /// Each answer the stand-in driver was handed.
    #[cfg(test)]
    pub(super) handed: HandedAnswers,
    _home: TempDir,
}

impl Fixture {
    /// The fixture whose stand-in driver takes every answer and leaves the run running.
    pub async fn new() -> Self {
        Self::with_driver(false).await
    }

    /// The fixture whose stand-in driver, when `is_run_ended_on_answer`, fails the run as it takes
    /// an answer, as a provider that exits at that moment does.
    #[expect(clippy::panic, reason = "a test helper fails the test that called it")]
    pub(super) async fn with_driver(is_run_ended_on_answer: bool) -> Self {
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
            #[cfg(test)]
            engine,
            questions,
            session_id,
            run_id,
            #[cfg(test)]
            handed,
            _home: home,
        }
    }

    /// Asks `pages` under `request_id`, held by the run when `is_agent_waiting`, its answer sent
    /// on through the driver.
    pub(super) async fn ask(
        &self,
        request_id: &str,
        pages: Value,
        is_agent_waiting: bool,
    ) -> QuestionId {
        self.ask_answered_by(
            request_id,
            pages,
            is_agent_waiting,
            HeldRequestAnswerer::Driver,
        )
        .await
    }

    /// Asks as [`Self::ask`] does, its answer sent on by `answered_by`.
    pub(super) async fn ask_answered_by(
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
    pub(super) fn question(
        &self,
        request_id: &str,
        pages: Value,
        is_agent_waiting: bool,
    ) -> ProviderQuestion {
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
    pub(super) async fn answer(
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

    /// The state `question_id`'s row holds.
    pub(super) fn state(&self, question_id: QuestionId) -> String {
        self.database
            .reader()
            .query_row(
                "SELECT state FROM questions WHERE id = ?1",
                [question_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the question's row reads")
    }
}

/// A question page offering two choices, of which one is picked.
pub(super) fn choice_page() -> Value {
    json!({
        "text": "Which one?",
        "options": [{ "label": "Alpha" }, { "label": "Beta" }],
        "severalAnswers": false,
        "secret": false,
    })
}

/// A run's failed end, as any end but an interrupt.
pub(super) fn failed() -> RunStateEntry {
    RunStateEntry::Failed {
        intended_close: None,
        failure_cause: None,
        provider_failure_detail: None,
        process_exit: None,
    }
}

/// The questions [`write_queued_answers`] settled, and the unwaited question's state after its
/// first queued answer was sent and after that send was withdrawn.
pub struct QueuedAnswers {
    /// The question no run waits on, which the queued answers answer.
    pub unwaited: QuestionId,
    /// The question whose queued answer was withdrawn.
    pub withdrawn: QuestionId,
    /// The question recorded waiting for its run and then withdrawn by its provider.
    pub withdrawn_waiting: QuestionId,
    /// The question recorded waiting for its run and then answered.
    pub opened: QuestionId,
    /// The unwaited question's state after its first queued answer was sent.
    pub after_send: String,
    /// The unwaited question's state after that send was withdrawn.
    pub after_withdrawal: String,
}

/// Writes, through `fixture`'s service and log, a held question answered, one withdrawn, one
/// withdrawn while it waited for its run, one opened from that wait and answered, and a question
/// its agent does not wait for, answered by the first of two queued answers its agent takes.
pub async fn write_queued_answers(fixture: &Fixture) -> QueuedAnswers {
    let record_waiting = |request_id: &'static str| {
        fixture.questions.record_question(
            fixture.question(request_id, json!([choice_page()]), true),
            HeldRequestAnswerer::Driver,
            QuestionAskedState::WaitingForRun,
        )
    };
    let withdrawn_waiting = record_waiting("request-4")
        .await
        .expect("the question is recorded waiting for its run");
    fixture
        .questions
        .withdraw_question(ProviderQuestionWithdrawal {
            session_id: fixture.session_id,
            request_id: "request-4".to_owned(),
        })
        .await
        .expect("the withdrawal is taken");
    let opened = record_waiting("request-5")
        .await
        .expect("the question is recorded waiting for its run");
    assert_eq!(
        fixture
            .questions
            .open_waiting_question(fixture.session_id, "request-5")
            .await
            .expect("the run reads running"),
        WaitingQuestionOpening::Opened
    );
    fixture
        .answer(opened, json!([{ "kind": "picked", "labels": ["Beta"] }]))
        .await
        .expect("the opened question is answered");
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

    QueuedAnswers {
        unwaited,
        withdrawn,
        withdrawn_waiting,
        opened,
        after_send,
        after_withdrawal,
    }
}

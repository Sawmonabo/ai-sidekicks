//! Answers to a provider's choice over a test database holding one run waiting on a choice, bound
//! to the table's first provider, whose driver is a stand-in: an answer the provider got with no
//! reply back, settled by the provider's word and held again when its settle fails, the order an
//! answer is refused in, and the one settlement of each choice a run's end lets go or an answer
//! ends the run with.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceResolveRequest, AgentRunUsageCreditsChoiceRequestedPayload,
    AgentRunUsageCreditsChoiceResolveRequest, RunRefusalChoice, RunUsageCreditsChoice,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::driver::run_control::AnswerProviderChoiceResult;
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::run::delivery::{DeliveryBinding, InboundDelivery};
use sidekicks_provider::run::state_entry::{RunStateEntry, RunStateReport};
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_std::pause_point::ArmedPause;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;

use super::{
    PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceAnswerOrigin, ProviderChoiceError,
    ProviderChoiceResolver,
};
use crate::driver_resolution::LiveRunDriverError;
use crate::questions::schema::schema_parts;
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{append, insert_running_run, stored_run_state, test_engine};
use crate::run::epochs::{EpochBinding, ExecutionEpochs};
use crate::run::inbound::RunInboundDispatch;
use crate::run::inbound::tests::UnreadRunStates;
use crate::run::refusals::RunRefusal;
use crate::run::state_change::RunStateChange;

/// A run waiting on its switch-or-credits choice, the engine that moves it and the resolver.
struct Fixture {
    database: TestDatabase,
    engine: Arc<RunEngine>,
    resolver: Arc<ProviderChoiceResolver>,
    session_id: SessionId,
    run_id: RunId,
    log: TestLog,
    _home: TempDir,
}

impl Fixture {
    /// Answers the run's choice with `choice` from a device.
    async fn answer(&self, choice: RunUsageCreditsChoice) -> Result<RunState, ProviderChoiceError> {
        self.answer_run(self.run_id, choice).await
    }

    /// Answers the choice of `run_id` with `choice` from a device.
    async fn answer_run(
        &self,
        run_id: RunId,
        choice: RunUsageCreditsChoice,
    ) -> Result<RunState, ProviderChoiceError> {
        self.resolver
            .resolve_usage_credits_choice(
                &AgentRunUsageCreditsChoiceResolveRequest { run_id, choice },
                ProviderChoiceAnswerOrigin {
                    device_id: DeviceId::new("device".to_owned()).expect("a device id"),
                },
            )
            .await
            .map(|answered| answered.new_state)
    }

    /// Appends the provider's ask of the retry-or-edit choice on the run.
    async fn ask_refusal_choice(&self) {
        let requested: SessionEvent = serde_json::from_value(json!({
            "type": "agent.run.refusalChoice.requested",
            "payload": {
                "sessionId": self.session_id,
                "runId": self.run_id,
                "refusedModel": "a model",
                "fallbackModel": "another model",
            },
        }))
        .expect("the test writes a refusal choice's request");
        append(&self.engine, self.session_id, &requested).await;
    }

    /// The `choice` of each settlement of the retry-or-edit choice in the log, oldest first.
    fn refusal_settlements(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT json_extract(payload, '$.choice') FROM session_events
                  WHERE session_id = ?1 AND type = ?2 ORDER BY sequence",
            )
            .expect("the test reads the log")
            .query_map(
                params![
                    self.session_id.text().as_str(),
                    SessionEventType::AgentRunRefusalChoiceResolved.as_str()
                ],
                |row| row.get(0),
            )
            .expect("the log reads")
            .collect::<Result<_, _>>()
            .expect("each settlement reads")
    }

    /// The run's state as stored.
    fn state(&self) -> String {
        stored_run_state(&self.database, &self.run_id).0
    }

    /// How many settlements of the choice the log holds.
    fn settlements(&self) -> i64 {
        self.database
            .reader()
            .query_row(
                "SELECT count(*) FROM session_events WHERE session_id = ?1 AND type = ?2",
                params![
                    self.session_id.text().as_str(),
                    SessionEventType::AgentRunUsageCreditsChoiceResolved.as_str()
                ],
                |row| row.get(0),
            )
            .expect("the test counts the settlements")
    }
}

/// How the fixture's run stands before an answer.
#[derive(Clone, Copy, Debug)]
struct ChoiceRun {
    /// Whether the run is bound to the table's first provider.
    is_bound: bool,
    /// Whether the run waits on input, rather than running.
    is_waiting: bool,
    /// Whether the provider asked the choice in the log.
    is_asked: bool,
}

/// A bound run waiting on the choice the provider asked.
const WAITING_ON_THE_CHOICE: ChoiceRun = ChoiceRun {
    is_bound: true,
    is_waiting: true,
    is_asked: true,
};

async fn fixture(driver: MockProviderDriver, setup: ChoiceRun) -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id: SessionId = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    if setup.is_bound {
        bind_run_to_first_provider(&database, run_id);
    }
    if setup.is_waiting {
        database
            .reader()
            .execute(
                "UPDATE runs SET state = 'waitingForInput' WHERE run_id = ?1",
                [run_id.text().as_str()],
            )
            .expect("the test holds the run on its choice");
    }
    let requested = SessionEvent::AgentRunUsageCreditsChoiceRequested(
        AgentRunUsageCreditsChoiceRequestedPayload {
            session_id,
            run_id,
            model_name: FreeFormText::new("a model".to_owned()).expect("a model name"),
            overages_enabled: false,
            balance_cents: None,
            currency: None,
            fallback_model: None,
        },
    );
    if setup.is_asked {
        SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone())
            .append(
                SessionEventDraft::of_session(session_id, &requested)
                    .expect("the choice's request drafts"),
                SessionEventLinkage::default(),
            )
            .await
            .expect("the provider asks the choice");
    }
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let resolver = Arc::new(ProviderChoiceResolver::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            PROVIDER_CHOICE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&engine),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
    ));
    Fixture {
        database,
        engine,
        resolver,
        session_id,
        run_id,
        log,
        _home: home,
    }
}

/// What shows the provider took the answer that got no reply back.
#[derive(Clone, Copy, Debug)]
enum ProviderWord {
    /// Its report of the run running again.
    Report,
    /// Its answer to the person's second, same answer: no such choice is pending.
    SecondAnswer,
}

// An answer the provider got with no reply back writes nothing and leaves the run waiting, and is
// settled, its device recorded once, when the provider shows it took it: its report of the run
// running, written before the report, which then meets a run already running, or its `NotPending`
// to the same answer sent again, which answers as the first. Killed by settling on no reply, or
// by refusing a second answer the provider already took.
#[rstest]
#[case::by_the_report(ProviderWord::Report)]
#[case::by_a_second_answer(ProviderWord::SecondAnswer)]
#[tokio::test]
async fn an_unanswered_choice_settles_on_the_providers_word(#[case] word: ProviderWord) {
    let calls = AtomicUsize::new(0);
    let mut driver = MockProviderDriver::new();
    driver.expect_answer_provider_choice().returning(move |_| {
        let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
        async move {
            if is_first {
                Err(unanswered())
            } else {
                Ok(AnswerProviderChoiceResult::NotPending {})
            }
        }
        .boxed()
    });
    let fixture = fixture(driver, WAITING_ON_THE_CHOICE).await;

    let first = fixture.answer(RunUsageCreditsChoice::Consent).await;
    let after_first = (fixture.state(), fixture.settlements());
    let settled = match word {
        ProviderWord::Report => {
            let wrote = fixture
                .resolver
                .settle_held_answer(fixture.run_id, RunState::Running)
                .await
                .expect("the held answer settles");
            let report = fixture
                .engine
                .apply_provider_state_change(
                    RunStateChange::new(
                        fixture.run_id,
                        RunStateEntry::Running {
                            execution_posture: None,
                        },
                    ),
                    None,
                )
                .await;
            assert!(report.is_err(), "the report meets a run already running");
            wrote
        }
        ProviderWord::SecondAnswer => {
            let second = fixture.answer(RunUsageCreditsChoice::Consent).await;
            matches!(second, Ok(RunState::Running))
        }
    };

    assert!(
        matches!(
            first,
            Err(ProviderChoiceError::Driver(DriverError::Unanswered(_)))
        ),
        "{first:?}"
    );
    assert_eq!(after_first, ("waitingForInput".to_owned(), 0));
    assert!(settled);
    assert_eq!(
        (fixture.state(), fixture.settlements()),
        ("running".to_owned(), 1)
    );
}

// A report that shows the provider took a held answer settles it first: a settle that fails once is
// retried in the same dispatch, and one that fails twice leaves the answer held while the report
// still applies, so the run never reads waiting for input while its provider runs. Killed by no
// retry (a single failure leaves the answer unsettled), by applying the report before the settle,
// and by a failed settle that fails the dispatch instead of applying the report.
#[rstest]
#[case::settled_on_its_retry(true, 1)]
#[case::kept_after_two_failures(false, 0)]
#[tokio::test]
async fn a_report_settles_the_held_answer_first_and_a_failed_settle_is_retried_once(
    #[case] is_let_through_before_the_retry: bool,
    #[case] settlements: i64,
) {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_answer_provider_choice()
        .returning(|_| async { Err(unanswered()) }.boxed());
    let fixture = fixture(driver, WAITING_ON_THE_CHOICE).await;
    let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
        NonZeroUsize::new(2).expect("the cap is not zero"),
    )));
    let binding_id =
        RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
    epochs
        .lock()
        .expect("no test thread panics holding the cursors")
        .open_binding(
            EpochBinding {
                id: binding_id.clone(),
                run_id: fixture.run_id,
                provider_name: test_provider(),
                provider_account_id: test_provider_account_id(),
            },
            RUN_START_POSITION,
        )
        .expect("the binding has no cursor yet");
    let dispatch = RunInboundDispatch::new(
        Arc::clone(&fixture.engine),
        epochs,
        Arc::new(UnreadRunStates),
        Arc::clone(&fixture.log.service),
        Arc::clone(&fixture.resolver),
    );
    let unanswered = fixture.answer(RunUsageCreditsChoice::Consent).await;
    assert!(unanswered.is_err(), "{unanswered:?}");
    let reader = fixture.database.reader();
    reader
        .execute_batch(
            "CREATE TRIGGER refuse_settlements BEFORE INSERT ON session_events
               WHEN NEW.type = 'agent.run.usageCreditsChoice.resolved'
             BEGIN SELECT RAISE(ABORT, 'the test refuses the settlement'); END;",
        )
        .expect("the test refuses the settlement's write");
    let ArmedPause { reached, release } = dispatch.settle_retry_pause.arm();
    let let_through = async {
        reached.await.expect("the first settle fails");
        if is_let_through_before_the_retry {
            reader
                .execute_batch("DROP TRIGGER refuse_settlements")
                .expect("the test lets the settlement through");
        }
        release.send(()).expect("the retry waits");
    };

    let (delivered, ()) = tokio::join!(
        dispatch.dispatch(InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id: binding_id.clone(),
                operation: None,
            },
            change: RunStateReport::new(
                fixture.run_id,
                RunStateEntry::Running {
                    execution_posture: None,
                },
            ),
            turn_end: None,
            is_daemon_interrupt_end: false,
        }),
        let_through
    );

    assert!(delivered.is_ok(), "{delivered:?}");
    assert_eq!(
        (fixture.state(), fixture.settlements()),
        ("running".to_owned(), settlements)
    );
}

/// Why an answer is refused before its driver.
#[derive(Clone, Copy, Debug)]
enum Refusal {
    /// The run is unknown.
    UnknownRun,
    /// The run does not wait on input.
    NotWaiting,
    /// The run waits on input, but the provider asked no such choice.
    NeverAsked,
    /// The run waits on the choice, but no binding names its provider.
    Unbound,
}

// An answer is refused by the run, then the choice it waits on, then its driver, and none reaches
// the driver, whose stand-in fails any call. Every refused run is unbound, so a driver looked up
// before the run or its choice answers the wrong refusal. Killed by resolving the driver before
// the run's read or the choice's, or by sending to the driver before the choice is read.
#[rstest]
#[case::unknown_run(Refusal::UnknownRun)]
#[case::not_waiting(Refusal::NotWaiting)]
#[case::never_asked(Refusal::NeverAsked)]
#[case::unbound(Refusal::Unbound)]
#[tokio::test]
async fn an_answer_is_refused_by_the_run_then_its_choice_then_its_driver(#[case] refusal: Refusal) {
    let setup = ChoiceRun {
        is_bound: false,
        is_waiting: !matches!(refusal, Refusal::NotWaiting),
        is_asked: !matches!(refusal, Refusal::NeverAsked),
    };
    let fixture = fixture(MockProviderDriver::new(), setup).await;
    let run_id = match refusal {
        Refusal::UnknownRun => RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        Refusal::NotWaiting | Refusal::NeverAsked | Refusal::Unbound => fixture.run_id,
    };

    let answered = fixture
        .answer_run(run_id, RunUsageCreditsChoice::Consent)
        .await;

    match (refusal, &answered) {
        (Refusal::UnknownRun, Err(ProviderChoiceError::Refused(RunRefusal::NotFound { .. })))
        | (
            Refusal::NotWaiting | Refusal::NeverAsked,
            Err(ProviderChoiceError::Refused(RunRefusal::InvalidTransition { .. })),
        )
        | (
            Refusal::Unbound,
            Err(ProviderChoiceError::NoDriver(LiveRunDriverError::Unbound { .. })),
        ) => {}
        _ => panic!("expected {refusal:?}, got {answered:?}"),
    }
    assert_eq!(fixture.settlements(), 0);
}

// A run whose provider process exits with both its choices open settles each `runEnded` in the
// write that ends it, just before its end. Killed by leaving the choices out of the run end's
// settle (`questions/run_end.rs`, the loop over `choices` deleted), which leaves both open.
#[tokio::test]
async fn a_process_exit_settles_each_open_choice_in_the_runs_end() {
    let fixture = fixture(MockProviderDriver::new(), WAITING_ON_THE_CHOICE).await;
    fixture.ask_refusal_choice().await;

    fixture
        .engine
        .end_turn_on_process_exit(
            fixture.run_id,
            serde_json::from_value(json!({ "exitCode": 1, "outputTail": "the provider stopped" }))
                .expect("the test's exit reads as one"),
        )
        .await
        .expect("the run ends on its process's exit");

    let newest: Vec<(String, Option<String>)> = fixture
        .database
        .reader()
        .prepare(
            "SELECT type, json_extract(payload, '$.choice') FROM session_events
              WHERE session_id = ?1 ORDER BY sequence DESC LIMIT 3",
        )
        .expect("the test reads the log")
        .query_map([fixture.session_id.text().as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("the log reads")
        .collect::<Result<_, _>>()
        .expect("each event reads");
    assert_eq!(
        newest,
        [
            ("agent.run.failed".to_owned(), None),
            (
                "agent.run.usageCreditsChoice.resolved".to_owned(),
                Some("runEnded".to_owned())
            ),
            (
                "agent.run.refusalChoice.resolved".to_owned(),
                Some("runEnded".to_owned())
            ),
        ]
    );
    assert_eq!(fixture.state(), "failed");
}

// `editPrompt` on a waiting retry-or-edit choice ends the run `failed`, and the person's answer is
// the one settlement of the choice: the run's end, in the same write, leaves the choice its
// companions settle. Killed by dropping that skip (`provider_choice.rs`, the `settled.contains`
// check in `read_open_choice_settlements`), which adds `runEnded` beside `editPrompt`.
#[tokio::test]
async fn an_edit_prompt_answer_is_its_choices_one_settlement() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_answer_provider_choice()
        .returning(|_| async { Ok(AnswerProviderChoiceResult::Answered {}) }.boxed());
    let fixture = fixture(
        driver,
        ChoiceRun {
            is_asked: false,
            ..WAITING_ON_THE_CHOICE
        },
    )
    .await;
    fixture.ask_refusal_choice().await;

    let answered = fixture
        .resolver
        .resolve_refusal_choice(
            &AgentRunRefusalChoiceResolveRequest {
                run_id: fixture.run_id,
                choice: RunRefusalChoice::EditPrompt,
            },
            ProviderChoiceAnswerOrigin {
                device_id: DeviceId::new("device".to_owned()).expect("a device id"),
            },
        )
        .await
        .expect("the answer settles the choice");

    assert_eq!(answered.new_state, RunState::Failed);
    assert_eq!(fixture.refusal_settlements(), ["editPrompt"]);
    assert_eq!(fixture.state(), "failed");
}

//! Answers to a provider's choice over a test database holding one run waiting on its
//! switch-or-credits choice, bound to the table's first provider, whose driver is a stand-in: an
//! answer the provider got with no reply back, settled by the provider's word.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolveRequest,
    RunUsageCreditsChoice,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;

use super::{
    PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceAnswerOrigin, ProviderChoiceError,
    ProviderChoiceResolver,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::run_control::AnswerProviderChoiceResult;
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::pause::tests::unanswered;
use crate::session::run::state_change::{RunStateChange, RunStateEntry};
use crate::uuid_v7::mint_uuid_v7;

/// A run waiting on its switch-or-credits choice, the engine that moves it and the resolver.
struct Fixture {
    database: TestDatabase,
    engine: Arc<RunEngine>,
    resolver: ProviderChoiceResolver,
    session_id: SessionId,
    run_id: RunId,
    _log: TestLog,
    _home: TempDir,
}

impl Fixture {
    /// Answers the run's choice with `choice` from a device.
    async fn answer(&self, choice: RunUsageCreditsChoice) -> Result<RunState, ProviderChoiceError> {
        self.resolver
            .resolve_usage_credits_choice(
                &AgentRunUsageCreditsChoiceResolveRequest {
                    run_id: self.run_id,
                    choice,
                },
                ProviderChoiceAnswerOrigin {
                    device_id: DeviceId::new("device".to_owned()).expect("a device id"),
                },
            )
            .await
            .map(|answered| answered.new_state)
    }

    /// The run's state as stored.
    fn state(&self) -> String {
        stored_run_state(&self.database, &self.run_id).0
    }

    /// How many settlements of the choice the log holds.
    fn settlements(&self) -> usize {
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

async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id: SessionId = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    bind_run_to_first_provider(&database, run_id);
    database
        .reader()
        .execute(
            "UPDATE runs SET state = 'waitingForInput' WHERE run_id = ?1",
            [run_id.text().as_str()],
        )
        .expect("the test holds the run on its choice");
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
    SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone())
        .append(
            SessionEventDraft::of_session(session_id, &requested)
                .expect("the choice's request drafts"),
            SessionEventLinkage::default(),
        )
        .await
        .expect("the provider asks the choice");
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let resolver = ProviderChoiceResolver::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            PROVIDER_CHOICE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&engine),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
    );
    Fixture {
        database,
        engine,
        resolver,
        session_id,
        run_id,
        _log: log,
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
    let fixture = fixture(driver).await;

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

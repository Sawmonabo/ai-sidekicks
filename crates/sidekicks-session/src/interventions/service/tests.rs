//! A person's interventions through the service, over a test database with a stand-in driver and
//! the engine queue of the service's test fixture; the limit's tests share it. A reused key's
//! answers and the hand of a person's interrupt pending at a restart are in the modules below.

mod restart_hand;
mod reused_keys;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::events::{InterventionActor, InterventionDeviceActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::{
    ApplyInterventionResponse, FasterModelRetryOutcome, InterruptPendingChoice,
    InterventionResultStatus,
};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::log_service::test_fixture::open_log;
use tempfile::TempDir;

use super::{
    INTERVENTION_SERVICE_STATEMENT_CAPACITY, InterventionService, InterventionServiceDeps,
};
use crate::interventions::interrupt_queue::InterruptQueue;
use crate::interventions::service::test_fixture::EngineQueue;
use crate::questions::schema::schema_parts;
use crate::queue_store::QueueItemBody;
use crate::queue_store::test_items::{test_queue_item, words, write_item};
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{insert_run, stored_run_state, test_engine};
use crate::run::state_change::RunStateChange;

/// A service over a test database holding one running run, at version 1, bound to the table's
/// first provider, whose driver is `driver`.
pub(crate) struct Harness {
    /// The database.
    pub(crate) database: TestDatabase,
    /// The run engine the service and the queue end runs through.
    pub(crate) engine: Arc<RunEngine>,
    /// The service under test.
    pub(crate) service: Arc<InterventionService>,
    /// The event log the service appends to, which a test appending to the same log reuses.
    pub(crate) event_log: Arc<EventLogService>,
    /// The run's session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// How many interrupt holds the run queue has taken.
    pub(crate) holds_taken: Arc<AtomicUsize>,
    /// How many `Send now`s the run queue was asked for.
    sent_now: Arc<AtomicUsize>,
    // The writer the test queues messages through.
    writer: Arc<DatabaseWriter>,
    /// The choice of each hold the run queue let go, in order.
    releases: Arc<Mutex<Vec<InterruptPendingChoice>>>,
    // The engine's posture files.
    _home: TempDir,
}

/// The harness of a service whose driver is `driver`, which takes messages at once.
pub(crate) async fn harness(driver: MockProviderDriver) -> Harness {
    harness_reading_priority(driver, false).await
}

/// The harness of a service whose driver is `driver`, which takes messages at once and reads a
/// priority message when `reads_priority_message` holds, the run queue then sending it now.
async fn harness_reading_priority(
    mut driver: MockProviderDriver,
    reads_priority_message: bool,
) -> Harness {
    driver
        .expect_message_handing()
        .return_const(MessageHanding {
            hands_at: HandMoment::AtOnce,
            can_withdraw: true,
            kept_by_process: false,
            reads_priority_message,
        });
    let database = TestDatabase::new(
        schema_parts()
            .with_parts(crate::agent_tree::schema::schema_parts())
            .with_parts(crate::agents::schema::schema_parts()),
    );
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(&database, session_id, run_id, "running");
    bind_run_to_first_provider(&database, run_id);
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let providers = registry_of_first_provider(Arc::new(driver));
    let queue = EngineQueue::new(
        Arc::clone(&engine),
        reads_priority_message.then(|| Arc::clone(&log.writer)),
    );
    let holds_taken = Arc::clone(&queue.holds_taken);
    let releases = Arc::clone(&queue.releases);
    let sent_now = Arc::clone(&queue.sent_now);
    let queue: Arc<dyn InterruptQueue> = Arc::new(queue);
    let writer = Arc::clone(&log.writer);
    engine
        .set_interrupt_queue(Arc::downgrade(&queue) as Weak<dyn InterruptQueue>)
        .unwrap_or_else(|_| panic!("the engine is handed the queue once"));
    let service = Arc::new(InterventionService::new(InterventionServiceDeps {
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            INTERVENTION_SERVICE_STATEMENT_CAPACITY,
        )),
        event_log: Arc::clone(&log.service),
        engine: Arc::clone(&engine),
        providers: Arc::new(providers),
        queue,
    }));
    Harness {
        database,
        engine,
        service,
        event_log: log.service,
        session_id,
        run_id,
        holds_taken,
        sent_now,
        writer,
        releases,
        _home: home,
    }
}

impl Harness {
    /// Each intervention row of the run, oldest first: its state, payload and device.
    pub(crate) fn stored_rows(&self) -> Vec<(String, String, Option<String>)> {
        self.database
            .reader()
            .prepare(
                "SELECT state, payload, device_id FROM interventions WHERE target_run_id = ?1
                 ORDER BY created_at, id",
            )
            .expect("the test reads the run's interventions")
            .query_map([self.run_id.text().as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("the interventions read")
            .collect::<Result<_, _>>()
            .expect("each intervention reads")
    }

    /// The type of every intervention event of the session, in order.
    pub(crate) fn stored_event_types(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT type FROM session_events
                 WHERE session_id = ?1 AND type LIKE 'agent.intervention.%' ORDER BY sequence",
            )
            .expect("the test reads the session's events")
            .query_map([self.session_id.text().as_str()], |row| row.get(0))
            .expect("the events read")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }

    /// The choice of each hold the run queue let go, in order.
    fn released_choices(&self) -> Vec<InterruptPendingChoice> {
        self.releases
            .lock()
            .expect("the test's releases are readable")
            .clone()
    }

    /// The type of every event of the session from the first intervention's on, in order.
    fn stored_events_from_the_first_intervention(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT type FROM session_events WHERE session_id = ?1 AND sequence >= (
                   SELECT MIN(sequence) FROM session_events
                   WHERE session_id = ?1 AND type LIKE 'agent.intervention.%'
                 ) ORDER BY sequence",
            )
            .expect("the test reads the session's events")
            .query_map([self.session_id.text().as_str()], |row| row.get(0))
            .expect("the events read")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }

    /// Reports the provider moved the run to `entry`, as its event delivery does.
    async fn report(&self, entry: RunStateEntry) {
        let written = self
            .engine
            .apply_provider_state_change(RunStateChange::new(self.run_id, entry), None)
            .await
            .expect("the provider's report is written");
        assert!(
            written.resend_failure.is_none(),
            "{:?}",
            written.resend_failure
        );
    }

    /// Queues a message for the run and answers its id.
    async fn queue_message(&self) -> QueueItemId {
        let mut item = test_queue_item(
            self.session_id,
            self.run_id,
            QueueItemBody::Message(words("Look again")),
        );
        item.client_idempotency_key = Some(key(OTHER_KEY));
        write_item(&self.writer, &item).await
    }

    /// Puts the run in `state` at `version`.
    pub(crate) fn set_run(&self, state: &str, version: i64) {
        self.database
            .reader()
            .execute(
                "UPDATE runs SET state = ?2, run_version = ?3 WHERE run_id = ?1",
                params![self.run_id.text().as_str(), state, version],
            )
            .expect("the test moves the run");
    }
}

fn device() -> InterventionActor {
    InterventionActor::Device(
        InterventionDeviceActor::new(
            DeviceId::new("device-1".to_owned()).expect("a test device id"),
        )
        .expect("a device that is not the daemon"),
    )
}

fn key(text: &str) -> ClientUuid {
    ClientUuid::new(text.to_owned()).expect("a test key is a UUID")
}

const KEY: &str = "0b7f3c1e-9a52-4d6b-8e21-5f4c7d9a1b30";
const OTHER_KEY: &str = "4e2a9d61-7c3b-4f85-9a10-2b6d8e5c7f41";

fn interrupt(run_id: RunId, version: u64, reason: &str) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(version).expect("a test version"),
        client_idempotency_key: key(KEY),
        reason: Some(FreeFormText::new(reason.to_owned()).expect("a test reason")),
        deliver_first: None,
    })
}

fn send_now(run_id: RunId, item_id: QueueItemId) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(1).expect("a test version"),
        client_idempotency_key: key(KEY),
        reason: None,
        deliver_first: Some(item_id),
    })
}

fn return_to_draft(run_id: RunId, key_text: &str) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::ReturnToDraft {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(1).expect("a test version"),
        client_idempotency_key: key(key_text),
        reason: None,
        deliver_first: None,
    })
}

fn retry(run_id: RunId, version: u64) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::FasterModelRetry {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(version).expect("a test version"),
        client_idempotency_key: key(KEY),
        expected_turn_id: ProviderTurnId::new("turn-1".to_owned()).expect("a test turn"),
        model: FreeFormText::new("fast".to_owned()).expect("a test model"),
    }
}

/// An `applied` answer from a driver's interrupt.
pub(crate) fn applied() -> ApplyInterventionResponse {
    ApplyInterventionResponse {
        status: InterventionResultStatus::Applied,
        fallback_action: None,
        delivered_run_id: None,
        canceled: Vec::new(),
    }
}

// The interrupt's two guards and the retry's, each refusing with nothing dispatched: the driver
// has no expectation, so any call fails the test. Killed by dropping or swapping either guard.
#[rstest]
#[case::interrupt_past_its_version(true, "running", 2, "expired")]
#[case::interrupt_of_an_ended_run(true, "completed", 1, "rejected")]
#[case::retry_past_its_version(false, "running", 2, "expired")]
#[case::retry_of_a_waiting_run(false, "waitingForApproval", 1, "rejected")]
#[tokio::test]
async fn a_request_its_guards_refuse_ends_without_a_dispatch(
    #[case] is_interrupt: bool,
    #[case] run_state: &str,
    #[case] run_version: i64,
    #[case] outcome: &str,
) {
    let harness = harness(MockProviderDriver::new()).await;
    harness.set_run(run_state, run_version);
    let request = if is_interrupt {
        interrupt(harness.run_id, 1, "stop")
    } else {
        retry(harness.run_id, 1)
    };

    let answer = harness
        .service
        .apply_intervention(request, device())
        .await
        .expect("the service answers");

    match (outcome, &answer) {
        ("expired", AgentRunInterveneResponse::Expired { .. }) => {}
        (
            "rejected",
            AgentRunInterveneResponse::Rejected {
                rejection_reason, ..
            },
        ) => {
            assert_eq!(
                rejection_reason.as_str(),
                RefusalCode::AgentRunInvalidTransition.as_str()
            );
        }
        _ => panic!("expected {outcome}, got {answer:?}"),
    }
    let rows = harness.stored_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, outcome);
    assert_eq!(rows[0].2.as_deref(), Some("device-1"));
    assert_eq!(
        harness.stored_event_types(),
        [
            "agent.intervention.requested".to_owned(),
            format!("agent.intervention.{outcome}")
        ]
    );
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id),
        (run_state.to_owned(), run_version)
    );
}

// A dispatch that throws ends the request `failed` once, with a refusal's code or else the
// failure's description, and leaves the run as it was. Killed by recording the description for a
// refusal or recording the failure twice.
#[rstest]
#[case::a_refusal(true)]
#[case::a_driver_failure(false)]
#[tokio::test]
async fn a_dispatch_that_throws_ends_the_request_failed_once(#[case] is_refusal: bool) {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_retry_turn_on_faster_model()
        .times(1)
        .returning(move |_| {
            async move {
                Err::<FasterModelRetryOutcome, _>(if is_refusal {
                    DriverError::from(DomainError::new(
                        "the provider has no such model",
                        RefusalCode::ProviderNotFound,
                    ))
                } else {
                    DriverError::Internal("the provider's socket closed".into())
                })
            }
            .boxed()
        });
    let harness = harness(driver).await;

    let answer = harness
        .service
        .apply_intervention(retry(harness.run_id, 1), device())
        .await
        .expect("the failure is answered");

    let AgentRunInterveneResponse::Failed { failure_reason, .. } = answer else {
        panic!("a dispatch that throws answers failed, got {answer:?}");
    };
    if is_refusal {
        assert_eq!(
            failure_reason.as_str(),
            RefusalCode::ProviderNotFound.as_str()
        );
    } else {
        assert!(
            failure_reason
                .as_str()
                .contains("the provider's socket closed"),
            "{failure_reason:?}"
        );
    }
    assert_eq!(harness.stored_rows()[0].0, "failed");
    assert_eq!(
        harness.stored_event_types(),
        [
            "agent.intervention.requested",
            "agent.intervention.accepted",
            "agent.intervention.failed"
        ]
    );
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id),
        ("running".to_owned(), 1)
    );
}

/// How the run ends, or its turn, after a dispatch the provider got with no answer back.
#[derive(Clone, Copy, Debug)]
enum UnansweredEnd {
    /// The provider reports the turn completed and the run waiting for input, so the dispatch
    /// did not take.
    TurnCompleted,
    /// The provider reports it interrupted.
    Interrupted,
    /// The provider reports it stopped.
    Stopped,
    /// It ended interrupted and the daemon went down before any settle; the recovery pass at
    /// start settles it.
    InterruptedBeforeARestart,
}

// A dispatch the provider got with no answer back answers `accepted` and leaves its row open and
// a person's interrupt's queue hold held, its choice for the waiting messages untouched, until
// the run's own end settles both in its write: an interrupt applied when the run ended
// `interrupted`, its hold let go with the person's choice, and expired at any other end, its
// messages left waiting; a retry expires and holds nothing. A run that ended with no settle, the
// daemon gone down, is settled the same way by the recovery pass, and a turn that ended any other
// way than interrupted on a live run expires it in the change that carries the turn's end
// (`change_with_uninterrupted_turn_end`). Killed by recording the failure, letting the hold go
// before the run's end, settling on a later write, applying an interrupt at another end, letting
// it go with the wrong choice, a recovery pass that settles nothing, or a turn's end that leaves
// the row open.
#[rstest]
#[case::change_with_uninterrupted_turn_end(true, UnansweredEnd::TurnCompleted, "expired")]
#[case::interrupt_the_run_took(true, UnansweredEnd::Interrupted, "applied")]
#[case::interrupt_at_another_end(true, UnansweredEnd::Stopped, "expired")]
#[case::retry(false, UnansweredEnd::Interrupted, "expired")]
#[case::interrupt_after_a_restart(true, UnansweredEnd::InterruptedBeforeARestart, "applied")]
#[tokio::test]
async fn an_unanswered_dispatch_stays_open_until_the_runs_end_settles_it(
    #[case] is_interrupt: bool,
    #[case] end: UnansweredEnd,
    #[case] outcome: &str,
) {
    let mut driver = MockProviderDriver::new();
    if is_interrupt {
        driver
            .expect_apply_intervention()
            .times(1)
            .returning(|_| async { Err(unanswered()) }.boxed());
    } else {
        driver
            .expect_retry_turn_on_faster_model()
            .times(1)
            .returning(|_| async { Err(unanswered()) }.boxed());
    }
    let harness = harness(driver).await;
    let request = if is_interrupt {
        return_to_draft(harness.run_id, KEY)
    } else {
        retry(harness.run_id, 1)
    };

    let answer = harness
        .service
        .apply_intervention(request, device())
        .await
        .expect("the service answers");
    let open = harness.stored_rows()[0].0.clone();
    let released_while_open = harness.released_choices();
    let (before_outcome, after_outcome) = match end {
        UnansweredEnd::TurnCompleted => {
            let written = harness
                .engine
                .apply_provider_state_change(
                    RunStateChange::new(harness.run_id, RunStateEntry::WaitingForInput),
                    Some(ProviderTurnEnd {
                        turn_number: SafeInt::new(1).expect("a test turn"),
                        outcome: TurnOutcome::Completed,
                    }),
                )
                .await
                .expect("the provider's report is written");
            assert!(written.resend_failure.is_none());
            (
                Some("agent.turn.completed"),
                Some("agent.run.waitingForInput"),
            )
        }
        UnansweredEnd::Interrupted => {
            harness
                .report(RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                })
                .await;
            (None, Some("agent.run.interrupted"))
        }
        UnansweredEnd::Stopped => {
            harness
                .report(RunStateEntry::Stopped {
                    intended_close: None,
                    trigger: None,
                })
                .await;
            (None, Some("agent.run.stopped"))
        }
        UnansweredEnd::InterruptedBeforeARestart => {
            harness.set_run("interrupted", 2);
            harness
                .engine
                .settle_unresolved_of_ended_runs(harness.session_id)
                .await
                .expect("the recovery pass settles the ended run");
            (None, None)
        }
    };

    assert!(
        matches!(answer, AgentRunInterveneResponse::Accepted { .. }),
        "{answer:?}"
    );
    assert_eq!(open, "accepted");
    assert_eq!(released_while_open, []);
    assert_eq!(harness.stored_rows()[0].0, outcome);
    let mut events = vec![
        "agent.intervention.requested".to_owned(),
        "agent.intervention.accepted".to_owned(),
    ];
    events.extend(before_outcome.map(str::to_owned));
    events.push(format!("agent.intervention.{outcome}"));
    events.extend(after_outcome.map(str::to_owned));
    assert_eq!(harness.stored_events_from_the_first_intervention(), events);
    let released = match (is_interrupt, end) {
        (false, _) => vec![],
        (true, UnansweredEnd::Interrupted | UnansweredEnd::InterruptedBeforeARestart) => {
            vec![InterruptPendingChoice::ReturnToDraft]
        }
        (true, UnansweredEnd::Stopped | UnansweredEnd::TurnCompleted) => {
            vec![InterruptPendingChoice::KeepWaiting]
        }
    };
    assert_eq!(harness.released_choices(), released);
}

// An interrupt the provider got with no answer back is settled in the write of the run's end that
// a second interrupt's verdict makes, before that end's own event, and each hold is let go once
// with its own person's choice. Killed by leaving the first row open past the end, settling it
// as the verdict's row, or letting either hold go twice.
#[tokio::test]
async fn a_second_interrupts_verdict_settles_the_unanswered_first_in_the_runs_end() {
    let mut driver = MockProviderDriver::new();
    let calls = AtomicUsize::new(0);
    driver
        .expect_apply_intervention()
        .times(2)
        .returning(move |_| {
            let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            async move {
                if is_first {
                    Err(unanswered())
                } else {
                    Ok(applied())
                }
            }
            .boxed()
        });
    let harness = harness(driver).await;

    let first = harness
        .service
        .apply_intervention(return_to_draft(harness.run_id, OTHER_KEY), device())
        .await
        .expect("the first interrupt answers");
    let second = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect("the second interrupt answers");

    assert!(
        matches!(first, AgentRunInterveneResponse::Accepted { .. }),
        "{first:?}"
    );
    assert!(
        matches!(second, AgentRunInterveneResponse::Applied { .. }),
        "{second:?}"
    );
    let states: Vec<String> = harness
        .stored_rows()
        .into_iter()
        .map(|(state, _, _)| state)
        .collect();
    assert_eq!(states, ["applied", "applied"]);
    let events = harness.stored_events_from_the_first_intervention();
    assert_eq!(
        events[4..],
        [
            "agent.intervention.applied",
            "agent.intervention.applied",
            "agent.run.interrupted"
        ]
    );
    assert_eq!(
        harness.released_choices(),
        [
            InterruptPendingChoice::ReturnToDraft,
            InterruptPendingChoice::NextTurn
        ]
    );
}

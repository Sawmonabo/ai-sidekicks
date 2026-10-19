//! A person's interventions through the service, over a test database with a stand-in driver and
//! a run queue that hands each end straight to the run engine; the limit's tests share it.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::events::{InterventionActor, InterventionDeviceActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;

use super::errors::InterventionError;
use super::{
    INTERVENTION_SERVICE_STATEMENT_CAPACITY, InterventionService, InterventionServiceDeps,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::interventions::interrupt_queue::{
    InterruptCause, InterruptChoice, InterruptEnd, InterruptQueue, InterruptQueueError,
};
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::run_control::{
    ApplyInterventionResponse, FasterModelRetryOutcome, InterventionResultStatus,
};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::uuid_v7::mint_uuid_v7;

/// A run queue that holds nothing but counts each hold it takes, and hands each end straight to
/// the run engine.
struct EngineQueue {
    engine: Arc<RunEngine>,
    holds_taken: Arc<AtomicUsize>,
}

impl InterruptQueue for EngineQueue {
    fn hold_for_interrupt(
        &self,
        _run_id: RunId,
        _choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        self.holds_taken.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn end_run_for_interrupt(
        &self,
        end: InterruptEnd,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>> {
        let (limit, cut_turn) = match end.cause {
            InterruptCause::Person(_) => (None, None),
            InterruptCause::Limit { limit, cut_turn } => (Some(limit), cut_turn),
        };
        async move {
            Ok(self
                .engine
                .end_run_for_interrupt(
                    end.run_id,
                    end.accepted_run_version,
                    limit,
                    cut_turn,
                    end.verdict,
                )
                .await?)
        }
        .boxed()
    }

    fn release_interrupt(
        &self,
        _run_id: RunId,
        _choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        async { Ok(()) }.boxed()
    }
}

/// A service over a test database holding one running run, at version 1, bound to the table's
/// first provider, whose driver is `driver`.
pub(crate) struct Harness {
    /// The database.
    pub(crate) database: TestDatabase,
    /// The run engine the service and the queue end runs through.
    pub(crate) engine: Arc<RunEngine>,
    /// The service under test.
    pub(crate) service: Arc<InterventionService>,
    /// The run's session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// How many interrupt holds the run queue has taken.
    pub(crate) holds_taken: Arc<AtomicUsize>,
    // The engine's posture files.
    _home: TempDir,
}

/// The harness of a service whose driver is `driver`.
pub(crate) async fn harness(driver: MockProviderDriver) -> Harness {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    bind_run_to_first_provider(&database, run_id);
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let providers = registry_of_first_provider(Arc::new(driver));
    let holds_taken = Arc::new(AtomicUsize::new(0));
    let service = Arc::new(InterventionService::new(InterventionServiceDeps {
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            INTERVENTION_SERVICE_STATEMENT_CAPACITY,
        )),
        event_log: log.service,
        engine: Arc::clone(&engine),
        providers: Arc::new(providers),
        queue: Arc::new(EngineQueue {
            engine: Arc::clone(&engine),
            holds_taken: Arc::clone(&holds_taken),
        }),
    }));
    Harness {
        database,
        engine,
        service,
        session_id,
        run_id,
        holds_taken,
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

fn interrupt(run_id: RunId, version: u64, reason: &str) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(version).expect("a test version"),
        client_idempotency_key: key(KEY),
        reason: Some(FreeFormText::new(reason.to_owned()).expect("a test reason")),
        deliver_first: None,
    })
}

fn retry(run_id: RunId, version: u64) -> AgentRunInterveneRequest {
    AgentRunInterveneRequest::FasterModelRetry {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(version).expect("a test version"),
        client_idempotency_key: key(KEY),
        expected_turn_id: FreeFormText::new("turn-1".to_owned()).expect("a test turn"),
        model: FreeFormText::new("fast".to_owned()).expect("a test model"),
    }
}

/// An `applied` answer from a driver's interrupt.
pub(crate) fn applied() -> ApplyInterventionResponse {
    ApplyInterventionResponse {
        status: InterventionResultStatus::Applied,
        fallback_action: None,
        delivered_run_id: None,
        cancelled: Vec::new(),
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

// A reused key answers what the first request saved without a second dispatch or a hold of the
// queue, and refuses a request that asks for something else, also with no hold. Killed by
// dropping the payload comparison or the saved answer, or by taking the hold before the key's
// read.
#[tokio::test]
async fn a_reused_key_answers_the_saved_result_or_refuses_another_request() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(|_| async { Ok(applied()) }.boxed());
    let harness = harness(driver).await;

    let first = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect("the first request applies");
    let again = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "stop"), device())
        .await
        .expect("the same request answers again");
    let conflict = harness
        .service
        .apply_intervention(interrupt(harness.run_id, 1, "another reason"), device())
        .await
        .expect_err("another request under the key is refused");

    let AgentRunInterveneResponse::Applied {
        intervention_id, ..
    } = first
    else {
        panic!("the first request applies, got {first:?}");
    };
    let AgentRunInterveneResponse::Applied {
        intervention_id: saved,
        ..
    } = again
    else {
        panic!("the same request answers the saved result, got {again:?}");
    };
    assert_eq!(saved, intervention_id);
    let InterventionError::Refused(DomainError { code, detail, .. }) = conflict else {
        panic!("a conflict is a refusal, got {conflict:?}");
    };
    assert_eq!(code, RefusalCode::AgentInterventionIdempotencyConflict);
    let detail = detail.expect("the refusal names the run and the saved intervention");
    assert_eq!(detail["targetRunId"], harness.run_id.text().as_str());
    assert_eq!(detail["interventionId"], intervention_id.text().as_str());
    assert_eq!(harness.stored_rows().len(), 1);
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 1);
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "interrupted"
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
                    DriverError::Refused(DomainError::new(
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

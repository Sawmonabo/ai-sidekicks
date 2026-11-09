//! A person's controls on one helper and on every agent of a session, over the interventions'
//! test harness with a stand-in driver for the interrupt, another for the pause, and none for the
//! messages a continue delivers.

use std::sync::Arc;

use std::path::PathBuf;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::children::{
    AgentChildRunInterruptRequest, AgentChildRunPausedUpdateNotPaused,
    AgentChildRunPausedUpdatePaused, AgentChildRunPausedUpdateRequest,
    AgentChildRunPausedUpdateResponse, AgentChildRunStopAllRequest, ChildStoppedState,
};
use sidekicks_contracts::run::events::{
    AgentChildrenStoppedPayload, InterventionActor, InterventionDeviceActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{HelperStopOutcome, ResumeRunOutcome};
use sidekicks_provider::driver::test_registry::{
    registry_of_first_provider, registry_of_first_providers,
};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

use super::{AgentChildRunControlRefusedReason, ChildRunControlError, ChildRunControls};
use crate::agent_tree::read::AGENT_TREE_READ_STATEMENT_CAPACITY;
use crate::agent_tree::read::tests::{HELPER_PROVIDER, SessionLog, at};
use crate::agent_tree::store::{NewAgentTreeNode, insert_node, mint_child_handle};
use crate::agent_tree::sweep::stops::tests::appender;
use crate::agents::projection::test_fixture::{binding, run_statements, session_created};
use crate::interventions::limit_stop::tests::owed_limit::NoWaitingMessages;
use crate::interventions::service::tests::{Harness, applied, harness};
use crate::run::engine::test_fixture::insert_run;
use crate::run::pause::{RUN_PAUSE_STATEMENT_CAPACITY, RunPauseControl};

// Controls reading the database at `path`, a whole session's log readable, acting through
// `harness`'s interventions service and `providers`' drivers, pausing and continuing through
// `pause_driver` with no messages waiting, and appending to `database`'s log.
async fn controls(
    path: PathBuf,
    database: &TestDatabase,
    harness: &Harness,
    providers: ProviderRegistry,
    mut pause_driver: MockProviderDriver,
) -> ChildRunControls {
    let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> = Arc::new(|_: &SessionId| None);
    pause_driver
        .expect_message_handing()
        .return_const(MessageHanding {
            hands_at: HandMoment::AtOnce,
            can_withdraw: true,
            kept_by_process: false,
            reads_priority_message: false,
        });
    let pauses = RunPauseControl::new(
        Arc::new(DatabaseReadPool::new(
            path.clone(),
            RUN_PAUSE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&harness.engine),
        Arc::new(registry_of_first_provider(Arc::new(pause_driver))),
    );
    ChildRunControls::new(
        Arc::new(DatabaseReadPool::new(
            path,
            AGENT_TREE_READ_STATEMENT_CAPACITY,
        )),
        Arc::new(providers),
        (*harness.service).clone(),
        Arc::new(pauses),
        Arc::new(NoWaitingMessages(KeyedLock::new())),
        appender(open_log(database, None).await.service),
        read_damaged_from_sequence,
    )
}

/// The harness's run as the own run of a helper of a running parent run, at the parent's
/// version 1, with a second running run of the session that holds no child; the helper is
/// interrupted through the harness's driver and paused or continued through its own.
struct ChildOfARun {
    harness: Harness,
    controls: ChildRunControls,
    parent_run_id: RunId,
    other_run_id: RunId,
    child_handle: ChildHandle,
}

async fn child_of_a_run(
    driver: MockProviderDriver,
    pause_driver: MockProviderDriver,
    child_state: &str,
) -> ChildOfARun {
    let harness = harness(driver).await;
    let parent_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let other_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(
        &harness.database,
        harness.session_id,
        parent_run_id,
        "running",
    );
    insert_run(
        &harness.database,
        harness.session_id,
        other_run_id,
        "running",
    );
    harness
        .database
        .reader()
        .execute(
            "UPDATE runs SET parent_run_id = ?2, reached_by = ?3 WHERE run_id = ?1",
            params![
                harness.run_id.text().as_str(),
                parent_run_id.text().as_str(),
                <&'static str>::from(ChildRunProvenance::ProviderSubagent),
            ],
        )
        .expect("the test hangs the child's own run under its parent");
    harness.set_run(child_state, 1);
    let child_handle = mint_child_handle();
    run_statements(
        &harness.database.reader(),
        &[insert_node(&NewAgentTreeNode {
            child_handle: child_handle.clone(),
            session_id: harness.session_id,
            provider_name: ProviderId::new(HELPER_PROVIDER.to_owned()).expect("a provider id"),
            subagent_id: "helper-1".to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: None,
            role: None,
            provider_path: None,
            ask: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id: harness.run_id,
            started_at: WireInstant::now(),
        })],
    );
    let controls = controls(
        harness.database.path(),
        &harness.database,
        &harness,
        registry_of_first_provider(Arc::new(MockProviderDriver::new())),
        pause_driver,
    )
    .await;
    ChildOfARun {
        harness,
        controls,
        parent_run_id,
        other_run_id,
        child_handle,
    }
}

impl ChildOfARun {
    // Interrupts the child named under `target_run_id`, which the caller read at `version`.
    async fn interrupt(
        &self,
        target_run_id: RunId,
        version: u64,
    ) -> Result<RunState, ChildRunControlError> {
        let actor = InterventionDeviceActor::new(
            DeviceId::new("device-1".to_owned()).expect("a test device id"),
        )
        .expect("a device that is not the daemon");
        self.controls
            .interrupt(
                AgentChildRunInterruptRequest {
                    target_run_id,
                    child_handle: self.child_handle.clone(),
                    expected_run_version: SafeInt::new(version).expect("a test version"),
                    client_idempotency_key: ClientUuid::new(
                        "0b7f3c1e-9a52-4d6b-8e21-5f4c7d9a1b30".to_owned(),
                    )
                    .expect("a test key is a UUID"),
                    deliver_first: None,
                },
                InterventionActor::Device(actor),
            )
            .await
            .map(|response| {
                assert_eq!(response.child_handle, self.child_handle);
                response.state
            })
    }

    // Pauses (`paused`) or continues the child named under `target_run_id`, which the caller
    // read at `version`.
    async fn set_paused(
        &self,
        target_run_id: RunId,
        version: u64,
        paused: bool,
    ) -> Result<AgentChildRunPausedUpdateResponse, ChildRunControlError> {
        self.controls
            .paused_update(AgentChildRunPausedUpdateRequest {
                target_run_id,
                child_handle: self.child_handle.clone(),
                paused,
                expected_run_version: SafeInt::new(version).expect("a test version"),
            })
            .await
    }

    // The answer of the child held paused.
    fn held(&self) -> AgentChildRunPausedUpdateResponse {
        AgentChildRunPausedUpdateResponse::Paused(AgentChildRunPausedUpdatePaused {
            child_handle: self.child_handle.clone(),
            paused: True::default(),
            hold_lost: None,
        })
    }

    // The answer of the child not paused, its hold lost when `is_hold_lost` holds.
    fn not_held(&self, is_hold_lost: bool) -> AgentChildRunPausedUpdateResponse {
        AgentChildRunPausedUpdateResponse::NotPaused(AgentChildRunPausedUpdateNotPaused {
            child_handle: self.child_handle.clone(),
            paused: False::default(),
            hold_lost: is_hold_lost.then_some(True::default()),
        })
    }
}

fn refusal_code(error: ChildRunControlError) -> RefusalCode {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => refusal.code,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("expected a refusal, got {other:?}")
        }
    }
}

// A handle the target run holds no child under, and a stale version of the run the child
// belongs to, are each refused by the interrupt and by the pause before anything is sent: the
// drivers have no expectation, so a dispatch fails the test, and no intervention row is written.
// Killed by dropping the parent check or the version check.
#[rstest]
#[case::a_child_of_another_run(false, 1, RefusalCode::AgentChildRunNotFound)]
#[case::a_stale_parent_version(true, 2, RefusalCode::AgentRunVersionStale)]
#[tokio::test]
async fn a_child_control_refuses_the_wrong_parent_and_a_stale_version(
    #[case] is_own_parent: bool,
    #[case] version: u64,
    #[case] code: RefusalCode,
    #[values(false, true)] is_pause: bool,
) {
    let child = child_of_a_run(
        MockProviderDriver::new(),
        MockProviderDriver::new(),
        "running",
    )
    .await;
    let target = if is_own_parent {
        child.parent_run_id
    } else {
        child.other_run_id
    };

    let error = if is_pause {
        child.set_paused(target, version, true).await.map(drop)
    } else {
        child.interrupt(target, version).await.map(drop)
    }
    .expect_err("the control is refused");

    assert_eq!(refusal_code(error), code);
    assert_eq!(
        child.harness.stored_rows(),
        Vec::<(String, String, Option<String>)>::new()
    );
}

// A running child whose driver confirms the interrupt answers `interrupted`; one whose driver
// got it with no answer back is refused `providerRefused`, never answered as interrupted.
// Killed by answering an unconfirmed interrupt with the child's state.
#[rstest]
#[case::confirmed(true)]
#[case::unanswered(false)]
#[tokio::test]
async fn an_interrupt_answers_interrupted_only_when_the_provider_confirms_it(
    #[case] is_confirmed: bool,
) {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(move |_| {
            async move {
                if is_confirmed {
                    Ok(applied())
                } else {
                    Err(unanswered())
                }
            }
            .boxed()
        });
    let child = child_of_a_run(driver, MockProviderDriver::new(), "running").await;

    let answer = child.interrupt(child.parent_run_id, 1).await;

    if is_confirmed {
        assert_eq!(
            answer.expect("the interrupt is answered"),
            RunState::Interrupted
        );
    } else {
        let error = answer.expect_err("an unconfirmed interrupt is refused");
        assert!(
            matches!(
                error,
                ChildRunControlError::Refused {
                    reason: AgentChildRunControlRefusedReason::ProviderRefused
                }
            ),
            "{error:?}"
        );
        assert_eq!(
            refusal_code(error),
            RefusalCode::AgentChildRunControlRefused
        );
    }
}

// A child that had already completed answers `completed`, and nothing is sent: the driver has
// no expectation and no intervention row is written. Killed by interrupting an ended child.
#[tokio::test]
async fn an_ended_child_answers_its_end_with_nothing_sent() {
    let child = child_of_a_run(
        MockProviderDriver::new(),
        MockProviderDriver::new(),
        "completed",
    )
    .await;

    let state = child
        .interrupt(child.parent_run_id, 1)
        .await
        .expect("an ended child answers its state");

    assert_eq!(state, RunState::Completed);
    assert_eq!(
        child.harness.stored_rows(),
        Vec::<(String, String, Option<String>)>::new()
    );
}

// A pause of a running child holds it through its driver and answers held; a continue of a paused
// one answers not held, with `holdLost` exactly when the driver reports the hold lost. Killed by
// a lost hold read as a release, and by an answer taken from the request rather than the set.
#[rstest]
#[case::a_pause("running", true, false)]
#[case::a_continue("paused", false, false)]
#[case::a_continue_after_a_lost_hold("paused", false, true)]
#[tokio::test]
async fn a_set_answers_whether_the_child_is_held(
    #[case] child_state: &str,
    #[case] paused: bool,
    #[case] is_hold_lost: bool,
) {
    let mut pause_driver = MockProviderDriver::new();
    if paused {
        pause_driver
            .expect_pause_run()
            .times(1)
            .returning(|_| async { Ok(()) }.boxed());
    } else {
        pause_driver
            .expect_resume_run()
            .times(1)
            .returning(move |_| async move { Ok(ResumeRunOutcome { is_hold_lost }) }.boxed());
    }
    let child = child_of_a_run(MockProviderDriver::new(), pause_driver, child_state).await;

    let answer = child
        .set_paused(child.parent_run_id, 1, paused)
        .await
        .expect("the set is answered");

    let expected = if paused {
        child.held()
    } else {
        child.not_held(is_hold_lost)
    };
    assert_eq!(answer, expected);
}

// A child already standing in the set is answered as it stands with no driver called: a pause
// of a paused child takes no second hold, and a continue of a running one sends nothing. Killed
// by a second hold taken.
#[rstest]
#[case::a_pause_of_a_paused_child("paused", true)]
#[case::a_continue_of_a_running_child("running", false)]
#[tokio::test]
async fn a_set_the_child_stands_in_calls_no_driver(
    #[case] child_state: &str,
    #[case] paused: bool,
) {
    let mut pause_driver = MockProviderDriver::new();
    pause_driver.expect_pause_run().times(0);
    pause_driver.expect_resume_run().times(0);
    let child = child_of_a_run(MockProviderDriver::new(), pause_driver, child_state).await;

    let answer = child
        .set_paused(child.parent_run_id, 1, paused)
        .await
        .expect("the set is answered");

    let expected = if paused {
        child.held()
    } else {
        child.not_held(false)
    };
    assert_eq!(answer, expected);
}

// A pause or a continue of a child that has ended is refused `childEnded` with no driver called.
// Killed by setting an ended child.
#[rstest]
#[tokio::test]
async fn a_set_of_an_ended_child_is_refused_child_ended(#[values(true, false)] paused: bool) {
    let child = child_of_a_run(
        MockProviderDriver::new(),
        MockProviderDriver::new(),
        "completed",
    )
    .await;

    let error = child
        .set_paused(child.parent_run_id, 1, paused)
        .await
        .expect_err("an ended child is refused");

    assert!(
        matches!(
            error,
            ChildRunControlError::Refused {
                reason: AgentChildRunControlRefusedReason::ChildEnded
            }
        ),
        "{error:?}"
    );
    assert_eq!(
        refusal_code(error),
        RefusalCode::AgentChildRunControlRefused
    );
}

// A stop of every agent a session dispatched, on a session whose lead runs on the table's
// provider at `lead_place`: of four helpers, each driver stop answering the other word, one
// already ended and one refused, the row names the two stopped in dispatch order under the
// lead's word, and the answer keeps every outcome in that order. Killed by a row built from
// every outcome, by one cut at the first failure, and by a word taken from the children.
#[rstest]
#[case::stopped_for_good(0, ChildStoppedState::Stopped)]
#[case::interrupted(1, ChildStoppedState::Interrupted)]
#[tokio::test]
async fn the_stop_all_row_names_the_stopped_in_dispatch_order_under_the_leads_word(
    #[case] lead_place: usize,
    #[case] word: ChildStoppedState,
) {
    let other_word = match word {
        ChildStoppedState::Stopped => HelperStopOutcome::Interrupted,
        ChildStoppedState::Interrupted => HelperStopOutcome::Stopped,
    };
    let answers = [
        ("helper-first", Some(other_word)),
        ("helper-ended", Some(HelperStopOutcome::AlreadyEnded)),
        ("helper-refused", None),
        ("helper-last", Some(other_word)),
    ];
    let harness = harness(MockProviderDriver::new()).await;
    let mut log = SessionLog::new();
    let lead = log.lead;
    let lead_provider = PROVIDERS[lead_place].id;
    let created = serde_json::to_value(session_created(
        log.session_id,
        lead.text().as_str(),
        &binding(lead_provider, "model-lead"),
    ))
    .expect("the session's birth writes");
    log.event(
        SessionEventType::SessionCreated,
        &created["payload"],
        None,
        &at(0),
    );
    let lead_run = log.run(None, RunState::Running, lead, &at(0));
    let mut handles = Vec::new();
    for (place, (subagent_id, _)) in (1_u32..).zip(answers) {
        let own_run = log.own_run(lead_run, subagent_id, RunState::Running, &at(place));
        handles.push(log.node(own_run, subagent_id, None, &at(place)));
    }
    log.connection
        .execute(
            "UPDATE agent_tree_nodes SET provider_name = ?1",
            [lead_provider],
        )
        .expect("the test names the helpers' provider");
    let mut helper_driver = MockProviderDriver::new();
    helper_driver
        .expect_stop_child_run()
        .times(answers.len())
        .returning(move |params| {
            let (_, answer) = answers
                .into_iter()
                .find(|(subagent_id, _)| *subagent_id == params.subagent_id.as_str())
                .expect("each stop names a test helper");
            async move {
                answer.ok_or_else(|| {
                    DriverError::from(DomainError::new(
                        "the provider is not running",
                        RefusalCode::ProviderUnavailable,
                    ))
                })
            }
            .boxed()
        });
    let mut drivers: Vec<Arc<dyn ProviderDriver>> = vec![
        Arc::new(MockProviderDriver::new()),
        Arc::new(MockProviderDriver::new()),
    ];
    drivers[lead_place] = Arc::new(helper_driver);
    let path = PathBuf::from(
        log.connection
            .path()
            .expect("the test's database is a file"),
    );
    let controls = controls(
        path,
        &log.database,
        &harness,
        registry_of_first_providers(drivers),
        MockProviderDriver::new(),
    )
    .await;
    let actor = InterventionDeviceActor::new(
        DeviceId::new("device-1".to_owned()).expect("a test device id"),
    )
    .expect("a device that is not the daemon");

    let answer = controls
        .stop_all(
            AgentChildRunStopAllRequest {
                session_id: log.session_id,
            },
            InterventionActor::Device(actor),
        )
        .await
        .expect("the stop is answered");

    let child = |place: usize| AgentTreeMember::ProviderChild {
        run_id: lead_run,
        child_handle: handles[place].clone(),
    };
    let answered: Vec<AgentTreeMember> = answer
        .children
        .into_iter()
        .map(|outcome| match outcome {
            super::ChildStopOutcome::Stopped { child, .. }
            | super::ChildStopOutcome::AlreadyEnded { child, .. }
            | super::ChildStopOutcome::Failed { child, .. } => child,
        })
        .collect();
    assert_eq!(answered, (0..answers.len()).map(child).collect::<Vec<_>>());
    let rows: Vec<Value> = log
        .connection
        .prepare("SELECT payload FROM session_events WHERE type = ?1")
        .expect("the test prepares its read")
        .query_map([SessionEventType::AgentChildrenStopped.as_str()], |row| {
            row.get::<_, String>(0)
        })
        .expect("the test reads the log")
        .map(|payload| {
            serde_json::from_str(&payload.expect("each row reads")).expect("a JSON payload")
        })
        .collect();
    assert_eq!(
        rows,
        [serde_json::to_value(AgentChildrenStoppedPayload {
            word,
            reached: vec![child(0), child(3)],
        })
        .expect("the payload writes")]
    );
}

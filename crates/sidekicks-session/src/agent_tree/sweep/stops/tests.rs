use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::agent::tree::{AgentTreeMember, ChildHandle};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::children::{ChildStopOutcome, ChildStoppedState};
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::run_control::HelperStopOutcome;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::session::read::session_read_bound;
use tokio::sync::Barrier;

use super::AgentTreeSweep;
use crate::agent_tree::read::tests::{SessionLog, agent_id, at};
use crate::agent_tree::sweep::{AGENT_TREE_SWEEP_STATEMENT_CAPACITY, SweepRoot};
use crate::agents::projection::test_fixture::write_log_row;
use crate::interventions::service::tests::{Harness, applied, harness};
use crate::run::engine::test_fixture::insert_running_run;

// Longer than every stop of a test takes once they run at once; one stop after another never
// gets past the barrier.
const STOPS_DEADLINE: Duration = Duration::from_secs(10);

// Each helper's id, the driver's answer to its stop and the outcome it reads as, in dispatch
// order.
const HELPER_STOPS: [(&str, Option<HelperStopOutcome>); 5] = [
    ("helper-stopped", Some(HelperStopOutcome::Stopped)),
    ("helper-interrupted", Some(HelperStopOutcome::Interrupted)),
    (
        "helper-already-interrupted",
        Some(HelperStopOutcome::AlreadyInterrupted),
    ),
    (
        "helper-already-ended",
        Some(HelperStopOutcome::AlreadyEnded),
    ),
    ("helper-refused", None),
];

fn daemon() -> InterventionActor {
    InterventionActor::Daemon(DaemonInterventionActor::Value)
}

// A sweep reading the database at `path`, stopping helpers through `driver` and runs through
// `harness`'s interventions service.
fn sweep(path: PathBuf, driver: MockProviderDriver, harness: &Harness) -> AgentTreeSweep {
    AgentTreeSweep::new(
        Arc::new(DatabaseReadPool::new(
            path,
            AGENT_TREE_SWEEP_STATEMENT_CAPACITY,
        )),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
        (*harness.service).clone(),
    )
}

// Five helpers under one lead run, whose driver answers each stop only once all five are asked,
// the last-dispatched answering first: every stop runs at once, each answer reads as its outcome,
// a refusal as its code, and the outcomes come in dispatch order. Killed by stops sent one after
// another (the barrier never opens), by an already interrupted helper told as stopped, by a
// failed stop dropped, and by outcomes in the order the answers came.
#[tokio::test]
async fn every_helper_is_stopped_at_once_and_answered_in_dispatch_order() {
    let harness = harness(MockProviderDriver::new()).await;
    let mut log = SessionLog::new();
    let lead = log.lead;
    let lead_run = log.run(None, RunState::Running, lead, &at(0));
    let mut handles: Vec<ChildHandle> = Vec::new();
    for (place, (subagent_id, _)) in (1_u32..).zip(HELPER_STOPS) {
        let own_run = log.own_run(lead_run, subagent_id, RunState::Running, &at(place));
        handles.push(log.node(own_run, subagent_id, None, &at(place)));
    }
    // The helpers' provider is the one the sweep's registry answers.
    log.connection
        .execute(
            "UPDATE agent_tree_nodes SET provider_name = ?1",
            [PROVIDERS[0].id],
        )
        .expect("the test names the helpers' provider");
    let barrier = Arc::new(Barrier::new(HELPER_STOPS.len()));
    let mut driver = MockProviderDriver::new();
    driver
        .expect_stop_child_run()
        .times(HELPER_STOPS.len())
        .returning(move |params| {
            let barrier = Arc::clone(&barrier);
            let place = HELPER_STOPS
                .iter()
                .position(|(subagent_id, _)| *subagent_id == params.subagent_id.as_str())
                .expect("each stop names a test helper");
            async move {
                barrier.wait().await;
                let later_helpers = u64::try_from(HELPER_STOPS.len() - place).expect("a count");
                tokio::time::sleep(Duration::from_millis(10 * later_helpers)).await;
                HELPER_STOPS[place].1.ok_or_else(|| {
                    DriverError::from(DomainError::new(
                        "the provider is not running",
                        RefusalCode::ProviderUnavailable,
                    ))
                })
            }
            .boxed()
        });
    let path = PathBuf::from(
        log.connection
            .path()
            .expect("the test's database is a file"),
    );
    let sweep = sweep(path, driver, &harness);
    let read_bound = session_read_bound(|_| None, &log.session_id, None);

    let outcomes = tokio::time::timeout(
        STOPS_DEADLINE,
        sweep.stop_descendants(
            log.session_id,
            SweepRoot::Run(lead_run),
            None,
            read_bound,
            daemon(),
        ),
    )
    .await
    .expect("the stops run at once")
    .expect("the session's agents read");

    let child = |place: usize| AgentTreeMember::ProviderChild {
        run_id: lead_run,
        child_handle: handles[place].clone(),
    };
    assert_eq!(
        outcomes,
        [
            ChildStopOutcome::Stopped {
                child: child(0),
                state: ChildStoppedState::Stopped,
                reason: None,
            },
            ChildStopOutcome::Stopped {
                child: child(1),
                state: ChildStoppedState::Interrupted,
                reason: None,
            },
            ChildStopOutcome::AlreadyEnded {
                child: child(2),
                state: None,
                reason: None,
            },
            ChildStopOutcome::AlreadyEnded {
                child: child(3),
                state: None,
                reason: None,
            },
            ChildStopOutcome::Failed {
                child: child(4),
                state: None,
                reason: FreeFormText::new(RefusalCode::ProviderUnavailable.as_str().to_owned())
                    .expect("a refusal code is a reason"),
            },
        ]
    );
}

/// How the bridged run's interrupt goes.
#[derive(Clone, Copy, Debug)]
enum RunInterrupt {
    /// The driver applies it.
    Applied,
    /// The provider gets it and no answer comes back.
    Unanswered,
    /// The run is already interrupted, so nothing is sent.
    AlreadyInterrupted,
}

// The harness's running run, made a bridged child of a lead run, is stopped by the run engine's
// interrupt: an applied interrupt leaves it interrupted, one the provider never answered is a
// failed stop and never told as stopped, and a run already interrupted is sent nothing. Killed by
// an unconfirmed stop told as stopped, by an intervention sent to an interrupted run (the driver
// has no expectation then, and its row is counted), and by the run arm skipped.
#[rstest]
#[case::applied(RunInterrupt::Applied)]
#[case::unanswered(RunInterrupt::Unanswered)]
#[case::already_interrupted(RunInterrupt::AlreadyInterrupted)]
#[tokio::test]
async fn a_bridged_run_is_stopped_by_the_run_engines_interrupt(#[case] interrupt: RunInterrupt) {
    let mut driver = MockProviderDriver::new();
    match interrupt {
        RunInterrupt::Applied => {
            driver
                .expect_apply_intervention()
                .times(1)
                .returning(|_| async { Ok(applied()) }.boxed());
        }
        RunInterrupt::Unanswered => {
            driver
                .expect_apply_intervention()
                .times(1)
                .returning(|_| async { Err(unanswered()) }.boxed());
        }
        RunInterrupt::AlreadyInterrupted => {}
    }
    let harness = harness(driver).await;
    let lead_run = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&harness.database, harness.session_id, lead_run);
    let connection = harness.database.reader();
    connection
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'bridgeRun' WHERE run_id = ?2",
            [lead_run.text().as_str(), harness.run_id.text().as_str()],
        )
        .expect("the test makes the run a bridged child");
    let bridged_agent = agent_id();
    // The harness's log is empty, so the run's queued row takes its first sequence.
    write_log_row(
        &connection,
        harness.session_id,
        0,
        (
            SessionEventType::AgentRunQueued,
            &json!({ "agentId": bridged_agent }),
        ),
        Some(harness.run_id),
        &at(1),
    );
    if matches!(interrupt, RunInterrupt::AlreadyInterrupted) {
        harness.set_run("interrupted", 2);
    }
    let sweep = sweep(harness.database.path(), MockProviderDriver::new(), &harness);
    let read_bound = session_read_bound(|_| None, &harness.session_id, None);

    let outcomes = sweep
        .stop_descendants(
            harness.session_id,
            SweepRoot::Run(lead_run),
            None,
            read_bound,
            daemon(),
        )
        .await
        .expect("the session's agents read");

    let child = AgentTreeMember::Agent {
        agent_id: bridged_agent,
    };
    let (expected, rows) = match interrupt {
        RunInterrupt::Applied => (
            ChildStopOutcome::Stopped {
                child,
                state: ChildStoppedState::Interrupted,
                reason: None,
            },
            1,
        ),
        RunInterrupt::Unanswered => (
            ChildStopOutcome::Failed {
                child,
                state: None,
                reason: FreeFormText::new(RefusalCode::ProviderTimeout.as_str().to_owned())
                    .expect("a refusal code is a reason"),
            },
            1,
        ),
        RunInterrupt::AlreadyInterrupted => (
            ChildStopOutcome::AlreadyEnded {
                child,
                state: None,
                reason: None,
            },
            0,
        ),
    };
    assert_eq!(outcomes, [expected]);
    assert_eq!(harness.stored_rows().len(), rows);
}

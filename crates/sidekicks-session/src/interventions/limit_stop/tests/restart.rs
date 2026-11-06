//! A limit's `accepted` row a restart found, carried out once by the restart's hand.

use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::intervention::{InterventionType, LimitInterruptRecord, RunLimit};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;

use super::owed_limit::{assert_owed_hand_ends_the_run, driver_failing_once};
use super::{hand_service_to_engine, record_accepted_row};
use crate::interventions::service::InterventionTarget;
use crate::interventions::service::tests::harness;
use crate::run::engine::test_fixture::{append, stored_run_state};
use crate::run::engine::tests::turn_started_at;
use crate::run::read::{LiveRun, RunRead};

// A restart's hand of a token limit's row whose dispatch fails leaves no row pending, so it owes
// the limit again and withdraws the cut the re-arm restored from the row; the owed limit's next
// hand then cuts the turn and ends the run. Killed by the limit not owed again (the second hand
// never comes and the wait times out) and by the restored cut not withdrawn (the turn still reads
// cut at the token limit after the failure).
#[tokio::test]
async fn a_failed_restart_hand_owes_the_limit_again_and_withdraws_the_restored_cut() {
    let (driver, dispatch) = driver_failing_once();
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    append(
        &harness.engine,
        harness.session_id,
        &turn_started_at(harness.session_id, harness.run_id, 1, 1),
    )
    .await;
    let turn = SafeInt::new(1).expect("1 is a turn number");
    let intervention_id = record_accepted_row(&harness, RunLimit::TokenLimit, Some(turn));
    harness
        .engine
        .rearm_after_restart(&LiveRun {
            run_id: harness.run_id,
            run: RunRead {
                version: 1,
                session_id: harness.session_id,
                state: RunState::Running,
            },
            parent_run_id: None,
            reached_by: None,
        })
        .await
        .expect("the run is re-armed from its log");
    assert_eq!(
        harness.engine.held_cut_limit(harness.run_id, turn),
        Some(RunLimit::TokenLimit)
    );

    {
        let _hold = harness.service.interrupt_lock.acquire(harness.run_id).await;
        harness
            .service
            .hand_limit_interrupt_again(
                InterventionTarget {
                    session_id: harness.session_id,
                    intervention_id,
                    target_run_id: harness.run_id,
                    intervention_type: InterventionType::Interrupt,
                    actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
                },
                LimitInterruptRecord {
                    limit: RunLimit::TokenLimit,
                    turn_number: Some(turn),
                },
                1,
            )
            .await;
    }

    assert_eq!(harness.stored_rows()[0].0, "failed");
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "running"
    );
    assert_eq!(harness.engine.held_cut_limit(harness.run_id, turn), None);
    harness.engine.hand_owed_limit_interrupts(harness.run_id);
    assert_owed_hand_ends_the_run(&harness, dispatch).await;
}

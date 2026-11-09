//! The daemon's own interrupt of a run for an undo through the service, over the interventions'
//! test harness: its row, its driver's payload, no queue hold, and a degraded or unanswered
//! dispatch that leaves the turn uncut.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::intervention::{InterruptInterventionRecord, UndoInterruptRecord};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptPendingChoice,
    InterventionResultStatus,
};

use crate::interventions::service::errors::InterventionError;
use crate::interventions::service::tests::{applied, harness};
use crate::run::engine::test_fixture::stored_run_state;

/// What the driver answers the undo's interrupt.
#[derive(Clone, Copy, Debug)]
enum DriverAnswer {
    /// It cuts the turn.
    Applies,
    /// It answers through a fallback.
    Degrades,
    /// It got the request and no answer came back.
    Unanswered,
}

// The undo's interrupt of a running run hands the driver one interrupt that keeps the waiting
// messages waiting and takes no queue hold, its row carrying no device and the undo's record naming
// its key. Applied, the row ends `applied`, the run `interrupted` and the call answers; degraded,
// the call fails naming the turn not ended, so the undo does not cut; unanswered, it fails the same
// way and the row stays `accepted` for the turn's end, the run still running. Killed by the
// payload written as a limit's or a person's (the record reads as another arm), by a queue hold
// taken, by any other choice for the waiting messages, by a degraded verdict answered as applied,
// or by the unanswered row moved to `failed`.
#[rstest]
#[case::applied(DriverAnswer::Applies, "applied", "interrupted")]
#[case::degraded(DriverAnswer::Degrades, "degraded", "interrupted")]
#[case::unanswered(DriverAnswer::Unanswered, "accepted", "running")]
#[tokio::test]
async fn an_undos_interrupt_ends_the_run_with_the_daemons_row_and_no_queue_hold(
    #[case] answer: DriverAnswer,
    #[case] row_state: &str,
    #[case] run_end: &str,
) {
    let choices: Arc<Mutex<Vec<InterruptPendingChoice>>> = Arc::default();
    let mut driver = MockProviderDriver::new();
    let seen = Arc::clone(&choices);
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(move |params| {
            if let ApplyInterventionParams::Interrupt { payload, .. } = params {
                seen.lock()
                    .expect("the choices are not poisoned")
                    .push(payload.pending);
            }
            async move {
                match answer {
                    DriverAnswer::Applies => Ok(applied()),
                    DriverAnswer::Degrades => Ok(ApplyInterventionResponse {
                        status: InterventionResultStatus::Degraded,
                        ..applied()
                    }),
                    DriverAnswer::Unanswered => Err(unanswered()),
                }
            }
            .boxed()
        });
    let harness = harness(driver).await;
    let undo_key =
        ClientUuid::new("0190f2a0-0000-7000-8000-000000000004".to_owned()).expect("a test key");

    let interrupted = harness
        .service
        .interrupt_for_undo(harness.run_id, undo_key.clone())
        .await;

    match answer {
        DriverAnswer::Applies => interrupted.expect("the undo's interrupt applies"),
        DriverAnswer::Degrades | DriverAnswer::Unanswered => {
            let error = interrupted.expect_err("an interrupt that ended no turn fails the undo");
            assert!(
                matches!(error, InterventionError::TurnNotEnded { .. }),
                "{error:?}"
            );
        }
    }
    assert_eq!(
        *choices.lock().expect("the choices are not poisoned"),
        [InterruptPendingChoice::KeepWaiting]
    );
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
    let rows = harness.stored_rows();
    assert_eq!(rows.len(), 1);
    let (state, payload, device) = &rows[0];
    assert_eq!(state, row_state);
    assert_eq!(device, &None);
    assert_eq!(
        serde_json::from_str::<InterruptInterventionRecord>(payload)
            .expect("the payload reads as an interrupt's record"),
        InterruptInterventionRecord::Undo(UndoInterruptRecord { undo_key })
    );
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        run_end
    );
}

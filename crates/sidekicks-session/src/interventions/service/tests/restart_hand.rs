//! The interrupts a restart found pending, a person's and a limit's, handed again over the
//! harness's running run, an undo's handed nothing, and the daemon's stop of the engine's interrupt
//! hands that carry them and a limit's interrupt out.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use tokio::sync::oneshot;

use super::{Harness, applied, harness};
use crate::interventions::limit_stop::HandCanceled;
use crate::interventions::limit_stop::tests::hand_service_to_engine;
use crate::interventions::limit_stop::tests::owed_limit::owe_token_limit;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::test_fixture::stored_run_state;
use crate::run::engine::tests::{DRIVER_HOLD, SETTLE_WAIT};
use crate::run::limit_interrupter::{LimitInterruptFailure, LimitInterrupter};

/// How long the daemon's stop may take to cut an interrupt hand held in its driver.
const HAND_CUT_BOUND: Duration = Duration::from_secs(1);

/// A person's interrupt pending at the restart, as its stored record reads.
const PENDING_PERSON_RECORD: &str = r#"{"pending":"nextTurn"}"#;

impl Harness {
    // Records an interrupt of the run left in `state` with its stored `record`, asked at version 1
    // from `device`, none for the daemon's own, as a restart finds it; answers its id.
    fn record_pending_interrupt(&self, state: &str, record: &str, device: Option<&str>) -> String {
        let id = mint_uuid_v7().to_string();
        self.database
            .reader()
            .execute(
                &format!(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', ?3, ?4, ?5, 1, ?1, {DATABASE_NOW_SQL})"
                ),
                params![id, self.run_id.text().as_str(), state, record, device],
            )
            .expect("the test records the interrupt");
        id
    }

    // The state of intervention `id`.
    fn intervention_state(&self, id: &str) -> String {
        self.database
            .reader()
            .query_row(
                "SELECT state FROM interventions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .expect("the intervention's state reads")
    }

    // The trigger of the run's interrupted end, `None` when it carries none.
    fn interrupted_trigger(&self) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT json_extract(payload, '$.trigger') FROM session_events
                  WHERE run_id = ?1 AND type = 'agent.run.interrupted'",
                [self.run_id.text().as_str()],
                |row| row.get(0),
            )
            .optional()
            .expect("the run's end reads")
            .expect("the run ended interrupted")
    }
}

// A person's interrupt pending at the restart, `requested` or `accepted`, beside a limit's
// `accepted` row, is handed again through the live path: the queue's hold is taken again, the row
// is carried from where it stands to `applied` by one driver call, the run ends `interrupted` as
// the person's, with no trigger, and the hold is let go with the person's choice; the limit's row,
// carried out after the person's interrupt ended the run, cuts nothing. Killed by the limit's row
// cutting the ended run (a second driver call), by a `requested` row dispatched without its
// accept (the verdict's move from `accepted` is refused and the run stays running), by an
// `accepted` row accepted again (the accept's move is refused and no driver call is made), and by
// no hold taken (`holds_taken` reads 0).
#[rstest]
#[case::requested("requested")]
#[case::accepted("accepted")]
#[tokio::test]
async fn a_persons_pending_interrupt_is_handed_again_through_the_live_path(
    #[case] person_state: &str,
) {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(|_| async { Ok(applied()) }.boxed());
    let harness = harness(driver).await;
    let person = harness.record_pending_interrupt(
        person_state,
        r#"{"pending":"nextTurn"}"#,
        Some("device-1"),
    );
    harness.record_pending_interrupt("accepted", r#"{"limit":"stepLimit"}"#, None);

    harness
        .service
        .carry_out_pending_interrupts(harness.run_id)
        .await
        .expect("the person's interrupt is handed again");

    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "interrupted"
    );
    assert_eq!(harness.interrupted_trigger(), None);
    assert_eq!(harness.intervention_state(&person), "applied");
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.released_choices(),
        [InterruptPendingChoice::NextTurn]
    );
}

// A limit's `accepted` row a restart found, whose hand ended with the old process, is carried out
// once as its live hand would: one driver call, the row `applied` and the run ended `interrupted`
// with the step limit's trigger, with no queue hold taken. Killed by the limit's arm dropped (the
// driver is never called and the run stays running) and by the row sent through the person's
// path (a hold taken and no trigger).
#[tokio::test]
async fn a_limits_accepted_row_left_by_a_restart_is_carried_out_once() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(|_| async { Ok(applied()) }.boxed());
    let harness = harness(driver).await;
    let limit = harness.record_pending_interrupt("accepted", r#"{"limit":"stepLimit"}"#, None);

    harness
        .service
        .carry_out_pending_interrupts(harness.run_id)
        .await
        .expect("the limit's interrupt is carried out");

    assert_eq!(harness.intervention_state(&limit), "applied");
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "interrupted"
    );
    assert_eq!(harness.interrupted_trigger().as_deref(), Some("stepLimit"));
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
}

// An undo's `accepted` row a former process left, on a run whose provider kept its turn, is handed
// nothing: no driver call, no queue hold, the row still `accepted` for the turn's end and the run
// still running. Killed by the pending read keeping an undo's row while the restart hands it as a
// limit's or a person's (the driver is called, which the mock refuses).
#[tokio::test]
async fn a_restart_hands_an_undos_interrupt_nothing() {
    let mut driver = MockProviderDriver::new();
    driver.expect_apply_intervention().never();
    let harness = harness(driver).await;
    let undo = harness.record_pending_interrupt(
        "accepted",
        r#"{"undoKey":"0190f2a0-0000-7000-8000-000000000005"}"#,
        None,
    );

    harness
        .service
        .carry_out_pending_interrupts(harness.run_id)
        .await
        .expect("the undo's row is left as it is");

    assert_eq!(harness.intervention_state(&undo), "accepted");
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "running"
    );
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
}

// A person's `accepted` row the hand read, carried out by the live path while the hand waited for
// the run's interrupt lock, is not sent again: no driver call and no hold taken. Killed by the hand
// sending the state it read before the lock (the driver is called a second time).
#[tokio::test]
async fn a_row_carried_out_while_the_hand_waited_is_sent_once() {
    let mut driver = MockProviderDriver::new();
    driver.expect_apply_intervention().never();
    let harness = harness(driver).await;
    let person =
        harness.record_pending_interrupt("accepted", r#"{"pending":"nextTurn"}"#, Some("device-1"));
    let lock = std::sync::Arc::clone(&harness.service.interrupt_lock);
    let live_hold = lock.acquire(harness.run_id).await;
    let handles = lock.queue_handle_count(harness.run_id);
    let service = harness.service.clone();
    let run_id = harness.run_id;
    let hand = tokio::spawn(async move { service.carry_out_pending_interrupts(run_id).await });
    lock.wait_for_queue_past(harness.run_id, handles).await;
    harness
        .database
        .reader()
        .execute(
            "UPDATE interventions SET state = 'applied' WHERE id = ?1",
            [&person],
        )
        .expect("the live path carries the row out");
    drop(live_hold);

    hand.await
        .expect("the hand's task ends")
        .expect("the hand skips the row");

    assert_eq!(harness.intervention_state(&person), "applied");
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
}

// A driver whose every interrupt fails, counting each call.
fn driver_failing_every_interrupt(calls: &Arc<AtomicUsize>) -> MockProviderDriver {
    let calls = Arc::clone(calls);
    let mut driver = MockProviderDriver::new();
    driver.expect_apply_intervention().returning(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        async { Err(DriverError::Internal("the provider's socket closed".into())) }.boxed()
    });
    driver
}

// A driver whose interrupt never answers, the call sent to the receiver once made.
fn driver_holding_its_interrupt() -> (MockProviderDriver, oneshot::Receiver<()>) {
    let (reached, reaching) = oneshot::channel();
    let reached = Mutex::new(Some(reached));
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(move |_| {
            if let Some(reached) = reached.lock().expect("the signal is not poisoned").take() {
                reached.send(()).expect("the test waits for the call");
            }
            std::future::pending().boxed()
        });
    (driver, reaching)
}

/// The engine's interrupt hand a test hands after the daemon's stop.
#[derive(Clone, Copy, Debug)]
enum StoppedHand {
    /// The limit a run owes once its provider runs again.
    OwedLimit,
    /// A person's interrupt pending at the restart.
    PendingAtRestart,
}

// Once the daemon's stop has ended the engine's interrupt hands, neither the hand of a limit the
// run owes nor the restart's hand of a pending interrupt sends the driver anything, and no queue
// hold is taken. Killed by a bare spawn kept in the restart's hand (the driver is called), and by
// every hand on the owed limit's path spawned bare together (the driver is called again); one of
// those layers spawned bare alone is refused by the layer under it, and the refusal itself is
// proved by `a_hand_asked_for_after_the_stop_never_runs`.
#[rstest]
#[case::an_owed_limit(StoppedHand::OwedLimit)]
#[case::an_interrupt_pending_at_the_restart(StoppedHand::PendingAtRestart)]
#[tokio::test]
async fn a_stopped_engine_hands_no_interrupt(#[case] hand: StoppedHand) {
    let calls = Arc::new(AtomicUsize::new(0));
    let harness = harness(driver_failing_every_interrupt(&calls)).await;
    hand_service_to_engine(&harness);
    let calls_before = match hand {
        StoppedHand::OwedLimit => {
            owe_token_limit(&harness, "running").await;
            1
        }
        StoppedHand::PendingAtRestart => {
            harness.record_pending_interrupt("accepted", PENDING_PERSON_RECORD, Some("device-1"));
            0
        }
    };
    assert_eq!(calls.load(Ordering::SeqCst), calls_before);

    harness.engine.stop_interrupt_hands().await;
    match hand {
        StoppedHand::OwedLimit => harness.engine.hand_owed_limit_interrupts(harness.run_id),
        StoppedHand::PendingAtRestart => {
            harness
                .service
                .hand_pending_interrupts_again(harness.run_id);
        }
    }
    tokio::time::sleep(DRIVER_HOLD).await;

    assert_eq!(calls.load(Ordering::SeqCst), calls_before);
    assert_eq!(harness.holds_taken.load(Ordering::SeqCst), 0);
}

/// The engine's interrupt hand a test holds in its driver when the daemon's stop comes.
#[derive(Clone, Copy, Debug)]
enum HeldHand {
    /// The restart's hand of a person's interrupt pending at the restart.
    PendingAtRestart,
    /// The engine's stop of a run at its token limit.
    LimitStop,
    /// The interventions service's hand of a limit's interrupt.
    LimitHand,
}

// The daemon's stop cuts an interrupt hand held in its driver within a second, whichever hand it
// is: the restart's, the engine's limit stop, which then answers that no interventions service
// interrupts the run, and the service's limit hand, which answers its row pending as a hand the
// stop cut, well within its own bound. Killed by a bare spawn kept in any of the three (the
// stop's wait returns with the hand still held, or the caller's answer waits on the hand's own
// bound), by the token not selected (the stop's wait never returns), and by a cut read as a hand
// run to its end (the service's limit hand answers a hand past its bound).
#[rstest]
#[case::the_restarts_hand(HeldHand::PendingAtRestart)]
#[case::the_engines_limit_stop(HeldHand::LimitStop)]
#[case::the_services_limit_hand(HeldHand::LimitHand)]
#[tokio::test]
async fn the_stop_cuts_an_interrupt_hand_held_in_its_driver(#[case] hand: HeldHand) {
    let (driver, reaching) = driver_holding_its_interrupt();
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    let (engine, service, run_id) = (
        Arc::clone(&harness.engine),
        Arc::clone(&harness.service),
        harness.run_id,
    );
    // Whether the caller's answer reads as the stop cut it, for a hand a caller waits on.
    let answer = match hand {
        HeldHand::PendingAtRestart => {
            harness.record_pending_interrupt("accepted", PENDING_PERSON_RECORD, Some("device-1"));
            service.hand_pending_interrupts_again(run_id);
            None
        }
        HeldHand::LimitStop => Some(tokio::spawn(async move {
            let token_limit =
                TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer"));
            matches!(
                engine.stop_at_token_limit(run_id, token_limit).await,
                Err(RunEngineError::LimitInterrupterGone { .. })
            )
        })),
        HeldHand::LimitHand => Some(tokio::spawn(async move {
            matches!(
                service
                    .interrupt_for_limit(run_id, RunLimit::TokenLimit, None)
                    .await,
                Err(LimitInterruptFailure::RowPending { source })
                    if source.downcast_ref::<HandCanceled>().is_some()
            )
        })),
    };
    tokio::time::timeout(SETTLE_WAIT, reaching)
        .await
        .expect("the hand reaches the driver")
        .expect("the driver signals its call");

    tokio::time::timeout(HAND_CUT_BOUND, harness.engine.stop_interrupt_hands())
        .await
        .expect("the stop cuts the held hand within a second");

    if let Some(answer) = answer {
        let is_cut = tokio::time::timeout(HAND_CUT_BOUND, answer)
            .await
            .expect("the caller answers once the hand is cut")
            .expect("the caller's task ends");
        assert!(is_cut, "the caller's answer reads as the stop cut it");
    }
}

// A hand asked for once the daemon's stop has ended the interrupt hands answers no task and never
// runs. Killed by the closed check removed (a task is answered).
#[tokio::test]
async fn a_hand_asked_for_after_the_stop_never_runs() {
    let harness = harness(MockProviderDriver::new()).await;
    harness.engine.stop_interrupt_hands().await;
    let has_run = Arc::new(AtomicBool::new(false));

    let hand = harness.engine.hand_interrupt(harness.run_id, {
        let has_run = Arc::clone(&has_run);
        async move { has_run.store(true, Ordering::SeqCst) }
    });
    tokio::time::sleep(DRIVER_HOLD).await;

    assert!(
        hand.is_none(),
        "no task is answered once the hands are stopped"
    );
    assert!(!has_run.load(Ordering::SeqCst), "the hand never runs");
}

// A limit's hand the daemon's stop let none start wrote no row, so it answers a failure that
// leaves none, on which the engine's stop withdraws its cut. Killed by an unstarted hand read as
// its row pending (the cut would be kept with no row naming it).
#[tokio::test]
async fn a_limit_hand_never_started_answers_no_row() {
    let harness = harness(MockProviderDriver::new()).await;
    harness.engine.stop_interrupt_hands().await;

    let handed = harness
        .service
        .interrupt_for_limit(harness.run_id, RunLimit::TokenLimit, None)
        .await;

    assert!(
        matches!(handed, Err(LimitInterruptFailure::NoRow { .. })),
        "{handed:?}"
    );
    assert!(harness.stored_rows().is_empty(), "no row is written");
}

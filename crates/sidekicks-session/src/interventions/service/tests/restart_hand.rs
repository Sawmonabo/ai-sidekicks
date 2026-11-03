//! The interrupts a restart found pending, a person's and a limit's, handed again over the
//! harness's running run.

use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;

use super::{Harness, applied, harness};
use crate::run::engine::test_fixture::stored_run_state;

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

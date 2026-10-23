//! Hands: each takes its place on the chain before its call returns, none sends again a message
//! settled after its read, a tool boundary never makes the provider's reader wait, and an
//! interrupt's hold stops every hand queued behind it and waits out one in flight.

use std::pin::pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use super::{
    HANDS_AT_ONCE, HANDS_AT_TOOL_BOUNDARY, WAIT, applied, continued_ids, count_steers,
    driver_handing, fixture, hand, hold_chain, insert_item, intervention_id, release_chain,
    set_run_state, settle, steered_item, stored_item,
};
use crate::ipc::handlers::driver::resolution::read_run_driver;
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::message_handing::{HandMoment, MessageHanding};
use crate::provider::driver::run_control::RunToolBoundary;
use crate::queue::delivery::{DeliveryError, InterruptHoldRelease};
use crate::queue::store::{QueueItemRecord, RecordedQueueItemState};

// A handed message its provider refused reads not delivered with the hook's words, and its hand is
// let go, so a retry sends it again. Killed by keeping the hand.
#[tokio::test]
async fn a_handed_message_refused_reads_not_delivered_with_its_words_and_lets_its_hand_go() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;
    let reason = QueueItemNotDeliveredReason::RefusedByHook {
        words: FreeFormText::new("No secrets in prompts".to_owned()).expect("the hook's words"),
    };

    fixture
        .delivery
        .refuse_handed(fixture.session_id, item.id.text().as_str(), reason.clone());
    settle(&fixture).await;
    let next = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;

    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::NotDelivered { reason }
    );
    assert!(!fixture.delivery.is_handed(&item.id));
    assert!(fixture.delivery.is_handed(&next.id));
    assert_eq!(steers.load(Ordering::SeqCst), 2);
}

// Killed by a hand that joins the chain from a task of its own: a gate joined as soon as the
// hand's call returns then runs ahead of the hand.
#[tokio::test]
async fn a_hand_takes_its_place_on_the_chain_before_its_call_returns() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steered = record_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    hand(&fixture).await;
    let seen = Arc::clone(&steered);
    let mut gate = pin!(
        fixture
            .delivery
            .run_between_hands(fixture.session_id, async move { steers_of(&seen) })
    );
    assert!(futures::poll!(&mut gate).is_pending());
    release_chain(release, holder).await;
    let steered_before_the_gate = timeout(WAIT, gate).await.expect("the gate gets its turn");

    assert_eq!(steered_before_the_gate, [(item.id, false)]);
}

// A provider's event reader asking for a tool boundary's hand is answered while the session lock
// is held, and the hand goes once the lock is free. Killed by taking the session lock in the call.
#[tokio::test]
async fn a_tool_boundary_answers_its_caller_while_the_session_lock_is_held() {
    let mut driver = driver_handing(HANDS_AT_TOOL_BOUNDARY);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    let boundary = RunToolBoundary {
        session_id: fixture.session_id,
        run_id: fixture.run_id,
    };

    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    let answered = timeout(WAIT, fixture.delivery.on_tool_boundary(boundary)).await;
    let steers_under_the_lock = steers.load(Ordering::SeqCst);
    drop(hold);
    let tasks = &fixture.delivery.shared.tasks;
    tasks.close();
    timeout(WAIT, tasks.wait())
        .await
        .expect("the boundary's hand ends");

    answered
        .expect("the call answers while the lock is held")
        .expect("the boundary's driver is read");
    assert_eq!(steers_under_the_lock, 0);
    assert_eq!(steers.load(Ordering::SeqCst), 1);
}

// A hand queued behind the chain to a run an interrupt then holds makes no driver call, and its
// message waits unhanded for the interrupt's choice. Killed by dropping the job's re-check of
// the hold before the driver call.
#[tokio::test]
async fn a_hand_to_a_run_held_for_an_interrupt_makes_no_driver_call() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        fixture
            .delivery
            .hand_waiting(&hold, fixture.run_id)
            .await
            .expect("the hand is queued");
        timeout(
            WAIT,
            fixture
                .delivery
                .hold_for_interrupt(&hold, fixture.run_id, intervention_id()),
        )
        .await
        .expect("no hand is inside its driver call");
    }
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert_eq!(steers.load(Ordering::SeqCst), 0);
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(!fixture.delivery.is_handed(&item.id));
}

// A second interrupt failing while the first is unanswered lets go of its own hold only: the run
// stays held, so a hand to it makes no driver call, until the first lets go. Killed by holds kept
// per run, which the second's release would end.
#[tokio::test]
async fn a_second_interrupt_failing_keeps_the_first_ones_hold() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    let (first, second) = (intervention_id(), intervention_id());
    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        for intervention_id in [first, second] {
            timeout(
                WAIT,
                fixture
                    .delivery
                    .hold_for_interrupt(&hold, fixture.run_id, intervention_id),
            )
            .await
            .expect("no hand is inside its driver call");
        }
    }

    let second_released = fixture
        .delivery
        .release_interrupt_hold(fixture.run_id, second);
    hand(&fixture).await;
    settle(&fixture).await;
    let steers_while_held = steers.load(Ordering::SeqCst);
    let first_released = fixture
        .delivery
        .release_interrupt_hold(fixture.run_id, first);

    assert_eq!(second_released, InterruptHoldRelease::StillHeld);
    assert_eq!(steers_while_held, 0);
    assert_eq!(first_released, InterruptHoldRelease::Released);
}

// A tool boundary's steer queued behind the chain to a run an interrupt then holds makes no driver
// call, since the provider drops a steer when its turn is aborted; the message waits unhanded and
// the run's continue reads it. Killed by dropping the boundary job's re-check of the hold.
#[tokio::test]
async fn a_tool_boundary_to_a_run_held_for_an_interrupt_leaves_the_message_for_the_continue() {
    let mut driver = driver_handing(HANDS_AT_TOOL_BOUNDARY);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    let deps = &fixture.delivery.shared.deps;
    let driver = read_run_driver::<DeliveryError>(&deps.pool, &deps.providers, fixture.run_id)
        .await
        .expect("the run's driver is read");
    let (release, holder) = hold_chain(&fixture).await;

    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        fixture
            .delivery
            .hand_at_boundary(&hold, fixture.run_id, driver, HANDS_AT_TOOL_BOUNDARY)
            .await
            .expect("the boundary's steer is queued");
        timeout(
            WAIT,
            fixture
                .delivery
                .hold_for_interrupt(&hold, fixture.run_id, intervention_id()),
        )
        .await
        .expect("no steer is inside its driver call");
    }
    release_chain(release, holder).await;
    settle(&fixture).await;
    let is_handed = fixture.delivery.is_handed(&item.id);
    set_run_state(&fixture, RunState::Interrupted);
    let continued = continued_ids(&fixture).await;

    assert_eq!(steers.load(Ordering::SeqCst), 0);
    assert!(!is_handed);
    assert_eq!(continued, vec![item.id]);
}

// An interrupt's hold waits out a hand already inside its driver call, a tool boundary's included,
// and answers once that call returns. Killed by not waiting for the hand in flight, or by a hand
// that never marks its run in flight.
#[rstest]
#[case::a_hand(HANDS_AT_ONCE)]
#[case::a_tool_boundary(HANDS_AT_TOOL_BOUNDARY)]
#[tokio::test]
async fn an_interrupt_hold_waits_out_a_hand_inside_its_driver_call(
    #[case] handing: MessageHanding,
) {
    let (driver, mut steered, release_steer) = driver_holding_first_steer(handing);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    match handing.hands_at {
        HandMoment::AtOnce => hand(&fixture).await,
        HandMoment::AtToolBoundary => fixture
            .delivery
            .on_tool_boundary(RunToolBoundary {
                session_id: fixture.session_id,
                run_id: fixture.run_id,
            })
            .await
            .expect("the boundary's driver is read"),
    }
    timeout(WAIT, steered.recv())
        .await
        .expect("the hand steers");

    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    let mut holding = pin!(fixture.delivery.hold_for_interrupt(
        &hold,
        fixture.run_id,
        intervention_id()
    ));
    let early = timeout(Duration::from_millis(100), &mut holding).await;
    release_steer
        .send(())
        .expect("the steer waits to be released");
    let settled = timeout(WAIT, holding).await;

    assert!(
        early.is_err(),
        "the hold waits while the steer is in flight"
    );
    assert!(settled.is_ok(), "the hold answers once the steer returns");
}

// The delivery's stop waits out a hand inside its driver call and answers once that call returns.
// Killed by a stop that does not wait for the chains' tasks.
#[tokio::test]
async fn a_stop_waits_out_a_hand_inside_its_driver_call() {
    let (driver, mut steered, release_steer) = driver_holding_first_steer(HANDS_AT_ONCE);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    hand(&fixture).await;
    timeout(WAIT, steered.recv())
        .await
        .expect("the hand steers");

    fixture.delivery.close();
    let mut stopping = pin!(fixture.delivery.wait());
    let early = timeout(Duration::from_millis(100), &mut stopping).await;
    release_steer
        .send(())
        .expect("the steer waits to be released");
    let stopped = timeout(WAIT, stopping).await;

    assert!(
        early.is_err(),
        "the stop waits while the steer is in flight"
    );
    assert!(stopped.is_ok(), "the stop answers once the steer returns");
}

// A message the provider records as taken between a hand's read of the waiting messages and its
// hand, its outcome written and its hand forgotten in that window, is not handed again: the hand
// reads the messages again. Killed by handing from the read made before the hand was forgotten
// (the message is steered twice).
#[tokio::test]
async fn a_message_settled_after_the_hands_read_is_not_handed_again() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = record_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item_id = insert_item(&fixture).await.id;
    hand(&fixture).await;
    settle(&fixture).await;
    let reader = fixture.database.reader();
    let delivery = fixture.delivery.clone();
    fixture.openings.after_next_read(move || {
        reader
            .execute(
                "UPDATE queue_items SET state = 'admitted' WHERE id = ?1",
                [item_id.text().as_str()],
            )
            .expect("the test records the message taken");
        delivery.forget(&[item_id]);
    });

    hand(&fixture).await;
    settle(&fixture).await;

    assert_eq!(steers_of(&steers), [(item_id, false)]);
}

// A message sent now whose priority steer ends, its hand forgotten, between the read of the
// messages waiting behind it and their hand is not handed again with them: the priority hand is
// marked under the same hold of the state as the rest, after the read. Killed by marking the
// priority hand before that read (the message is steered again after its priority steer).
#[tokio::test]
async fn a_message_sent_now_freed_after_the_read_is_not_handed_with_the_rest() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = record_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = QueueItemRecord {
        sent_now_id: Some(intervention_id()),
        ..insert_item(&fixture).await
    };
    let delivery = fixture.delivery.clone();
    let item_id = item.id;
    fixture
        .openings
        .after_next_read(move || delivery.forget(&[item_id]));

    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        fixture
            .delivery
            .hand_first(&hold, fixture.run_id, item)
            .await
            .expect("the message is handed first");
    }
    settle(&fixture).await;

    assert_eq!(steers_of(&steers), [(item_id, true)]);
}

/// Answers every steer as sent and records each one's message and whether it went priority.
fn record_steers(driver: &mut MockProviderDriver) -> Arc<Mutex<Vec<(QueueItemId, bool)>>> {
    let steers = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&steers);
    driver.expect_apply_intervention().returning(move |params| {
        recorded
            .lock()
            .expect("the steers are recorded")
            .push(steered_item(&params));
        async { Ok(applied()) }.boxed()
    });
    steers
}

fn steers_of(steers: &Mutex<Vec<(QueueItemId, bool)>>) -> Vec<(QueueItemId, bool)> {
    steers.lock().expect("the steers are readable").clone()
}

/// A driver handing as `handing` that reports each steer's message and holds the first steer
/// inside its call until the returned sender is sent.
fn driver_holding_first_steer(
    handing: MessageHanding,
) -> (
    MockProviderDriver,
    mpsc::UnboundedReceiver<QueueItemId>,
    oneshot::Sender<()>,
) {
    let (called, steered) = mpsc::unbounded_channel();
    let (release_steer, steer_released) = oneshot::channel::<()>();
    let steer_released = Mutex::new(Some(steer_released));
    let mut driver = driver_handing(handing);
    driver.expect_apply_intervention().returning(move |params| {
        called
            .send(steered_item(&params).0)
            .expect("the test reads each steer");
        let released = steer_released
            .lock()
            .expect("the steer's release is readable")
            .take();
        async move {
            if let Some(released) = released {
                released.await.expect("the test releases the steer");
            }
            Ok(applied())
        }
        .boxed()
    });
    (driver, steered, release_steer)
}

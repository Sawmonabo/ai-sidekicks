//! Hands: they reach the driver in call order, a tool boundary never makes the provider's reader
//! wait, and an interrupt's hold stops every hand queued behind it and waits out one in flight.

use std::pin::pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::run::state::RunState;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use super::{
    HANDS_AT_ONCE, HANDS_AT_TOOL_BOUNDARY, WAIT, applied, count_steers, driver_handing, fixture,
    hand, hold_chain, insert_item, release_chain, set_run_state, settle, steered_item, stored_item,
};
use crate::ipc::handlers::driver::resolution::read_run_driver;
use crate::provider::driver::run_control::RunToolBoundary;
use crate::queue::delivery::DeliveryError;
use crate::queue::store::RecordedQueueItemState;
use crate::session::run::pause::ContinuedMessages;

// Killed by spawning a task per hand that takes the session's keyed lock: the worker's last-woken
// task runs first, so the second message is steered first.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn hands_reach_the_driver_in_call_order() {
    let steered = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&steered);
    let mut driver = driver_handing(HANDS_AT_ONCE);
    driver.expect_apply_intervention().returning(move |params| {
        recorded
            .lock()
            .expect("the steers are recorded")
            .push(steered_item(&params));
        async { Ok(applied()) }.boxed()
    });
    let fixture = Arc::new(fixture(driver).await);
    let (release, holder) = hold_chain(&fixture).await;

    let sender = Arc::clone(&fixture);
    let sent = tokio::spawn(async move {
        let first = insert_item(&sender).await;
        hand(&sender).await;
        let second = insert_item(&sender).await;
        hand(&sender).await;
        [first.id, second.id]
    });
    let sent = timeout(WAIT, sent)
        .await
        .expect("both hands join the chain")
        .expect("the sending task does not panic");
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert_eq!(
        *steered.lock().expect("the steers are readable"),
        sent.to_vec()
    );
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

    let hold = fixture.session_lock.acquire(fixture.session_id).await;
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
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
        fixture
            .delivery
            .hand_waiting(&hold, fixture.run_id)
            .await
            .expect("the hand is queued");
        timeout(
            WAIT,
            fixture.delivery.hold_for_interrupt(&hold, fixture.run_id),
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
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
        fixture
            .delivery
            .hand_at_boundary(&hold, fixture.run_id, driver, HANDS_AT_TOOL_BOUNDARY)
            .await
            .expect("the boundary's steer is queued");
        timeout(
            WAIT,
            fixture.delivery.hold_for_interrupt(&hold, fixture.run_id),
        )
        .await
        .expect("no steer is inside its driver call");
    }
    release_chain(release, holder).await;
    settle(&fixture).await;
    let is_handed = fixture.delivery.is_handed(&item.id);
    set_run_state(&fixture, RunState::Interrupted);
    let continued = ContinuedMessages::read(&fixture.delivery, fixture.run_id)
        .await
        .expect("the continue reads the waiting messages");

    assert_eq!(steers.load(Ordering::SeqCst), 0);
    assert!(!is_handed);
    assert_eq!(
        continued
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>(),
        vec![item.id]
    );
}

// An interrupt's hold waits out a hand already inside its driver call and answers once that call
// returns. Killed by not waiting for the hand in flight.
#[tokio::test]
async fn an_interrupt_hold_waits_out_a_hand_inside_its_driver_call() {
    let (called, mut steered) = mpsc::unbounded_channel();
    let (release_steer, steer_released) = oneshot::channel::<()>();
    let steer_released = Mutex::new(Some(steer_released));
    let mut driver = driver_handing(HANDS_AT_ONCE);
    driver.expect_apply_intervention().returning(move |params| {
        called
            .send(steered_item(&params))
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
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    hand(&fixture).await;
    timeout(WAIT, steered.recv())
        .await
        .expect("the hand steers");

    let hold = fixture.session_lock.acquire(fixture.session_id).await;
    let mut holding = pin!(fixture.delivery.hold_for_interrupt(&hold, fixture.run_id));
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

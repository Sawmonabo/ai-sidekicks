//! The undo's hold: every way a message reaches the provider sends nothing of a held session until
//! the release, a hand queued before the hold sends nothing, a hand inside its driver call is
//! waited out, and each undo holds under a hold of its own.

use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rstest::rstest;
use sidekicks_contracts::run::state::RunState;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_session::driver_resolution::read_run_driver;
use sidekicks_session::queue_store::{QueueItemRecord, RecordedQueueItemState};
use tokio::time::timeout;

use super::hands::driver_holding_first_steer;
use super::{
    Fixture, HANDS_AT_ONCE, HANDS_AT_TOOL_BOUNDARY, WAIT, continued_ids, count_steers,
    driver_handing, fixture, hand, hold_chain, insert_item, release_chain, set_run_state, settle,
    stored_item,
};
use crate::delivery::{DeliveryError, UndoHoldId};

/// A way a waiting message reaches its provider.
#[derive(Clone, Copy, Debug)]
enum Way {
    /// A send into a run waiting on input, kept for its next turn.
    AcceptSend,
    /// A hand of the run's waiting messages.
    HandWaiting,
    /// A steer at a tool boundary of the run's turn.
    ToolBoundary,
    /// A `Send now` handed ahead of the rest.
    HandFirst,
    /// A paused run's continue reading its waiting messages.
    Continue,
}

/// Holds the fixture's session under a fresh undo hold and answers it, failing the test if the
/// hold waits.
async fn hold_for_undo(fixture: &Fixture) -> UndoHoldId {
    let hold_id = fixture.delivery.mint_undo_hold_id();
    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    timeout(WAIT, fixture.delivery.hold_for_undo(&hold, hold_id))
        .await
        .expect("no hand is inside its driver call");
    hold_id
}

/// Sends `item` to its provider the way `way` does and answers whether it reached the provider:
/// marked handed while the chain is held, so a hand the chain's own check would drop still counts,
/// or steered, kept for the run's next turn, or read by the continue.
async fn reaches(
    fixture: &Fixture,
    way: Way,
    item: &QueueItemRecord,
    steers: &AtomicUsize,
) -> bool {
    match way {
        Way::AcceptSend => {
            let hold = fixture.session_lock.hold_session(fixture.session_id).await;
            fixture
                .delivery
                .accept_send(&hold, item, fixture.run_id)
                .await
                .expect("the send is taken");
            return fixture
                .delivery
                .lock_state()
                .next_turn_runs
                .contains_key(&item.id);
        }
        Way::Continue => return continued_ids(fixture).await.contains(&item.id),
        Way::HandWaiting | Way::ToolBoundary | Way::HandFirst => {}
    }
    let (release, holder) = hold_chain(fixture).await;
    match way {
        Way::HandWaiting => hand(fixture).await,
        Way::ToolBoundary => {
            let deps = &fixture.delivery.shared.deps;
            let driver =
                read_run_driver::<DeliveryError>(&deps.pool, &deps.providers, fixture.run_id)
                    .await
                    .expect("the run's driver is read");
            let hold = fixture.session_lock.hold_session(fixture.session_id).await;
            fixture
                .delivery
                .hand_at_boundary(&hold, fixture.run_id, driver, HANDS_AT_TOOL_BOUNDARY)
                .await
                .expect("the boundary's steer is queued");
        }
        Way::HandFirst => {
            let hold = fixture.session_lock.hold_session(fixture.session_id).await;
            fixture
                .delivery
                .hand_first(&hold, fixture.run_id, item.clone())
                .await
                .expect("the message is handed first");
        }
        Way::AcceptSend | Way::Continue => {}
    }
    let is_handed = fixture.delivery.is_handed(&item.id);
    release_chain(release, holder).await;
    settle(fixture).await;
    is_handed || steers.load(Ordering::SeqCst) > 0
}

// While an undo holds the session, no way a message reaches the provider sends it: no steer, no
// mark for the next turn, no continue's read; once the hold goes, the same way sends it. Killed by
// dropping the hold's read from `accept_send`, from `hand_first`, from the read of the unhanded
// messages that hands and tool boundaries share, or from the continue's read.
#[rstest]
#[case::a_send_into_a_run_waiting_on_input(Way::AcceptSend)]
#[case::a_hand(Way::HandWaiting)]
#[case::a_tool_boundary(Way::ToolBoundary)]
#[case::a_send_now(Way::HandFirst)]
#[case::a_continue(Way::Continue)]
#[tokio::test]
async fn nothing_of_a_session_held_for_an_undo_reaches_its_provider_until_the_release(
    #[case] way: Way,
) {
    let handing = match way {
        Way::ToolBoundary => HANDS_AT_TOOL_BOUNDARY,
        Way::AcceptSend | Way::HandWaiting | Way::HandFirst | Way::Continue => HANDS_AT_ONCE,
    };
    let mut driver = driver_handing(handing);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    match way {
        Way::AcceptSend => set_run_state(&fixture, RunState::WaitingForInput),
        Way::Continue => set_run_state(&fixture, RunState::Paused),
        Way::HandWaiting | Way::ToolBoundary | Way::HandFirst => {}
    }
    let item = insert_item(&fixture).await;
    let hold_id = hold_for_undo(&fixture).await;

    let reached_while_held = reaches(&fixture, way, &item, &steers).await;
    let is_released = fixture
        .delivery
        .release_undo_hold(fixture.session_id, hold_id)
        .is_some();
    let reached_after = reaches(&fixture, way, &item, &steers).await;

    assert!(!reached_while_held, "the held session's message stays");
    assert!(is_released);
    assert!(reached_after, "the released session's message goes");
}

// A hand or a tool boundary's steer queued on the chain before the undo's hold sends nothing once
// it runs, and its message waits unhanded for the release; the hold does not wait for the queued
// job. Killed by dropping the hold's read from the chain's hand or boundary job.
#[rstest]
#[case::a_hand(HANDS_AT_ONCE)]
#[case::a_tool_boundary(HANDS_AT_TOOL_BOUNDARY)]
#[tokio::test]
async fn a_hand_queued_before_an_undos_hold_sends_nothing(#[case] handing: MessageHanding) {
    let mut driver = driver_handing(handing);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;
    {
        let hold = fixture.session_lock.hold_session(fixture.session_id).await;
        match handing.hands_at {
            HandMoment::AtOnce => fixture
                .delivery
                .hand_waiting(&hold, fixture.run_id)
                .await
                .expect("the hand is queued"),
            HandMoment::AtToolBoundary => {
                let deps = &fixture.delivery.shared.deps;
                let driver =
                    read_run_driver::<DeliveryError>(&deps.pool, &deps.providers, fixture.run_id)
                        .await
                        .expect("the run's driver is read");
                fixture
                    .delivery
                    .hand_at_boundary(&hold, fixture.run_id, driver, HANDS_AT_TOOL_BOUNDARY)
                    .await
                    .expect("the boundary's steer is queued");
            }
        }
        timeout(
            WAIT,
            fixture
                .delivery
                .hold_for_undo(&hold, fixture.delivery.mint_undo_hold_id()),
        )
        .await
        .expect("the hold waits for no queued job");
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

// The undo's hold waits out a hand of the session already inside its driver call and answers once
// that call returns. Killed by a hold that does not wait for the hand in flight.
#[tokio::test]
async fn an_undos_hold_waits_out_a_hand_inside_its_driver_call() {
    let (driver, mut steered, release_steer) = driver_holding_first_steer(HANDS_AT_ONCE);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    hand(&fixture).await;
    timeout(WAIT, steered.recv())
        .await
        .expect("the hand steers");

    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    let mut holding = pin!(
        fixture
            .delivery
            .hold_for_undo(&hold, fixture.delivery.mint_undo_hold_id())
    );
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

// Two undos hold one session each under its own hold: the first's release keeps the session held,
// so a hand sends nothing, the second's lets it go, and a release again of the same hold changes
// nothing. Killed by one hold per session, which the first release would end.
#[tokio::test]
async fn a_session_two_undos_hold_stays_held_until_both_let_go() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers: Arc<AtomicUsize> = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    insert_item(&fixture).await;
    let first = hold_for_undo(&fixture).await;
    let second = hold_for_undo(&fixture).await;

    let first_released = fixture
        .delivery
        .release_undo_hold(fixture.session_id, first)
        .is_some();
    hand(&fixture).await;
    settle(&fixture).await;
    let steers_while_held = steers.load(Ordering::SeqCst);
    let second_released = fixture
        .delivery
        .release_undo_hold(fixture.session_id, second)
        .is_some();
    let released_again = fixture
        .delivery
        .release_undo_hold(fixture.session_id, second)
        .is_some();

    assert!(!first_released);
    assert_eq!(steers_while_held, 0);
    assert!(second_released);
    assert!(!released_again);
    assert!(!fixture.delivery.is_held_for_undo(fixture.session_id));
}

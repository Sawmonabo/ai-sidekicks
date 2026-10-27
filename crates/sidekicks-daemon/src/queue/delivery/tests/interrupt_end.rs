//! The interrupt's end: by its choice it cancels, places or leaves the messages the provider no
//! longer holds, and keeps handed the ones it does.

use std::sync::Arc;

use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use tokio::time::timeout;

use super::{
    Fixture, HANDS_AT_ONCE, WAIT, continued_ids, count_steers, driver_handing, fixture, hand,
    insert_item, item_ids, set_run_state, settle, stored_item,
};
use crate::delivery::InterruptEndWrites;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord, RecordedQueueItemState};
use sidekicks_store::events::session::appender::{SessionEventAppender, SessionEventLinkage};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

/// A run with three messages waiting: the first two handed to the provider, the third not.
async fn interrupted_fixture() -> (Fixture, [QueueItemRecord; 3]) {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let given_back = insert_item(&fixture).await;
    let still_handed = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;
    let unhanded = insert_item(&fixture).await;
    (fixture, [given_back, still_handed, unhanded])
}

/// The interrupt's end writes for `pending` and `deliver_first`, the provider giving back
/// `cancelled`, on the session's chain.
async fn end_writes(
    fixture: &Fixture,
    pending: InterruptPendingChoice,
    deliver_first: Option<QueueItemId>,
    cancelled: &[QueueItemId],
) -> InterruptEndWrites {
    timeout(
        WAIT,
        fixture.delivery.run_between_hands(
            fixture.session_id,
            fixture.delivery.interrupt_end_writes(
                fixture.run_id,
                pending,
                deliver_first,
                cancelled,
            ),
        ),
    )
    .await
    .expect("the chain gives the end its turn")
    .expect("the end's writes are built")
}

/// The first message given back with an id the provider was never handed.
fn given_back_with_an_unknown_id(given_back: &QueueItemRecord) -> [QueueItemId; 2] {
    let unknown = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    [given_back.id, unknown]
}

/// Commits `writes` as the run's end commits them: the item events, then the last one carrying
/// the row moves.
async fn commit(fixture: &Fixture, mut writes: InterruptEndWrites) {
    let draft = writes
        .preceding_events
        .pop()
        .expect("each cancel carries its event");
    SessionEventAppender::new(
        Arc::clone(&fixture.log.service),
        SESSION_EVENT_VERSION.clone(),
    )
    .append(
        draft,
        SessionEventLinkage {
            transactional_prelude: writes.statements,
            preceding_events: writes.preceding_events,
            ..SessionEventLinkage::default()
        },
    )
    .await
    .expect("the end's writes commit");
}

// `returnToDraft`: the writes, committed as the run's end commits them, cancel the message given
// back and the one never handed; the one the provider still holds stays waiting and handed.
// Killed by skipping the give-back or by keeping handed messages among those cancelled.
#[tokio::test]
async fn an_interrupt_to_the_draft_cancels_what_the_provider_does_not_hold() {
    let (fixture, [given_back, still_handed, unhanded]) = interrupted_fixture().await;

    let cancelled = given_back_with_an_unknown_id(&given_back);
    let writes = end_writes(
        &fixture,
        InterruptPendingChoice::ReturnToDraft,
        None,
        &cancelled,
    )
    .await;
    assert_eq!(item_ids(&writes.changed), vec![given_back.id, unhanded.id]);
    assert!(!writes.moves_order);
    commit(&fixture, writes).await;

    assert_eq!(
        stored_item(&fixture, given_back.id).state,
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        stored_item(&fixture, unhanded.id).state,
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        stored_item(&fixture, still_handed.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(fixture.delivery.is_handed(&still_handed.id));
}

// `nextTurn` with a message to deliver first: the writes put it ahead of the other message the
// provider no longer holds, in the places they hold, and move the queue's order. Killed by
// ignoring `deliver_first` or by not moving the order.
#[tokio::test]
async fn an_interrupt_to_the_next_turn_places_the_message_sent_now_first() {
    let (fixture, [given_back, still_handed, unhanded]) = interrupted_fixture().await;

    let cancelled = given_back_with_an_unknown_id(&given_back);
    let writes = end_writes(
        &fixture,
        InterruptPendingChoice::NextTurn,
        Some(unhanded.id),
        &cancelled,
    )
    .await;
    assert_eq!(item_ids(&writes.changed), vec![unhanded.id, given_back.id]);
    assert!(writes.moves_order);
    fixture
        .log
        .writer
        .write(writes.statements)
        .await
        .expect("the placement commits");

    let waiting = QueueItemReader::new(&fixture.database.reader())
        .list_waiting_for_run(&fixture.run_id)
        .expect("the test reads the waiting messages");
    assert_eq!(
        item_ids(&waiting),
        vec![unhanded.id, still_handed.id, given_back.id]
    );
}

// `keepWaiting`: nothing is written, the message given back waits unhanded, and once the run
// rests interrupted its continue reads the unhanded messages in queue order, the one the provider
// still holds left out. Killed by skipping the give-back or by reading a handed message.
#[tokio::test]
async fn an_interrupt_that_keeps_waiting_leaves_the_messages_for_the_continue() {
    let (fixture, [given_back, still_handed, unhanded]) = interrupted_fixture().await;

    let cancelled = given_back_with_an_unknown_id(&given_back);
    let writes = end_writes(
        &fixture,
        InterruptPendingChoice::KeepWaiting,
        None,
        &cancelled,
    )
    .await;
    let is_given_back_handed = fixture.delivery.is_handed(&given_back.id);
    set_run_state(&fixture, RunState::Interrupted);
    let continued = continued_ids(&fixture).await;

    assert!(writes.statements.is_empty());
    assert!(writes.preceding_events.is_empty());
    assert_eq!(writes.changed, []);
    assert_eq!(
        stored_item(&fixture, given_back.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(!is_given_back_handed);
    assert_eq!(continued, vec![given_back.id, unhanded.id]);
    assert!(fixture.delivery.is_handed(&still_handed.id));
}

// An interrupt before a starting run's first turn takes its opening message with the rest, as no
// turn answers it. Killed by leaving out the openings of a starting run.
#[tokio::test]
async fn an_interrupt_of_a_starting_run_takes_its_opening_with_the_rest() {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let opening = insert_item(&fixture).await;
    fixture
        .openings
        .openings
        .lock()
        .expect("the test's openings are writable")
        .insert(opening.id);
    set_run_state(&fixture, RunState::Starting);

    let writes = end_writes(&fixture, InterruptPendingChoice::ReturnToDraft, None, &[]).await;

    assert_eq!(item_ids(&writes.changed), vec![opening.id]);
}

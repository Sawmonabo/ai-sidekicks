//! The run queue as an interrupt uses it: `Send now` on a provider that reads a priority message,
//! in each run state, sent again under its key, and an interrupt's release from inside the
//! session's hold.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, client_key, fixture, recording_driver};
use crate::interventions::interrupt_queue::{
    InterruptChoice, InterruptQueue, SendNow, SendNowOutcome,
};
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::provider::driver::test_registry::bind_run_to_first_provider;
use crate::queue::store::QueueItemReader;
use crate::uuid_v7::mint_uuid_v7;

fn new_intervention_id() -> InterventionId {
    InterventionId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an intervention id")
}

impl Fixture {
    /// Asks the queue to send `item_id` now on `run_id`, read at version 1, under `key`, and
    /// answers the id the message's mark records.
    async fn send_now(
        &self,
        run_id: RunId,
        item_id: QueueItemId,
        key: &ClientUuid,
        intervention_id: InterventionId,
    ) -> InterventionId {
        let outcome = self
            .queue
            .send_now(SendNow {
                run_id,
                expected_run_version: SafeInt::new(1).expect("a test version"),
                item_id,
                key: key.clone(),
                intervention_id,
            })
            .await
            .expect("the queue answers");
        let SendNowOutcome::Sent { intervention_id } = outcome else {
            panic!("the message is sent now, got {outcome:?}");
        };
        intervention_id
    }

    /// Hands `run_id` what waits for it, as its next hand moment does.
    async fn hand_waiting(&self, run_id: RunId) {
        let hold = self.queue.session_lock.acquire(self.session_id).await;
        self.queue
            .delivery
            .hand_waiting(&hold, run_id)
            .await
            .expect("the run is handed what waits for it");
    }

    /// The key the message's `Send now` mark records.
    fn sent_now_key(&self, item_id: QueueItemId) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT send_now_key FROM queue_items WHERE id = ?1",
                [item_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the message's mark")
    }

    /// The lead messages waiting for `run_id`, in the queue's order.
    fn waiting_order(&self, run_id: RunId) -> Vec<QueueItemId> {
        QueueItemReader::new(&self.database.reader())
            .list_waiting_for_run(&run_id)
            .expect("the test reads the run's queue")
            .into_iter()
            .map(|item| item.id)
            .collect()
    }
}

// `Send now` of B among A, B and C, all three handed, on a run that takes a message now takes
// every row back, hands B first marked priority and the rest after it in their order, B, A, C, and
// marks B with the request's key; a person's card open takes B alone, A and C waiting for the
// card's answer. Killed by taking back only the rows ahead of B (the provider reads B, C, A), by
// leaving a card open to an interrupt, or by not marking B.
#[rstest]
#[case::running("running", true)]
#[case::waiting_for_approval("waitingForApproval", true)]
#[case::waiting_for_input("waitingForInput", false)]
#[tokio::test]
async fn send_now_hands_the_message_first_and_the_rest_in_order(
    #[case] state: &str,
    #[case] takes_all: bool,
) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run(state);
    bind_run_to_first_provider(&fixture.database, run_id);
    let first = fixture.queue_message(run_id).await;
    let sent_now = fixture.queue_message(run_id).await;
    let last = fixture.queue_message(run_id).await;
    fixture.hand_waiting(run_id).await;
    fixture.queue.stop().await;
    let key = client_key();
    let intervention_id = new_intervention_id();

    let marked_id = fixture
        .send_now(run_id, sent_now, &key, intervention_id)
        .await;
    fixture.queue.stop().await;

    assert_eq!(marked_id, intervention_id);
    let expected = if takes_all {
        vec![
            (first, false),
            (sent_now, false),
            (last, false),
            (sent_now, true),
            (first, false),
            (last, false),
        ]
    } else {
        vec![(sent_now, true)]
    };
    assert_eq!(calls.steers(), expected);
    assert_eq!(
        fixture.sent_now_key(sent_now).as_deref(),
        Some(key.as_str())
    );
}

/// Why a run takes no message at the `Send now`.
#[derive(Clone, Copy, Debug)]
enum NotTaking {
    /// The run reads this state.
    State(&'static str),
    /// A person's interrupt holds the running run.
    HeldForInterrupt,
    /// The message waits for another run than the one interrupted.
    OtherRun,
}

// `Send now` on a run that takes no message now neither steers nor interrupts: the message reads
// sent now, marked with the key and first in the queue, and its run's next hand gives it first
// marked priority, then the rest. Killed by an interrupt or a steer made at once, by the mark
// dropped, or by a next hand in the plain order.
#[rstest]
#[case::starting(NotTaking::State("starting"))]
#[case::pausing(NotTaking::State("pausing"))]
#[case::paused(NotTaking::State("paused"))]
#[case::held_for_interrupt(NotTaking::HeldForInterrupt)]
#[case::other_run(NotTaking::OtherRun)]
#[tokio::test]
async fn send_now_keeps_the_message_first_for_a_run_that_takes_none_now(
    #[case] not_taking: NotTaking,
) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let (interrupted_run_id, run_id) = match not_taking {
        NotTaking::State(state) => {
            let run_id = fixture.insert_run(state);
            (run_id, run_id)
        }
        NotTaking::HeldForInterrupt => {
            let run_id = fixture.insert_run("running");
            (run_id, run_id)
        }
        NotTaking::OtherRun => {
            let interrupted_run_id = fixture.insert_run("running");
            bind_run_to_first_provider(&fixture.database, interrupted_run_id);
            (interrupted_run_id, fixture.insert_run("queued"))
        }
    };
    bind_run_to_first_provider(&fixture.database, run_id);
    let ahead = fixture.queue_message(run_id).await;
    let sent_now = fixture.queue_message(run_id).await;
    let interrupt_id = new_intervention_id();
    if matches!(not_taking, NotTaking::HeldForInterrupt) {
        let hold = fixture.queue.session_lock.acquire(fixture.session_id).await;
        fixture
            .queue
            .delivery
            .hold_for_interrupt(&hold, run_id, interrupt_id)
            .await;
    }
    let key = client_key();

    fixture
        .send_now(interrupted_run_id, sent_now, &key, new_intervention_id())
        .await;
    fixture.queue.stop().await;

    assert!(calls.steers().is_empty(), "{:?}", calls.steers());
    assert_eq!(
        fixture.sent_now_key(sent_now).as_deref(),
        Some(key.as_str())
    );
    assert_eq!(fixture.waiting_order(run_id), [sent_now, ahead]);

    fixture.set_run_state(run_id, "running");
    fixture
        .queue
        .delivery
        .release_interrupt_hold(run_id, interrupt_id);
    fixture.hand_waiting(run_id).await;
    fixture.queue.stop().await;

    assert_eq!(calls.steers(), [(sent_now, true), (ahead, false)]);
}

// A `Send now` whose priority steer found its turn ended leaves the message marked but no longer
// with its provider, so the same request sent again under its key takes the rows back and hands
// it again, answering the first mark's id both times. Killed by a replay that answers sent from
// the mark alone, never reading whether the provider holds the message.
#[tokio::test]
async fn send_now_sent_again_after_its_hand_failed_hands_the_message_again() {
    let calls = Arc::new(DriverCalls::default());
    calls
        .dropped_priority_steers_left
        .store(1, Ordering::SeqCst);
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running");
    bind_run_to_first_provider(&fixture.database, run_id);
    let first = fixture.queue_message(run_id).await;
    let sent_now = fixture.queue_message(run_id).await;
    let last = fixture.queue_message(run_id).await;
    let key = client_key();
    let first_id = new_intervention_id();

    let first_answer = fixture.send_now(run_id, sent_now, &key, first_id).await;
    fixture.queue.stop().await;
    let second_answer = fixture
        .send_now(run_id, sent_now, &key, new_intervention_id())
        .await;
    fixture.queue.stop().await;

    assert_eq!((first_answer, second_answer), (first_id, first_id));
    let handed_in_order = [(sent_now, true), (first, false), (last, false)];
    assert_eq!(calls.steers(), [handed_in_order, handed_in_order].concat());
}

// An interrupt's release at a run's end, called while the session's queue is held as a run's end
// written under that hold calls it, answers without waiting for the hold; once the hold goes, the
// run's hold is let go and its waiting message handed. Killed by a release that takes the
// session's lock inline (the test times out), or by one that never settles.
#[tokio::test]
async fn a_release_from_inside_the_sessions_hold_settles_once_the_hold_goes() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running");
    bind_run_to_first_provider(&fixture.database, run_id);
    let item_id = fixture.queue_message(run_id).await;
    let intervention_id = new_intervention_id();
    let choice = InterruptChoice {
        pending: InterruptPendingChoice::KeepWaiting,
        deliver_first: None,
    };

    let is_held_inside = {
        let hold = fixture.queue.session_lock.acquire(fixture.session_id).await;
        fixture
            .queue
            .delivery
            .hold_for_interrupt(&hold, run_id, intervention_id)
            .await;
        timeout(
            WAIT,
            fixture
                .queue
                .release_interrupt_at_run_end(run_id, intervention_id, choice),
        )
        .await
        .expect("the release answers inside the hold")
        .expect("the release reads its run");
        fixture.queue.delivery.is_held_for_interrupt(run_id)
    };
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the release settles once the hold goes");

    assert!(is_held_inside, "the run stays held while the hold is");
    assert!(!fixture.queue.delivery.is_held_for_interrupt(run_id));
    assert_eq!(calls.steers(), [(item_id, false)]);
}

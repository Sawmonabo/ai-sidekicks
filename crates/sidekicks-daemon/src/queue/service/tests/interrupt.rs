//! The run queue as an interrupt uses it: `Send now` on a provider that reads a priority message,
//! in each run state, sent again under its key or another, and a reorder after it; an interrupt's
//! release from inside the session's hold, and one left unsettled, settled at a later hold.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{AgentQueueItemReorderRequest, QueueItemId};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, client_key, fixture, queue_over, recording_driver};
use crate::interventions::interrupt_queue::{
    InterruptChoice, InterruptQueue, SendNow, SendNowOutcome,
};
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::provider::driver::test_registry::bind_run_to_first_provider;
use crate::queue::service::RunQueue;
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
        let hold = self.queue.session_lock.hold_session(self.session_id).await;
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
// sent now, marked with the key and first in the queue, a second `Send now` of it under another
// key answers the first's id and keeps its mark, and its run's next hand gives it first marked
// priority, then the rest. Killed by an interrupt or a steer made at once, by the mark dropped or
// looked up by the request's key alone (the second is refused), or by a next hand in the plain
// order.
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
        let hold = fixture
            .queue
            .session_lock
            .hold_session(fixture.session_id)
            .await;
        fixture
            .queue
            .delivery
            .hold_for_interrupt(&hold, run_id, interrupt_id)
            .await;
    }
    let key = client_key();
    let first_id = new_intervention_id();

    fixture
        .send_now(interrupted_run_id, sent_now, &key, first_id)
        .await;
    let again_id = fixture
        .send_now(
            interrupted_run_id,
            sent_now,
            &client_key(),
            new_intervention_id(),
        )
        .await;
    fixture.queue.stop().await;

    assert_eq!(again_id, first_id);
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
        let hold = fixture
            .queue
            .session_lock
            .hold_session(fixture.session_id)
            .await;
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

impl Fixture {
    /// Writes a person's applied interrupt of `run_id` and answers its id.
    fn insert_interrupt(&self, run_id: RunId) -> InterventionId {
        let intervention_id = new_intervention_id();
        self.database
            .reader()
            .execute(
                "INSERT INTO interventions (id, target_run_id, type, state, payload,
                   expected_run_version, client_idempotency_key, created_at)
                 VALUES (?1, ?2, 'interrupt', 'applied', '{}', 1, ?1, ?3)",
                params![
                    intervention_id.text().as_str(),
                    run_id.text().as_str(),
                    WireInstant::now().as_str()
                ],
            )
            .expect("the test records the interrupt");
        intervention_id
    }

    /// The choice the interrupt's row records as left unsettled by its release.
    fn unreleased_choice(&self, intervention_id: InterventionId) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT unreleased_choice FROM interventions WHERE id = ?1",
                [intervention_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the interrupt's row")
    }

    /// A run queue built again over the fixture's record, as the daemon's next start builds it.
    fn restart(&self, driver: MockProviderDriver) -> Arc<RunQueue> {
        queue_over(&self.database, &self.log, &self.home, driver)
    }
}

/// When the queue settles again a release an interrupt left unsettled.
#[derive(Clone, Copy, Debug)]
enum SettledAgain {
    /// At the session's next hold, which a run's end takes.
    RunEnd,
    /// At the daemon's next start, which builds the queue again over the record.
    Restart,
}

// An interrupt's release that cannot hand its run what waits, the run bound to no provider yet,
// fails and records its choice on the interrupt's row; once the run is bound, a run's end taking
// the session's hold, or the queue's recovery after a restart, hands the message and clears the
// record. Killed by keeping the unsettled release in memory only (the restart never hands), by
// settling it only at the holds the queue's own calls take (the run's end never hands), or by
// never clearing the record.
#[rstest]
#[case::run_end(SettledAgain::RunEnd)]
#[case::restart(SettledAgain::Restart)]
#[tokio::test]
async fn a_release_left_unsettled_is_settled_at_a_later_hold(#[case] again: SettledAgain) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("running");
    let item_id = fixture.queue_message(run_id).await;
    let intervention_id = fixture.insert_interrupt(run_id);
    let choice = InterruptChoice {
        pending: InterruptPendingChoice::NextTurn,
        deliver_first: None,
    };
    fixture
        .queue
        .hold_for_interrupt(run_id, intervention_id, choice)
        .await
        .expect("the queue holds the run");

    fixture
        .queue
        .release_interrupt(run_id, intervention_id, choice)
        .await
        .expect_err("the release finds no driver to hand the run's message");
    let recorded = fixture.unreleased_choice(intervention_id);
    bind_run_to_first_provider(&fixture.database, run_id);
    match again {
        SettledAgain::RunEnd => {
            let ended_run_id = fixture.insert_run("completed");
            fixture.settle_end(ended_run_id).await;
        }
        SettledAgain::Restart => {
            fixture.queue.stop().await;
            let restarted = fixture.restart(recording_driver(&calls));
            let failures = timeout(WAIT, restarted.recover())
                .await
                .expect("the recovery answers")
                .expect("the recovery reads the sessions");
            timeout(WAIT, restarted.stop())
                .await
                .expect("the recovery's hand settles");
            assert!(failures.is_empty(), "{failures:?}");
        }
    }

    assert_eq!(recorded.as_deref(), Some("nextTurn"));
    assert_eq!(calls.steers(), [(item_id, false)]);
    assert_eq!(fixture.unreleased_choice(intervention_id), None);
}

/// Where a reorder puts a message `Send now` marked.
#[derive(Clone, Copy, Debug)]
enum MarkedPlace {
    /// First, where it was.
    KeptFirst,
    /// After another message.
    MovedOffFirst,
}

// A reorder after `Send now` is the person's latest order: one that moves the marked message off
// first place clears its mark in the same write, so it reads as no longer sent now and the run's
// next hand gives the messages in the new order with no priority; one that keeps it first keeps
// the mark and the priority hand. Killed by keeping the mark whatever the order (the provider
// reads the marked message first against the screen's order), or by clearing it on every reorder.
#[rstest]
#[case::kept_first(MarkedPlace::KeptFirst)]
#[case::moved_off_first(MarkedPlace::MovedOffFirst)]
#[tokio::test]
async fn a_reorder_after_send_now_keeps_the_mark_only_on_a_message_left_first(
    #[case] place: MarkedPlace,
) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let run_id = fixture.insert_run("paused");
    bind_run_to_first_provider(&fixture.database, run_id);
    let other = fixture.queue_message(run_id).await;
    let sent_now = fixture.queue_message(run_id).await;
    let key = client_key();
    fixture
        .send_now(run_id, sent_now, &key, new_intervention_id())
        .await;
    let order = match place {
        MarkedPlace::KeptFirst => vec![sent_now, other],
        MarkedPlace::MovedOffFirst => vec![other, sent_now],
    };

    fixture
        .queue
        .reorder(AgentQueueItemReorderRequest {
            session_id: fixture.session_id,
            child_handle: None,
            queue_item_ids: UniqueList::new(order.clone()).expect("the order names each once"),
        })
        .await
        .expect("the queue takes the order");
    let mark = fixture.sent_now_key(sent_now);
    fixture.set_run_state(run_id, "running");
    fixture.hand_waiting(run_id).await;
    fixture.queue.stop().await;

    assert_eq!(fixture.waiting_order(run_id), order);
    match place {
        MarkedPlace::KeptFirst => {
            assert_eq!(mark.as_deref(), Some(key.as_str()));
            assert_eq!(calls.steers(), [(sent_now, true), (other, false)]);
        }
        MarkedPlace::MovedOffFirst => {
            assert_eq!(mark, None);
            assert_eq!(calls.steers(), [(other, false), (sent_now, false)]);
        }
    }
}

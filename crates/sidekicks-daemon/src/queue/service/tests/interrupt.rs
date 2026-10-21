//! The run queue as an interrupt uses it: `Send now` on a provider that reads a priority message,
//! in each run state, sent again under its key or another, and a reorder after it; an interrupt's
//! release from inside the session's hold, one left unsettled and a run's end it held back,
//! settled at a later hold, and a closed session's held-back run ends given back.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{AgentQueueItemReorderRequest, QueueItemId};
use sidekicks_contracts::session::events::SessionLifecycleChangePayload;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, client_key, fixture, queue_over, recording_driver};
use crate::database::writer::test_file::test_envelope;
use crate::events::session::followers::CommittedEvent;
use crate::interventions::interrupt_queue::{
    InterruptChoice, InterruptQueue, SendNow, SendNowOutcome,
};
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::provider::driver::test_registry::bind_run_to_first_provider;
use crate::queue::service::RunQueue;
use crate::queue::store::send_now::{SentNow, read_sent_now};
use crate::queue::store::{QueueItemReader, RecordedQueueItemState};
use sidekicks_contracts::wire::id::mint_uuid_v7;

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

    /// The id the message's `Send now` mark carries.
    fn sent_now_mark(&self, item_id: QueueItemId) -> Option<InterventionId> {
        QueueItemReader::new(&self.database.reader())
            .get(&item_id)
            .expect("the test reads the message")
            .expect("the test's message is stored")
            .sent_now_id
    }

    /// The `Send now` recorded under `key` on `run_id`.
    fn sent_now_record(&self, run_id: RunId, key: &ClientUuid) -> Option<SentNow> {
        read_sent_now(&self.database.reader(), &run_id, key).expect("the test reads the key")
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
// marks B, recording its id under the request's key; a person's card open takes B alone, A and C
// waiting for the card's answer. Killed by taking back only the rows ahead of B (the provider reads
// B, C, A), by leaving a card open to an interrupt, or by not marking B or recording its key.
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
    assert_eq!(fixture.sent_now_mark(sent_now), Some(intervention_id));
    assert_eq!(
        fixture.sent_now_record(run_id, &key),
        Some(SentNow {
            item_id: sent_now,
            intervention_id
        })
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
// sent now, marked and first in the queue, a second `Send now` of it under another key answers the
// first's id, keeps its mark and records that id under its own key too, and its run's next hand
// gives it first marked priority, then the rest. Killed by an interrupt or a steer made at once, by
// the mark dropped or written again (the second is refused), by the second key left unrecorded, or
// by a next hand in the plain order.
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
    let (key, other_key) = (client_key(), client_key());
    let first_id = new_intervention_id();

    fixture
        .send_now(interrupted_run_id, sent_now, &key, first_id)
        .await;
    let again_id = fixture
        .send_now(
            interrupted_run_id,
            sent_now,
            &other_key,
            new_intervention_id(),
        )
        .await;
    fixture.queue.stop().await;

    assert_eq!(again_id, first_id);
    assert!(calls.steers().is_empty(), "{:?}", calls.steers());
    assert_eq!(fixture.sent_now_mark(sent_now), Some(first_id));
    let first_sent = SentNow {
        item_id: sent_now,
        intervention_id: first_id,
    };
    for key in [&key, &other_key] {
        assert_eq!(
            fixture.sent_now_record(interrupted_run_id, key),
            Some(first_sent)
        );
    }
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
// fails and records on the interrupt's row that only what the hold held back is left, its choice
// settled: applied, or not due; once the run is bound, a run's end taking the session's hold, or
// the queue's recovery after a restart, hands the message and clears the record. Killed by keeping
// the unsettled release in memory only (the restart never hands), by settling it only at the holds
// the queue's own calls take (the run's end never hands), by recording the choice again, or by
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
    fixture
        .queue
        .hold_for_interrupt(run_id, intervention_id, NEXT_TURN)
        .await
        .expect("the queue holds the run");

    fixture
        .queue
        .release_interrupt(run_id, intervention_id, NEXT_TURN)
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

    assert_eq!(recorded.as_deref(), Some("keepWaiting"));
    assert_eq!(calls.steers(), [(item_id, false)]);
    assert_eq!(fixture.unreleased_choice(intervention_id), None);
}

// Refuses every write that admits a message, standing in for a disk that fails it, until dropped.
const REFUSE_ADMISSION_SQL: &str = "CREATE TRIGGER refuse_admission
   BEFORE UPDATE OF state ON queue_items WHEN NEW.state = 'admitted'
   BEGIN SELECT RAISE(ABORT, 'the test refuses the admission'); END";

/// The choice a person's interrupt makes for the run's waiting messages.
const NEXT_TURN: InterruptChoice = InterruptChoice {
    pending: InterruptPendingChoice::NextTurn,
    deliver_first: None,
};

impl Fixture {
    /// Starts a queued lead run through the queue's admission, opening with a message queued for
    /// it, and answers the run's and the opening's ids.
    async fn start_lead_run(&self) -> (RunId, QueueItemId) {
        let run_id = self.insert_run("queued");
        let opening = self.queue_message(run_id).await;
        timeout(WAIT, self.queue.lifecycle.reconcile(self.session_id))
            .await
            .expect("the reconcile answers")
            .expect("the reconcile is heard")
            .expect("the reconcile starts the queued run");
        timeout(WAIT, self.queue.stop())
            .await
            .expect("the start settles");
        (run_id, opening)
    }

    /// Holds `run_id` for the interrupt `intervention_id`, queues a message for it and ends it
    /// `completed` while held, so its end waits for the interrupt; answers the message's id.
    async fn end_run_held_for_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
    ) -> QueueItemId {
        self.queue
            .hold_for_interrupt(run_id, intervention_id, NEXT_TURN)
            .await
            .expect("the queue holds the run");
        let waiting = self.queue_message(run_id).await;
        self.set_run_state(run_id, "completed");
        self.settle_end(run_id).await;
        waiting
    }

    /// The session's run ends an interrupt held back that no interrupt holds any more, read under
    /// a hold of a lock of the test's own, so no settle of the queue's hold runs first.
    async fn ends_left_unheld(&self) -> Vec<RunId> {
        let lock = KeyedLock::new();
        let hold = lock.acquire(self.session_id).await;
        self.queue.lifecycle.ends_no_longer_held(&hold)
    }

    /// Writes or drops the refusal of every write that admits a message.
    fn refuse_admissions(&self, is_refused: bool) {
        let sql = if is_refused {
            REFUSE_ADMISSION_SQL
        } else {
            "DROP TRIGGER refuse_admission"
        };
        self.database
            .reader()
            .execute(sql, [])
            .expect("the test changes the admission's refusal");
    }
}

/// Whether the interrupt whose release fails has a row to record that failure on.
#[derive(Clone, Copy, Debug)]
enum InterruptRow {
    /// The interrupt's row was written, so the release records what it left unsettled.
    Recorded,
    /// No row was written, so the record of the unsettled release is refused.
    Unrecorded,
}

// A run's end held back for an interrupt whose release fails to settle it, its opening's admission
// refused, stays held back: once the cause is gone, a later hold of the session settles it, the
// opening reads admitted into the run, the message left waiting opens a next run alone, the run
// holds no place at the gate, and no end is left held back. Killed by forgetting the held-back end
// before its settle (no next run), by no settle pass over the held-back ends at a hold (no next
// run when the interrupt has no row), or by forgetting the opening before its admission is written
// (the opening opens the next run too).
#[rstest]
#[case::recorded(InterruptRow::Recorded)]
#[case::unrecorded(InterruptRow::Unrecorded)]
#[tokio::test]
async fn a_run_end_held_for_an_interrupt_settles_at_a_later_hold(#[case] row: InterruptRow) {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    fixture.refuse_admissions(true);
    let (run_id, opening) = fixture.start_lead_run().await;
    let intervention_id = match row {
        InterruptRow::Recorded => fixture.insert_interrupt(run_id),
        InterruptRow::Unrecorded => new_intervention_id(),
    };
    let waiting = fixture
        .end_run_held_for_interrupt(run_id, intervention_id)
        .await;

    fixture
        .queue
        .release_interrupt(run_id, intervention_id, NEXT_TURN)
        .await
        .expect_err("the release's settle finds the opening's admission refused");
    fixture.refuse_admissions(false);
    drop(
        fixture
            .queue
            .session_lock
            .hold_session(fixture.session_id)
            .await,
    );
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the next run's start settles");

    let next_run_id = fixture
        .stored_item(waiting)
        .target_run_id
        .expect("the message waits for a run");
    assert_ne!(next_run_id, run_id);
    assert_eq!(calls.starts(), [(run_id, opening), (next_run_id, waiting)]);
    let opened = fixture.stored_item(opening);
    assert_eq!(opened.state, RecordedQueueItemState::Admitted);
    assert_eq!(opened.target_run_id, Some(run_id));
    assert!(!fixture.queue.admission.is_admitting(run_id));
    assert_eq!(fixture.ends_left_unheld().await, []);
}

// A session closed while an interrupt holds back its run's end gives back the run's place at the
// gate and keeps no end held back, before any release settles it; the close covers an end the
// interrupt still holds and one whose settle failed before it let its place go. The close is
// applied on the session's drain, after every change committed before it. Killed by a close that
// keeps the held-back end, or that releases no place for it.
#[tokio::test]
async fn a_closed_session_gives_back_its_held_back_run_ends() {
    let calls = Arc::new(DriverCalls::default());
    let fixture = fixture(recording_driver(&calls)).await;
    let (run_id, _) = fixture.start_lead_run().await;
    let intervention_id = new_intervention_id();
    fixture
        .end_run_held_for_interrupt(run_id, intervention_id)
        .await;
    let is_placed_before_close = fixture.queue.admission.is_admitting(run_id);
    let closed = SessionEvent::SessionClosed(SessionLifecycleChangePayload {
        session_id: fixture.session_id,
        previous_state: Some(SessionState::Active),
        new_state: SessionState::Closed,
        actor: None,
    });

    fixture
        .queue
        .lifecycle
        .observe(&CommittedEvent {
            envelope: Arc::new(test_envelope(fixture.session_id, &closed)),
            sequence: SafeInt::new(1).expect("a sequence"),
        })
        .expect("the close reads as its type");
    timeout(WAIT, async {
        while fixture.queue.admission.is_admitting(run_id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the close is applied on the drain");
    fixture
        .queue
        .delivery
        .release_interrupt_hold(run_id, intervention_id);

    assert!(is_placed_before_close, "the run holds its place until then");
    assert!(!fixture.queue.admission.is_admitting(run_id));
    assert_eq!(fixture.ends_left_unheld().await, []);
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
// the mark and the priority hand. Either way the key keeps its record. Killed by keeping the mark
// whatever the order (the provider reads the marked message first against the screen's order),
// by clearing it on every reorder, or by a clear that drops the key's record.
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
    let sent_now_id = fixture
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
    let mark = fixture.sent_now_mark(sent_now);
    let record = fixture.sent_now_record(run_id, &key);
    fixture.set_run_state(run_id, "running");
    fixture.hand_waiting(run_id).await;
    fixture.queue.stop().await;

    assert_eq!(fixture.waiting_order(run_id), order);
    assert_eq!(
        record,
        Some(SentNow {
            item_id: sent_now,
            intervention_id: sent_now_id
        })
    );
    match place {
        MarkedPlace::KeptFirst => {
            assert_eq!(mark, Some(sent_now_id));
            assert_eq!(calls.steers(), [(sent_now, true), (other, false)]);
        }
        MarkedPlace::MovedOffFirst => {
            assert_eq!(mark, None);
            assert_eq!(calls.steers(), [(other, false), (sent_now, false)]);
        }
    }
}

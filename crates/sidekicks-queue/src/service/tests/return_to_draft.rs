//! An interrupt's return to the draft applied after its run ended first: the lead messages end as
//! the Stop ends them, every outcome and the draft in one write, and a queued run left with no
//! message ends `stopped`.

use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::run::id::RunId;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_session::interventions::interrupt_queue::InterruptChoice;
use sidekicks_session::queue_store::{QueueItemRecord, RecordedQueueItemState};
use tokio::time::timeout;

use super::{Fixture, WAIT, fixture};
use crate::error::QueueError;
use crate::test_items::Form;

impl Fixture {
    /// The session's draft, read back.
    fn draft_text(&self) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT text FROM session_drafts WHERE session_id = ?1",
                params![self.session_id.text().as_str()],
                |row| row.get(0),
            )
            .optional()
            .expect("the test reads the draft")
    }

    /// Applies an interrupt's return to the draft to `waiting`, as the interrupt does once its run
    /// ended first.
    async fn return_to_draft(&self, waiting: Vec<QueueItemRecord>) -> Result<(), QueueError> {
        let choice = InterruptChoice {
            pending: InterruptPendingChoice::ReturnToDraft,
            deliver_first: None,
        };
        let hold = self.queue.session_lock.hold_session(self.session_id).await;
        timeout(
            WAIT,
            self.queue.apply_choice_to_waiting(&hold, choice, waiting),
        )
        .await
        .expect("the return answers")
    }

    /// Queues two messages of words for a run in `run_state`, answering the run and the messages.
    async fn queue_two_messages(&self, run_state: &str) -> (RunId, Vec<QueueItemRecord>) {
        let run_id = self.insert_run(run_state).await;
        let mut waiting = Vec::new();
        for form in [Form::Words("First"), Form::Words("Second")] {
            let item_id = self.queue_form(run_id, form).await;
            waiting.push(self.stored_item(item_id));
        }
        (run_id, waiting)
    }
}

// The late return of a queued run's only messages cancels both into the draft and ends the run
// `stopped` on `messagesRemoved`, never failed. Killed by the emptied run left queued or ended
// `failed`.
#[tokio::test]
async fn a_late_return_of_a_queued_runs_only_messages_stops_the_run() {
    let fixture = fixture(MockProviderDriver::new()).await;
    let (run_id, waiting) = fixture.queue_two_messages("queued").await;
    let ids: Vec<_> = waiting.iter().map(|item| item.id).collect();

    fixture
        .return_to_draft(waiting)
        .await
        .expect("the return writes");

    assert_eq!(fixture.draft_text().as_deref(), Some("First\nSecond"));
    for id in ids {
        assert_eq!(fixture.stored_state(id), RecordedQueueItemState::Canceled);
    }
    assert_eq!(fixture.run_state(run_id), "stopped");
    assert_eq!(fixture.count_stopped_by_removal(), 1);
}

// The return's outcomes and draft are one write: with the draft's write refused, no message reads
// canceled and both stay queued. Killed by per-item writes, which cancel the messages before the
// draft's write fails.
#[tokio::test]
async fn a_late_return_writes_every_outcome_and_the_draft_or_none() {
    let fixture = fixture(MockProviderDriver::new()).await;
    let (_run_id, waiting) = fixture.queue_two_messages("completed").await;
    let ids: Vec<_> = waiting.iter().map(|item| item.id).collect();
    fixture
        .database
        .reader()
        .execute_batch(
            "CREATE TRIGGER refuse_draft_insert BEFORE INSERT ON session_drafts
               BEGIN SELECT RAISE(ABORT, 'the test refuses the draft'); END;
             CREATE TRIGGER refuse_draft_update BEFORE UPDATE ON session_drafts
               BEGIN SELECT RAISE(ABORT, 'the test refuses the draft'); END;",
        )
        .expect("the test refuses every draft write");

    fixture
        .return_to_draft(waiting)
        .await
        .expect_err("the write fails with its draft");

    for id in ids {
        assert_eq!(fixture.stored_state(id), RecordedQueueItemState::Queued);
    }
    assert_eq!(fixture.draft_text(), None);
}

//! A person's removal of a message, answered by what the item reads: a waiting one is canceled, a
//! queued run left with none ending `stopped`; a lead message read not delivered is canceled, a
//! helper's refused; and a late admission landing first answers it taken.

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, QueueItemId, QueueItemNotDeliveredReason,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_session::queue_store::RecordedQueueItemState;

use super::{Fixture, fixture};
use crate::delivery::run_end::FAILED_DELIVERY;
use crate::error::QueueError;
use crate::service::cancel::UndeliveredCancel;

/// What the removed item reads when the person removes it.
#[derive(Clone, Copy, Debug)]
enum Removed {
    /// A lead message that reads not delivered.
    LeadNotDelivered,
    /// A helper's message that reads not delivered.
    HelperNotDelivered,
    /// The only message a queued run waits for.
    LastOfQueuedRun,
    /// A lead message read not delivered, which a late admission takes before the cancel writes.
    AdmittedFirst,
}

/// How the removal answered.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Canceled,
    /// Refused with this change-refused reason.
    Refused(&'static str),
}

impl Fixture {
    /// Moves `item_id` to not delivered as a failed hand does.
    async fn fail_delivery(&self, item_id: QueueItemId) {
        self.queue
            .recorder
            .record_outcome(
                &self.stored_item(item_id),
                FAILED_DELIVERY,
                &WireInstant::now(),
            )
            .await
            .expect("the test fails the message's delivery");
    }

    /// The `event_type` events the session's log holds.
    fn count_events_of_type(&self, event_type: &str) -> i64 {
        self.database
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE type = ?1",
                [event_type],
                |row| row.get(0),
            )
            .expect("the test counts the log's events")
    }
}

// The answer of a refusal, by its change-refused reason.
fn answer_of(answered: Result<(), QueueError>) -> Answer {
    match answered {
        Ok(()) => Answer::Canceled,
        Err(QueueError::Refused(DomainError { code, detail, .. })) => {
            assert_eq!(code, RefusalCode::AgentQueueItemChangeRefused);
            let reason = detail
                .and_then(|detail| detail.get("reason").cloned())
                .expect("a change refusal names its reason");
            match reason.as_str() {
                Some("notDelivered") => Answer::Refused("notDelivered"),
                Some("alreadyTaken") => Answer::Refused("alreadyTaken"),
                other => panic!("an unexpected reason {other:?}"),
            }
        }
        Err(error) => panic!("the removal fails, got {error:?}"),
    }
}

// A removal answers by what the item reads: a lead message not delivered is canceled with one
// event, a helper's refused not delivered, a queued run's last message canceled with the run
// ending `stopped` on `messagesRemoved` and no failure, and a late admission landing before the
// cancel's write answers it taken. Killed by the state check left at `queued` only, the widening
// taken past the lead, the emptied run ended `failed`, and a refused write swallowed.
#[rstest]
#[case::a_lead_message_not_delivered(Removed::LeadNotDelivered, Answer::Canceled)]
#[case::a_helpers_message_not_delivered(
    Removed::HelperNotDelivered,
    Answer::Refused("notDelivered")
)]
#[case::the_last_message_of_a_queued_run(Removed::LastOfQueuedRun, Answer::Canceled)]
#[case::a_late_admission_first(Removed::AdmittedFirst, Answer::Refused("alreadyTaken"))]
#[tokio::test]
async fn a_removal_answers_by_what_the_item_reads(
    #[case] removed: Removed,
    #[case] expected: Answer,
) {
    let fixture = fixture(MockProviderDriver::new()).await;
    let run_state = match removed {
        Removed::LastOfQueuedRun => "queued",
        Removed::LeadNotDelivered | Removed::HelperNotDelivered | Removed::AdmittedFirst => {
            "completed"
        }
    };
    let run_id = fixture.insert_run(run_state).await;
    let item_id = fixture.queue_message(run_id).await;
    let mut child_handle = None;
    match removed {
        Removed::LastOfQueuedRun => {}
        Removed::LeadNotDelivered | Removed::AdmittedFirst => fixture.fail_delivery(item_id).await,
        Removed::HelperNotDelivered => {
            fixture.fail_delivery(item_id).await;
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE queue_items SET child_handle = 'helper' WHERE id = ?1",
                    params![item_id.text().as_str()],
                )
                .expect("the test moves the message into a helper's box");
            child_handle = ChildHandle::new("helper".to_owned());
        }
    }

    let answered = match removed {
        // The cancel's own write, from the not-delivered read it was given, after the admission.
        Removed::AdmittedFirst => {
            let not_delivered = fixture.stored_item(item_id);
            fixture
                .queue
                .recorder
                .record_late_admission(&not_delivered, run_id, &WireInstant::now())
                .await
                .expect("the late admission lands");
            let taken = fixture
                .queue
                .cancel_undelivered(&not_delivered)
                .await
                .expect("a refused cancel re-reads as taken");
            match taken {
                UndeliveredCancel::Canceled => Answer::Canceled,
                UndeliveredCancel::Taken => Answer::Refused("alreadyTaken"),
            }
        }
        Removed::LeadNotDelivered | Removed::HelperNotDelivered | Removed::LastOfQueuedRun => {
            let cancel = fixture
                .queue
                .cancel(AgentQueueItemCancelRequest {
                    queue_item_id: item_id,
                    child_handle,
                })
                .await;
            answer_of(cancel.map(|_response| ()))
        }
    };

    assert_eq!(answered, expected);
    let canceled_events = fixture.count_events_of_type("agent.queueItem.canceled");
    match removed {
        Removed::LeadNotDelivered => {
            assert_eq!(
                fixture.stored_state(item_id),
                RecordedQueueItemState::Canceled
            );
            assert_eq!(canceled_events, 1);
        }
        Removed::HelperNotDelivered => {
            assert_eq!(
                fixture.stored_state(item_id),
                RecordedQueueItemState::NotDelivered {
                    reason: QueueItemNotDeliveredReason::Failed {},
                }
            );
            assert_eq!(canceled_events, 0);
        }
        Removed::LastOfQueuedRun => {
            assert_eq!(
                fixture.stored_state(item_id),
                RecordedQueueItemState::Canceled
            );
            assert_eq!(canceled_events, 1);
            assert_eq!(fixture.run_state(run_id), "stopped");
            let stopped_by_removal: i64 = fixture
                .database
                .reader()
                .query_row(
                    "SELECT COUNT(*) FROM session_events
                     WHERE type = 'agent.run.stopped'
                       AND json_extract(payload, '$.trigger') = 'messagesRemoved'",
                    [],
                    |row| row.get(0),
                )
                .expect("the test reads the run's end");
            assert_eq!(stopped_by_removal, 1);
            assert_eq!(fixture.count_events_of_type("agent.run.failed"), 0);
        }
        Removed::AdmittedFirst => {
            assert_eq!(
                fixture.stored_state(item_id),
                RecordedQueueItemState::Admitted
            );
            assert_eq!(canceled_events, 0);
        }
    }
}

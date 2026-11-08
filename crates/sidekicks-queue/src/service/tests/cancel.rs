//! A person's removal of an item, answered by what it reads: a waiting one is canceled, a queued
//! run left with none ending `stopped`; a lead item read not delivered is canceled, a helper's
//! message refused; and a late admission landing first answers it taken.

use rstest::rstest;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::queue::{AgentQueueItemCancelRequest, QueueItemId};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_session::queue_store::RecordedQueueItemState;

use super::{Fixture, fixture};
use crate::delivery::run_end::{FAILED_DELIVERY, FAILED_DELIVERY_REASON};
use crate::error::QueueError;
use crate::service::withdrawal::CancelOutcome;
use crate::test_items::Form;

/// What the removed item reads when the person removes it.
#[derive(Clone, Copy, Debug)]
enum Removed {
    /// A lead item of this form that reads not delivered.
    LeadNotDelivered(Form),
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
            .expect("the test fails the item's delivery");
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

// A removal answers by what the item reads: a lead item not delivered, a message, a review or a
// plan message, is canceled with one event, a helper's refused not delivered, a queued run's last
// message canceled with the run ending `stopped` on `messagesRemoved` and no failure, and a late
// admission landing before the cancel's write answers it taken. Killed by the state check left at
// `queued` only, the widening narrowed to a lead message or taken past the lead, the emptied run
// ended `failed`, and a refused write swallowed.
#[rstest]
#[case::a_lead_message_not_delivered(
    Removed::LeadNotDelivered(Form::Words("Look again")),
    Answer::Canceled
)]
#[case::a_lead_review_not_delivered(Removed::LeadNotDelivered(Form::Review), Answer::Canceled)]
#[case::a_lead_plan_message_not_delivered(
    Removed::LeadNotDelivered(Form::PlanMessage),
    Answer::Canceled
)]
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
        Removed::LeadNotDelivered(_) | Removed::HelperNotDelivered | Removed::AdmittedFirst => {
            "completed"
        }
    };
    let run_id = fixture.insert_run(run_state).await;
    let form = match removed {
        Removed::LeadNotDelivered(form) => form,
        Removed::HelperNotDelivered => Form::Helper("Look again"),
        Removed::LastOfQueuedRun | Removed::AdmittedFirst => Form::Words("Look again"),
    };
    let item_id = fixture.queue_form(run_id, form).await;
    let child_handle = match removed {
        Removed::HelperNotDelivered => ChildHandle::new("helper".to_owned()),
        Removed::LeadNotDelivered(_) | Removed::LastOfQueuedRun | Removed::AdmittedFirst => None,
    };
    if !matches!(removed, Removed::LastOfQueuedRun) {
        fixture.fail_delivery(item_id).await;
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
                CancelOutcome::Canceled => Answer::Canceled,
                CancelOutcome::Taken => Answer::Refused("alreadyTaken"),
            }
        }
        Removed::LeadNotDelivered(_) | Removed::HelperNotDelivered | Removed::LastOfQueuedRun => {
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
    let canceled_events = fixture.count_events(Some("agent.queueItem.canceled"), None);
    match removed {
        Removed::LeadNotDelivered(_) => {
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
                    reason: FAILED_DELIVERY_REASON,
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
            assert_eq!(fixture.count_stopped_by_removal(), 1);
            assert_eq!(fixture.count_events(Some("agent.run.failed"), None), 0);
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

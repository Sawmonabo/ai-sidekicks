//! An interrupt's return to the draft applied after its run ended first: each lead message ends as
//! the Stop ends it, the canceled ones' words going into the draft in the same write, and a queued
//! run left with no message ends `stopped`.

use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::{
    PlanMessage, PlanMessageKind, QueueItemId, QueueItemNotDeliveredReason,
};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_session::interventions::interrupt_queue::InterruptChoice;
use sidekicks_session::queue_store::{QueueItemBody, QueueMessageBody, RecordedQueueItemState};
use tokio::time::timeout;

use super::{Fixture, WAIT, fixture, words};

/// A waiting item's form, with the words it carries.
#[derive(Clone, Copy)]
enum Form {
    /// A lead message carrying only words.
    Words(&'static str),
    /// A lead message carrying a file beside its words.
    WithFiles(&'static str),
    Review,
    PlanMessage,
}

/// What the run the items wait for reads.
#[derive(Clone, Copy)]
enum WaitedRun {
    /// It ended before the interrupt could end it.
    Ended,
    /// It is queued, the items moved on to it from the run that ended.
    Queued,
}

fn body_of(form: Form) -> QueueItemBody {
    match form {
        Form::Words(text) => QueueItemBody::Message(words(text)),
        Form::WithFiles(text) => QueueItemBody::Message(QueueMessageBody {
            attachments: Some(AttachmentReferenceList(vec![
                ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id"),
            ])),
            ..words(text)
        }),
        Form::Review => QueueItemBody::Review {
            target: SessionReviewTarget::Staged,
        },
        Form::PlanMessage => QueueItemBody::PlanMessage {
            plan_message: PlanMessage {
                plan_id: PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id"),
                kind: PlanMessageKind::Build,
                source_session_id: None,
            },
            text: FreeFormText::new("Implement the plan.".to_owned()).expect("a plan message"),
        },
    }
}

impl Fixture {
    /// The session's draft and the instant it was written, read back.
    fn draft_row(&self) -> Option<(String, String)> {
        self.database
            .reader()
            .query_row(
                "SELECT text, updated_at FROM session_drafts WHERE session_id = ?1",
                params![self.session_id.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("the test reads the draft")
    }
}

// The late return ends each lead message as the Stop does, every outcome and the draft in one
// write (the draft and each canceled message stamped at one instant): words alone are canceled
// and go into the draft one line each in queue order ahead of the held draft; files, a review or
// a plan message end not delivered, kept whole; and a queued run left with none ends `stopped` on
// `messagesRemoved`, never failed. Killed by per-item writes, no draft written, a message with
// files canceled or its words in the draft, a review or a plan message canceled, or the emptied
// run ended `failed`.
#[rstest]
#[case::two_messages_ahead_of_the_held_draft(
    WaitedRun::Ended,
    &[Form::Words("First"), Form::Words("Second")],
    Some("Held"),
    &[true, true],
    Some("First\nSecond\nHeld"),
)]
#[case::a_queued_runs_only_messages(
    WaitedRun::Queued,
    &[Form::Words("First"), Form::Words("Second")],
    None,
    &[true, true],
    Some("First\nSecond"),
)]
#[case::a_message_with_files_between_two_with_words(
    WaitedRun::Ended,
    &[Form::Words("Before"), Form::WithFiles("With a file"), Form::Words("After")],
    None,
    &[true, false, true],
    Some("Before\nAfter"),
)]
#[case::a_review_and_a_plan_message(
    WaitedRun::Ended,
    &[Form::Review, Form::PlanMessage],
    None,
    &[false, false],
    None,
)]
#[tokio::test]
async fn return_to_draft_returns_each_message_as_the_stop_does(
    #[case] waited_run: WaitedRun,
    #[case] forms: &[Form],
    #[case] held: Option<&str>,
    #[case] is_canceled: &[bool],
    #[case] expected_draft: Option<&str>,
) {
    let fixture = fixture(MockProviderDriver::new()).await;
    let run_id = fixture
        .insert_run(match waited_run {
            WaitedRun::Ended => "completed",
            WaitedRun::Queued => "queued",
        })
        .await;
    if let Some(held) = held {
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    fixture.session_id.text().as_str(),
                    held,
                    "2026-01-01T00:00:00.000Z"
                ],
            )
            .expect("the test holds a draft");
    }
    let mut ids: Vec<QueueItemId> = Vec::with_capacity(forms.len());
    for form in forms {
        ids.push(fixture.queue_body(run_id, body_of(*form)).await);
    }
    let waiting = ids.iter().map(|id| fixture.stored_item(*id)).collect();

    let choice = InterruptChoice {
        pending: InterruptPendingChoice::ReturnToDraft,
        deliver_first: None,
    };
    let hold = fixture
        .queue
        .session_lock
        .hold_session(fixture.session_id)
        .await;
    timeout(
        WAIT,
        fixture
            .queue
            .apply_choice_to_waiting(&hold, choice, waiting),
    )
    .await
    .expect("the return answers")
    .expect("the return writes");
    drop(hold);

    let draft = fixture.draft_row();
    assert_eq!(
        draft.as_ref().map(|(text, _)| text.as_str()),
        expected_draft
    );
    for (id, canceled) in ids.iter().zip(is_canceled) {
        let stored = fixture.stored_item(*id);
        if *canceled {
            assert_eq!(stored.state, RecordedQueueItemState::Canceled);
            let (_, draft_written_at) = draft.as_ref().expect("a canceled message's words return");
            assert_eq!(stored.updated_at.as_str(), draft_written_at.as_str());
        } else {
            assert_eq!(
                stored.state,
                RecordedQueueItemState::NotDelivered {
                    reason: QueueItemNotDeliveredReason::Failed {},
                }
            );
        }
    }
    let run_state = fixture.run_state(run_id);
    match waited_run {
        WaitedRun::Ended => assert_eq!(run_state, "completed"),
        WaitedRun::Queued => {
            assert_eq!(run_state, "stopped");
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
        }
    }
}

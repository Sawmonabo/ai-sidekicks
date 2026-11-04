//! The Stop's end of the messages waiting for its run: a lead message carrying only words goes back
//! into the draft ahead of what the draft holds, every other form ends not delivered.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::{
    PlanMessage, PlanMessageKind, QueueItemId, QueueItemNotDeliveredReason,
};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueMessageBody, RecordedQueueItemState,
    insert_queue_item_statement,
};
use sidekicks_store::events::session::appender::{SessionEventAppender, SessionEventLinkage};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{Fixture, HANDS_AT_ONCE, driver_handing, fixture, stored_item};
use crate::delivery::run_end::stop_message_ends;

/// A waiting item's form, with the words it carries.
#[derive(Clone, Copy)]
enum Form {
    /// A lead message carrying only words.
    Words(&'static str),
    /// A lead message carrying a file beside its words.
    WithFiles(&'static str),
    /// A helper's message carrying only words.
    Helper(&'static str),
    Review,
    PlanMessage,
}

/// What became of a waiting item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ended {
    Canceled,
    Failed,
}

fn message(words: &str) -> QueueMessageBody {
    QueueMessageBody {
        content: FreeFormText::new(words.to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        answers_question_id: None,
        output_speed_for_turn: None,
        workspace_id: None,
    }
}

fn body_of(form: Form) -> QueueItemBody {
    match form {
        Form::Words(words) | Form::Helper(words) => QueueItemBody::Message(message(words)),
        Form::WithFiles(words) => QueueItemBody::Message(QueueMessageBody {
            attachments: Some(AttachmentReferenceList(vec![
                ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id"),
            ])),
            ..message(words)
        }),
        Form::Review => QueueItemBody::Review {
            target: SessionReviewTarget::Staged,
        },
        Form::PlanMessage => QueueItemBody::PlanMessage {
            plan_message: PlanMessage {
                plan_id: PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id"),
                kind: PlanMessageKind::Seed,
                source_session_id: None,
            },
            text: FreeFormText::new("Implement the plan.".to_owned()).expect("a plan message"),
        },
    }
}

/// Queues an item of `form` for the fixture's run, after every one before it, a helper's moved
/// into a helper's box.
async fn queue(fixture: &Fixture, form: Form) -> QueueItemId {
    let item = NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id: fixture.session_id,
        body: body_of(form),
        target_run_id: fixture.run_id,
        device_id: None,
        client_idempotency_key: Some(
            ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key"),
        ),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    };
    fixture
        .log
        .writer
        .write(vec![insert_queue_item_statement(&item)])
        .await
        .expect("the test queues its item");
    if let Form::Helper(_) = form {
        fixture
            .database
            .reader()
            .execute(
                "UPDATE queue_items SET child_handle = 'helper' WHERE id = ?1",
                params![item.id.text().as_str()],
            )
            .expect("the test moves the message into a helper's box");
    }
    item.id
}

fn held_draft(fixture: &Fixture) -> Option<String> {
    fixture
        .database
        .reader()
        .query_row(
            "SELECT text FROM session_drafts WHERE session_id = ?1",
            params![fixture.session_id.text().as_str()],
            |row| row.get(0),
        )
        .optional()
        .expect("the test reads the draft")
}

// Each form of a waiting message ends as the Stop's table says, committed as the run's end commits
// its companions, and the returned words go into the draft one line each, in queue order, ahead of
// the held draft. Killed by the held draft replaced or put first, the order reversed, a message
// with files, a helper's message, a review or a plan message canceled, or a draft written when no
// words returned.
#[rstest]
#[case::two_messages_ahead_of_the_held_draft(
    &[Form::Words("First"), Form::Words("Second")],
    Some("Held"),
    &[Ended::Canceled, Ended::Canceled],
    Some("First\nSecond\nHeld"),
)]
#[case::one_message_with_no_draft_held(
    &[Form::Words("Only")],
    None,
    &[Ended::Canceled],
    Some("Only"),
)]
#[case::a_message_with_files_beside_one_with_words(
    &[Form::WithFiles("With a file"), Form::Words("Words")],
    None,
    &[Ended::Failed, Ended::Canceled],
    Some("Words"),
)]
#[case::a_helpers_message_a_review_and_a_plan_message(
    &[Form::Helper("To the helper"), Form::Review, Form::PlanMessage],
    None,
    &[Ended::Failed, Ended::Failed, Ended::Failed],
    None,
)]
#[tokio::test]
async fn a_stop_returns_each_waiting_message_by_its_form(
    #[case] forms: &[Form],
    #[case] held: Option<&str>,
    #[case] expected: &[Ended],
    #[case] expected_draft: Option<&str>,
) {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    if let Some(held) = held {
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    fixture.session_id.text().as_str(),
                    held,
                    WireInstant::now().as_str()
                ],
            )
            .expect("the test holds a draft");
    }
    let mut ids = Vec::with_capacity(forms.len());
    for form in forms {
        ids.push(queue(&fixture, *form).await);
    }
    let waiting = QueueItemReader::new(&fixture.database.reader())
        .list_waiting_for_run(&fixture.run_id)
        .expect("the test reads the waiting messages");

    let mut companions =
        stop_message_ends(&waiting, &WireInstant::now()).expect("the ends are drafted");
    let draft = companions
        .preceding_events
        .pop()
        .expect("each item carries its event");
    SessionEventAppender::new(
        Arc::clone(&fixture.log.service),
        SESSION_EVENT_VERSION.clone(),
    )
    .append(
        draft,
        SessionEventLinkage {
            transactional_prelude: companions.statements,
            preceding_events: companions.preceding_events,
            ..SessionEventLinkage::default()
        },
    )
    .await
    .expect("the ends commit");

    assert_eq!(
        waiting.iter().map(|item| item.id).collect::<Vec<_>>(),
        ids,
        "the run's messages wait in the order queued"
    );
    for ((id, before), ended) in ids.iter().zip(&waiting).zip(expected) {
        let stored = stored_item(&fixture, *id);
        let expected_state = match ended {
            Ended::Canceled => RecordedQueueItemState::Canceled,
            Ended::Failed => RecordedQueueItemState::NotDelivered {
                reason: QueueItemNotDeliveredReason::Failed {},
            },
        };
        assert_eq!(stored.state, expected_state);
        assert_eq!(stored.body, before.body);
    }
    assert_eq!(held_draft(&fixture).as_deref(), expected_draft);
}

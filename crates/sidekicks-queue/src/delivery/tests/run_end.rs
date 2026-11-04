//! The Stop's end of the messages waiting for its run: a lead message carrying only words goes back
//! into the draft ahead of what the draft holds, every other form ends not delivered.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::queue_store::{QueueItemReader, RecordedQueueItemState};
use sidekicks_store::events::session::appender::{SessionEventAppender, SessionEventLinkage};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{Fixture, HANDS_AT_ONCE, driver_handing, fixture, stored_item};
use crate::delivery::run_end::stop_message_ends;
use crate::test_items::{Form, insert_form};

/// What became of a waiting item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Ended {
    Canceled,
    Failed,
}

impl Ended {
    /// The state an item that ended so reads.
    pub(super) fn state(self) -> RecordedQueueItemState {
        match self {
            Self::Canceled => RecordedQueueItemState::Canceled,
            Self::Failed => RecordedQueueItemState::NotDelivered {
                reason: QueueItemNotDeliveredReason::Failed {},
            },
        }
    }
}

/// The session's draft as the test reads it back.
pub(super) fn held_draft(fixture: &Fixture) -> Option<String> {
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

/// Holds `text` as the session's draft, as the person's typing does.
fn hold_draft(fixture: &Fixture, text: &str) {
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?1, ?2, ?3)",
            params![
                fixture.session_id.text().as_str(),
                text,
                WireInstant::now().as_str()
            ],
        )
        .expect("the test holds a draft");
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
#[case::a_message_with_files_between_two_with_words(
    &[Form::Words("Before"), Form::WithFiles("With a file"), Form::Words("After")],
    None,
    &[Ended::Canceled, Ended::Failed, Ended::Canceled],
    Some("Before\nAfter"),
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
        hold_draft(&fixture, held);
    }
    let mut ids = Vec::with_capacity(forms.len());
    for form in forms {
        ids.push(
            insert_form(
                &fixture.database,
                &fixture.log,
                fixture.session_id,
                fixture.run_id,
                *form,
            )
            .await,
        );
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
        assert_eq!(stored.state, ended.state());
        assert_eq!(stored.body, before.body);
    }
    assert_eq!(held_draft(&fixture).as_deref(), expected_draft);
}

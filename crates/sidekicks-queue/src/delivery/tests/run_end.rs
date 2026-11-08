//! The Stop's end of the messages waiting for its run: a lead message goes back into the draft
//! whole, its words ahead of what the draft holds, every other form ends not delivered.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::draft_store::test_follow::TestDraftFollow;
use sidekicks_session::draft_store::{SESSION_DRAFT_STORE_STATEMENT_CAPACITY, SessionDraftStore};
use sidekicks_session::queue_store::{QueueItemReader, RecordedQueueItemState};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
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

/// What rides with the session's draft, as the test reads it back; `None` when no row or no extras
/// are held.
fn held_extras(fixture: &Fixture) -> Option<Value> {
    fixture
        .database
        .reader()
        .query_row(
            "SELECT extras FROM session_drafts WHERE session_id = ?1",
            params![fixture.session_id.text().as_str()],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .expect("the test reads the draft")
        .flatten()
        .map(|extras| serde_json::from_str(&extras).expect("held extras are JSON"))
}

/// The revision of the session's draft as the test reads it back; `None` when no row is held.
fn held_revision(fixture: &Fixture) -> Option<i64> {
    fixture
        .database
        .reader()
        .query_row(
            "SELECT revision FROM session_drafts WHERE session_id = ?1",
            params![fixture.session_id.text().as_str()],
            |row| row.get(0),
        )
        .optional()
        .expect("the test reads the draft")
}

/// Holds `text` with `extras` as the session's draft at revision 1, as a first save does.
fn hold_draft(fixture: &Fixture, text: &str, extras: Option<Value>) {
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO session_drafts (session_id, text, extras, revision, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![
                fixture.session_id.text().as_str(),
                text,
                extras.map(|extras| extras.to_string()),
                WireInstant::now().as_str()
            ],
        )
        .expect("the test holds a draft");
}

/// The file the held draft of the cases with extras carries.
const HELD_FILE: &str = "01900000-0000-7000-8000-000000000001";

/// The repository the held draft of the case with skills binds to.
const HELD_WORKSPACE: &str = "01900000-0000-7000-8000-000000000003";

// The files the returned messages with extras carry, one each.
const FIRST_FILE: &str = "01900000-0000-7000-8000-000000000002";
const SECOND_FILE: &str = "01900000-0000-7000-8000-000000000004";

// The repositories the returned messages with extras bind to, one each.
const FIRST_WORKSPACE: &str = "01900000-0000-7000-8000-000000000005";
const SECOND_WORKSPACE: &str = "01900000-0000-7000-8000-000000000006";

// Each form of a waiting message ends as the Stop's table says, committed as the run's end commits
// its companions: every lead message is canceled into the draft whole, its words one line each, in
// queue order, ahead of the held draft's, its file and skill pick after the held draft's, and its
// speed only where the held draft names none, the draft's revision moving on by one. Killed by the
// held draft replaced or put first, the order reversed, a lead message with a file and a skill pick
// ended not delivered or returned without them, the held file dropped or put last, the held speed
// overwritten, a helper's message, a review or a plan message canceled, the revision left where it
// was, a draft written when no message returned, or the committed return reaching no follower of
// the draft with its words and its revision. Two messages with extras also kill the last
// message's speed taken over the first's, the held skill pick or file dropped, the first message's
// file dropped, a file or skill pick both sides carry kept twice or moved from its first place,
// and the held repository overwritten; over a held draft with no repository they kill the returned
// repositories dropped, the last one taken over the first's, and the pick both messages carry
// kept twice; words alone over a held draft of only extras kill the held extras replaced by none
// and the returned words followed by an empty held line.
#[rstest]
#[case::two_messages_ahead_of_the_held_draft(
    &[Form::Words("First"), Form::Words("Second")],
    Some(("Held", None)),
    &[Ended::Canceled, Ended::Canceled],
    Some("First\nSecond\nHeld"),
    None,
)]
#[case::one_message_with_no_draft_held(
    &[Form::Words("Only")],
    None,
    &[Ended::Canceled],
    Some("Only"),
    None,
)]
#[case::a_message_with_a_file_and_a_skill_between_two_with_words(
    &[
        Form::Words("Before"),
        Form::WithExtras { text: "With a file", file: FIRST_FILE, speed: "fast", workspace: None },
        Form::Words("After"),
    ],
    Some(("Held", Some(json!({ "attachments": [HELD_FILE], "outputSpeedForTurn": "standard" })))),
    &[Ended::Canceled, Ended::Canceled, Ended::Canceled],
    Some("Before\nWith a file\nAfter\nHeld"),
    Some(json!({
        "attachments": [HELD_FILE, FIRST_FILE],
        "skills": [{ "name": "review", "folderPath": "/skills/review" }],
        "outputSpeedForTurn": "standard",
    })),
)]
#[case::two_messages_with_extras_over_a_held_draft_with_skills_and_no_speed(
    &[
        Form::WithExtras {
            text: "First file",
            file: FIRST_FILE,
            speed: "fast",
            workspace: Some(FIRST_WORKSPACE),
        },
        Form::WithExtras {
            text: "Second file",
            file: SECOND_FILE,
            speed: "slow",
            workspace: Some(SECOND_WORKSPACE),
        },
    ],
    Some(("Held", Some(json!({
        "attachments": [SECOND_FILE],
        "skills": [{ "name": "plan", "folderPath": "/skills/plan" }],
        "workspaceId": HELD_WORKSPACE,
    })))),
    &[Ended::Canceled, Ended::Canceled],
    Some("First file\nSecond file\nHeld"),
    Some(json!({
        "attachments": [SECOND_FILE, FIRST_FILE],
        "skills": [
            { "name": "plan", "folderPath": "/skills/plan" },
            { "name": "review", "folderPath": "/skills/review" },
        ],
        "outputSpeedForTurn": "fast",
        "workspaceId": HELD_WORKSPACE,
    })),
)]
#[case::two_messages_with_repositories_over_a_held_draft_with_none(
    &[
        Form::WithExtras {
            text: "First file",
            file: FIRST_FILE,
            speed: "fast",
            workspace: Some(FIRST_WORKSPACE),
        },
        Form::WithExtras {
            text: "Second file",
            file: SECOND_FILE,
            speed: "slow",
            workspace: Some(SECOND_WORKSPACE),
        },
    ],
    Some(("Held", None)),
    &[Ended::Canceled, Ended::Canceled],
    Some("First file\nSecond file\nHeld"),
    Some(json!({
        "attachments": [FIRST_FILE, SECOND_FILE],
        "skills": [{ "name": "review", "folderPath": "/skills/review" }],
        "outputSpeedForTurn": "fast",
        "workspaceId": FIRST_WORKSPACE,
    })),
)]
#[case::words_over_a_held_draft_of_only_extras(
    &[Form::Words("Only words")],
    Some(("", Some(json!({ "attachments": [HELD_FILE], "outputSpeedForTurn": "standard" })))),
    &[Ended::Canceled],
    Some("Only words"),
    Some(json!({ "attachments": [HELD_FILE], "outputSpeedForTurn": "standard" })),
)]
#[case::a_review_a_plan_message_and_a_helpers_message(
    &[Form::Review, Form::PlanMessage, Form::Helper("To the helper")],
    None,
    &[Ended::Failed, Ended::Failed, Ended::Failed],
    None,
    None,
)]
#[tokio::test]
async fn a_stop_returns_each_waiting_message_by_its_form(
    #[case] forms: &[Form],
    #[case] held: Option<(&str, Option<Value>)>,
    #[case] expected: &[Ended],
    #[case] expected_draft: Option<&str>,
    #[case] expected_extras: Option<Value>,
) {
    let fixture = fixture(driver_handing(HANDS_AT_ONCE)).await;
    let held_revision_before = i64::from(held.is_some());
    if let Some((text, extras)) = held {
        hold_draft(&fixture, text, extras);
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
    let drafts = Arc::new(SessionDraftStore::new(
        Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            SESSION_DRAFT_STORE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&fixture.log.writer),
        &fixture.log.followers,
    ));
    let mut follow = TestDraftFollow::open(&drafts, fixture.session_id).await;
    // The draft held before the Stop, read first so the next one heard is the return's.
    follow.next().await;

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
    assert_eq!(held_extras(&fixture), expected_extras);
    assert_eq!(
        held_revision(&fixture),
        expected_draft.map(|_| held_revision_before + 1)
    );
    if let Some(expected_draft) = expected_draft {
        let heard = follow.next().await;
        assert_eq!(
            (heard.draft.text.as_str(), i64::from(heard.revision)),
            (expected_draft, held_revision_before + 1)
        );
    }
}

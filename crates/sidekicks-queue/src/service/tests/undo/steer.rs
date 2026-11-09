//! The undo to a steer: at the steer itself where the provider's cut lands inside a turn, else at
//! the start of the turn it joined, found through that turn whatever opened it, with the ask
//! naming the opening and the resend of an edited steer carrying the person's messages of that
//! turn.

use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::restore::{
    SessionRestoreResend, SessionRestoreScope, SessionRestoreTarget,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::checkpoints::store::kept::list_checkpoints;
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_session::run::engine::undo::RollbackCompanions;

use super::super::client_key;
use super::{
    ANSWER_EDIT, ANSWER_STEER_EDIT, ANSWER_STEER_WORDS, LATER_WORDS, OPENING_EDIT, OPENING_WORDS,
    SECOND_STEER_WORDS, STEER_EDIT, STEER_POSITION, STEER_WORDS, Scene, TARGET_POSITION,
    applied_in_place, cut_words, daemon_turn_scene, device, position, steer_scene,
};
use crate::service::undo::ConversationCut;
use crate::service::undo::reach::{QueuedOpeningKind, TurnOpening, UndoReach};
use crate::test_items::Form;

/// The artifact and the turn speed the turn's opening is sent with in the resend's scene.
const OPENING_FILE: &str = "01900000-0000-7000-8000-000000000002";
const OPENING_SPEED: &str = "fast";

/// The words the person edits a steer to.
const EDITED_WORDS: &str = "Then the tests, with coverage";

/// Cuts the scene's conversation to its target with no companions, under a fresh hold, and
/// answers the rollbacks' run positions and the reach.
async fn cut_to_target(scene: &Scene) -> (Vec<SourcePosition>, UndoReach) {
    let fixture = &scene.fixture;
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;
    let cut = fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");
    let ConversationCut::Applied { rollbacks, reach } = cut else {
        panic!("the provider applied the cut");
    };
    let positions = rollbacks
        .iter()
        .map(|rollback| rollback.event.target_position)
        .collect();
    (positions, reach)
}

/// The edit of a steer to [`EDITED_WORDS`], carrying nothing else.
fn edited() -> SessionRestoreResend {
    SessionRestoreResend {
        content: FreeFormText::new(EDITED_WORDS.to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        output_speed_for_turn: None,
    }
}

// On a provider whose cut lands inside a turn, an undo to a steer asks the cut before the steer
// itself, rolls the run back to the position before the steer's, leaves the opening's checkpoint
// listed and the later ones cut away, puts back only the edit made after the steer and takes back
// the steer's words and every later message's. Killed by the reach read as the turn's opening for
// the steer.
#[tokio::test]
async fn an_undo_on_a_steer_cuts_and_restores_at_the_steer() {
    let steer = steer_scene(applied_in_place(), true, Form::Words(OPENING_WORDS)).await;
    let scene = &steer.scene;
    let fixture = &scene.fixture;

    let (positions, reach) = cut_to_target(scene).await;

    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [scene.target_message_id.to_string()]
    );
    assert_eq!(positions, [position(STEER_POSITION - 1)]);
    let listed: Vec<SessionRestoreTarget> =
        list_checkpoints(&fixture.database.reader(), |_| None, fixture.session_id)
            .expect("the session's checkpoints read")
            .into_iter()
            .map(|stored| SessionRestoreTarget::Snapshot {
                snapshot_id: stored.checkpoint.checkpoint_id,
            })
            .collect();
    assert_eq!(listed, std::slice::from_ref(&steer.opening));
    assert!(reach.is_pressed_message());
    assert_eq!(
        fixture.restored_paths(reach.checkpoint.message_sequence),
        [STEER_EDIT]
    );
    assert_eq!(
        cut_words(&reach),
        [STEER_WORDS, SECOND_STEER_WORDS, LATER_WORDS]
    );
}

// On a provider whose cut lands only at turns, an undo to a steer asks the cut before its turn's
// opening, rolls the run back to the position before the opening's, names the opening's words for
// the ask, puts back both edits of the turn and takes back the opening's words, both steers' and
// the next turn's. Killed by the driver's description ignored, where the cut lands at the steer,
// and by the opening named as no queue item's.
#[tokio::test]
async fn an_undo_on_a_steer_reaches_its_turns_opening_where_the_cut_lands_only_at_turns() {
    let steer = steer_scene(applied_in_place(), false, Form::Words(OPENING_WORDS)).await;
    let scene = &steer.scene;

    let (positions, reach) = cut_to_target(scene).await;

    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [steer.opening_message_id.to_string()]
    );
    assert_eq!(positions, [position(TARGET_POSITION - 1)]);
    assert_eq!(
        reach.opening,
        Some(TurnOpening::Queued {
            queue_item_id: steer.opening_message_id,
            kind: QueuedOpeningKind::Message(
                FreeFormText::new(OPENING_WORDS.to_owned()).expect("a test message")
            ),
        })
    );
    assert_eq!(
        scene
            .fixture
            .restored_paths(reach.checkpoint.message_sequence),
        [OPENING_EDIT, STEER_EDIT]
    );
    assert_eq!(
        cut_words(&reach),
        [OPENING_WORDS, STEER_WORDS, SECOND_STEER_WORDS, LATER_WORDS]
    );
}

// With the files alone in scope, an undo to a steer on a provider whose cut lands only at turns
// goes back to the steer's own point, putting back only the edit made after it, and asks the
// provider nothing. Killed by the opening's reach applied to the files alone.
#[tokio::test]
async fn restoring_files_on_a_steer_is_exact_where_the_cut_lands_only_at_turns() {
    let steer = steer_scene(applied_in_place(), false, Form::Words(OPENING_WORDS)).await;
    let scene = &steer.scene;
    let fixture = &scene.fixture;

    let reach = fixture
        .queue
        .read_undo_reach(
            fixture.session_id,
            &scene.target,
            SessionRestoreScope::Files,
        )
        .await
        .expect("the reach reads");

    assert_eq!(reach.message_id, scene.target_message_id);
    assert_eq!(
        fixture.restored_paths(reach.checkpoint.message_sequence),
        [STEER_EDIT]
    );
    assert_eq!(scene.rewinds.load(Ordering::SeqCst), 0);
}

// The resend of an edited steer on a provider whose cut lands only at turns is one message of its
// turn: the opening's words, the edit in the steer's place and the later steer's, with the
// opening's files, skill picks and turn speed, and the release sends it so; the next turn's
// message goes back to the draft alone. Killed by the resent range ended at the pressed message,
// by the edited steer sent alone, and by the picks or the speed left out of the merge or of the
// release's send.
#[tokio::test]
async fn a_resend_of_an_edited_steer_is_one_message_of_its_turn() {
    let steer = steer_scene(
        applied_in_place(),
        false,
        Form::WithExtras {
            text: OPENING_WORDS,
            file: OPENING_FILE,
            speed: OPENING_SPEED,
            workspace: None,
        },
    )
    .await;
    let fixture = &steer.scene.fixture;
    let key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, key.clone())
        .await;
    let cut = fixture
        .queue
        .cut_conversation(&hold, &steer.scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");
    let ConversationCut::Applied { reach, .. } = cut else {
        panic!("the provider applied the cut");
    };
    let resent_flags: Vec<(&str, bool)> = reach
        .cut_messages
        .iter()
        .map(|message| (message.body.content.as_str(), message.is_resent))
        .collect();
    assert_eq!(
        resent_flags,
        [
            (OPENING_WORDS, true),
            (STEER_WORDS, true),
            (SECOND_STEER_WORDS, true),
            (LATER_WORDS, false),
        ]
    );

    fixture
        .queue
        .release_undo_hold(hold, Some(reach.resend_with(edited())), device())
        .await
        .expect("the release sends the resend");

    let reader = fixture.database.reader();
    let items = QueueItemReader::new(&reader);
    let opening = items
        .get(&steer.opening_message_id)
        .expect("the test reads the opening")
        .expect("the opening is stored");
    let opening = opening.body.as_message().expect("the person's message");
    let resent = items
        .get_by_idempotency_key(&fixture.session_id, &key)
        .expect("the test reads the resend")
        .expect("the resend is stored");
    let resent = resent.body.as_message().expect("the person's message");
    assert_eq!(
        resent.content.as_str(),
        format!("{OPENING_WORDS}\n\n{EDITED_WORDS}\n\n{SECOND_STEER_WORDS}")
    );
    assert!(
        opening.skill_picks.is_some(),
        "the opening was sent with a pick"
    );
    assert_eq!(resent.skill_picks, opening.skill_picks);
    assert_eq!(resent.attachments, opening.attachments);
    assert_eq!(resent.output_speed_for_turn, opening.output_speed_for_turn);
}

// A steer into a turn no message of the person's opened, as Codex's answer turn: where the cut
// lands only at turns, the undo goes back to the checkpoint that turn's start wrote, asking the cut
// through the steer, rolling back before the turn, putting back both of its edits and naming no
// queue item as its opening, and the resend of the edit is the edit alone; where it lands inside a
// turn, the undo goes back to the steer. Killed by the turn's start writing no checkpoint, by the
// opening found by position rather than through the turn, and by the cut asked before another
// queue item.
#[rstest]
#[case::where_the_cut_lands_only_at_turns(false)]
#[case::where_the_cut_lands_inside_a_turn(true)]
#[tokio::test]
async fn an_undo_on_a_steer_into_an_answer_turn_goes_back_to_that_turns_start(
    #[case] can_cut_inside_turn: bool,
) {
    let answer_turn = daemon_turn_scene(applied_in_place(), can_cut_inside_turn, None).await;
    let scene = &answer_turn.scene;
    let start = &answer_turn.turn_start;

    let (positions, reach) = cut_to_target(scene).await;

    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [scene.target_message_id.to_string()]
    );
    assert_eq!(cut_words(&reach), [ANSWER_STEER_WORDS]);
    let restored = scene
        .fixture
        .restored_paths(reach.checkpoint.message_sequence);
    if can_cut_inside_turn {
        assert!(reach.is_pressed_message());
        assert_eq!(positions, [start.turn.position]);
        assert_eq!(restored, [ANSWER_STEER_EDIT]);
    } else {
        assert_eq!(reach.checkpoint, *start);
        assert_eq!(reach.opening, Some(TurnOpening::Unqueued));
        assert_eq!(positions, [position(start.turn.position.0.get() - 1)]);
        // In path order.
        assert_eq!(restored, [ANSWER_STEER_EDIT, ANSWER_EDIT]);
        assert_eq!(reach.resend_with(edited()), edited());
    }
}

// A steer into a turn a review opened, where the cut lands only at turns: the undo goes back to
// the turn's start, names the review as its opening, asks the cut through the steer, and the
// resend of the edit is the edit alone, the review being the person's to run again. Killed by the
// review's queue item left off its turn's checkpoint, and by the cut asked before the review.
#[tokio::test]
async fn an_undo_on_a_steer_into_a_review_names_the_review_and_resends_the_steer_alone() {
    let review_turn = daemon_turn_scene(applied_in_place(), false, Some(Form::Review)).await;
    let scene = &review_turn.scene;

    let (_, reach) = cut_to_target(scene).await;

    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [scene.target_message_id.to_string()]
    );
    assert_eq!(reach.checkpoint, review_turn.turn_start);
    assert_eq!(
        reach.opening,
        Some(TurnOpening::Queued {
            queue_item_id: review_turn.opening_id.expect("the review opened the turn"),
            kind: QueuedOpeningKind::Review(SessionReviewTarget::Staged),
        })
    );
    assert_eq!(cut_words(&reach), [ANSWER_STEER_WORDS]);
    assert_eq!(reach.resend_with(edited()), edited());
}

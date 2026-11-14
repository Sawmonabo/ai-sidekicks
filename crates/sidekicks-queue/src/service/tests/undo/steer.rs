//! The undo to a steer: at the steer itself where its landing gives it a point of its own, else
//! before the first message of the group the provider's cut takes it with, the start of the turn
//! it joined, found through that turn whatever opened it, where the group begins at the turn's
//! opening, with the ask naming that first message and the messages that undo together, and the
//! resend of an edited steer carrying the person's messages of that group.

use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::restore::{SessionRestoreResend, SessionRestoreScope};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_session::run::engine::undo::RollbackCompanions;

use super::super::client_key;
use super::{
    ANSWER_EDIT, ANSWER_STEER_EDIT, ANSWER_STEER_WORDS, DaemonTurnOpening, LATER_OPENING_POSITION,
    LATER_WORDS, OPENING_EDIT, OPENING_WORDS, SECOND_STEER_WORDS, STEER_EDIT, STEER_POSITION,
    STEER_WORDS, Scene, SteerLanding, TARGET_POSITION, applied_in_place, cut_words,
    daemon_turn_scene, device, position, steer_scene,
};
use crate::service::undo::reach::{QueuedOpeningKind, TurnOpening, UndoReach};
use crate::service::undo::{ConversationCut, ProviderCut};
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
        .cut_conversation(
            &hold,
            &scene.target,
            RollbackCompanions::default(),
            ProviderCut::ToMake,
        )
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

// Which of the steer scene's messages an undo is aimed at.
#[derive(Clone, Copy, Debug)]
enum Pressed {
    // O.
    Opening,
    // S.
    Steer,
    // S2.
    SecondSteer,
}

// Which of the steer scene's messages an undo goes back to before.
#[derive(Clone, Copy, Debug)]
enum GroupFirst {
    // O, at the position before O's, putting back both edits of the turn.
    Opening,
    // S, at the position before S's, putting back only the edit made after S.
    Steer,
}

// An undo with the conversation in scope goes back to before the first message of the group the
// provider's cut takes the pressed message with, whichever member is pressed, the first included:
// it asks the cut before that first message, rolls the run back to the position before its own,
// takes back the words of every message the rollback cuts in send order and names the group's
// members as undoing together; a message cut alone is undone exactly and names none. The shapes:
// O, S or S2 of a Codex turn, which `thread/revert` cuts only whole (to O); O, S or S2 merged into
// one Claude Code command with O, O first as a message held over from the turn before, with P, a
// priority steer sent after O that landed in the turn before, kept out of the draft (to O); S or
// S2 of a batch merged into a turn continued after an interrupt, S naming no group (to S, never to
// the turn's start); a steer taken mid-turn, cut alone (S, nothing together), and one taken ahead
// of S2, sent before it, whose words still come back. Killed by the landing's group ignored, where
// the cut lands at the pressed member and the draft lacks the first member's words, by a press on
// a group's first read as a message cut alone, by the reach taken to the turn's start for a
// continued batch, by P put into the draft, by the draft read from the reach's sequence, and by a
// group of one or none named as undoing together.
#[rstest]
#[case::at_turns_opening(SteerLanding::AtTurns, Pressed::Opening, GroupFirst::Opening)]
#[case::at_turns_middle(SteerLanding::AtTurns, Pressed::Steer, GroupFirst::Opening)]
#[case::at_turns_last(SteerLanding::AtTurns, Pressed::SecondSteer, GroupFirst::Opening)]
#[case::merged_first(SteerLanding::MergedWithOpening, Pressed::Opening, GroupFirst::Opening)]
#[case::merged_middle(SteerLanding::MergedWithOpening, Pressed::Steer, GroupFirst::Opening)]
#[case::merged_last(
    SteerLanding::MergedWithOpening,
    Pressed::SecondSteer,
    GroupFirst::Opening
)]
#[case::continued_first(SteerLanding::Continued, Pressed::Steer, GroupFirst::Steer)]
#[case::continued_last(SteerLanding::Continued, Pressed::SecondSteer, GroupFirst::Steer)]
#[case::alone(SteerLanding::Alone, Pressed::Steer, GroupFirst::Steer)]
#[case::alone_taken_ahead(SteerLanding::AloneTakenAhead, Pressed::Steer, GroupFirst::Steer)]
#[tokio::test]
async fn an_undo_goes_back_to_before_the_first_message_its_group_is_cut_with(
    #[case] landing: SteerLanding,
    #[case] pressed: Pressed,
    #[case] first: GroupFirst,
) {
    let mut steer = steer_scene(applied_in_place(), landing, Form::Words(OPENING_WORDS)).await;
    let steer_message_id = steer.scene.target_message_id;
    match pressed {
        Pressed::Opening => {
            (steer.scene.target_message_id, steer.scene.target) =
                (steer.opening_message_id, steer.opening.clone());
        }
        Pressed::Steer => {}
        Pressed::SecondSteer => {
            (steer.scene.target_message_id, steer.scene.target) = steer.second_steer.clone();
        }
    }
    let scene = &steer.scene;

    let (positions, reach) = cut_to_target(scene).await;

    let (first_id, first_words, first_position, restored, words) = match first {
        GroupFirst::Opening => (
            steer.opening_message_id,
            OPENING_WORDS,
            TARGET_POSITION,
            vec![OPENING_EDIT, STEER_EDIT],
            vec![OPENING_WORDS, STEER_WORDS, SECOND_STEER_WORDS, LATER_WORDS],
        ),
        GroupFirst::Steer => (
            steer_message_id,
            STEER_WORDS,
            STEER_POSITION,
            vec![STEER_EDIT],
            match landing {
                // S2 was sent first, so its words come first.
                SteerLanding::AloneTakenAhead => {
                    vec![SECOND_STEER_WORDS, STEER_WORDS, LATER_WORDS]
                }
                SteerLanding::Alone
                | SteerLanding::AtTurns
                | SteerLanding::MergedWithOpening
                | SteerLanding::Continued => vec![STEER_WORDS, SECOND_STEER_WORDS, LATER_WORDS],
            },
        ),
    };
    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [first_id.to_string()]
    );
    assert_eq!(positions, [position(first_position - 1)]);
    assert_eq!(
        scene
            .fixture
            .restored_paths(reach.checkpoint.message_sequence),
        restored
    );
    assert_eq!(cut_words(&reach), words);
    if let SteerLanding::Alone | SteerLanding::AloneTakenAhead = landing {
        assert!(reach.is_pressed_message());
        assert_eq!(reach.undone_together(), []);
        return;
    }
    // A press on the group's first goes back to the pressed message itself.
    let opening = (scene.target_message_id != first_id).then(|| TurnOpening::Queued {
        queue_item_id: first_id,
        kind: QueuedOpeningKind::Message(
            FreeFormText::new(first_words.to_owned()).expect("a test message"),
        ),
    });
    assert_eq!(reach.opening, opening);
    let together = match first {
        GroupFirst::Opening => vec![
            steer.opening_message_id,
            steer_message_id,
            steer.second_steer.0,
        ],
        GroupFirst::Steer => vec![steer_message_id, steer.second_steer.0],
    };
    assert_eq!(reach.undone_together(), together);
    // The pencil resends the whole group with the edit in the pressed message's place.
    let resent: Vec<&str> = together
        .iter()
        .map(|member| {
            if *member == scene.target_message_id {
                EDITED_WORDS
            } else if *member == steer.opening_message_id {
                OPENING_WORDS
            } else if *member == steer_message_id {
                STEER_WORDS
            } else {
                SECOND_STEER_WORDS
            }
        })
        .collect();
    assert_eq!(
        reach.resend_with(edited()).content.as_str(),
        resent.join("\n\n")
    );
}

// With the files alone in scope, an undo to a steer with no point of its own goes back to the
// steer's own point, putting back only the edit made after it, and asks the provider nothing.
// Killed by the opening's reach applied to the files alone.
#[tokio::test]
async fn restoring_files_on_a_steer_is_exact_where_it_has_no_point_of_its_own() {
    let steer = steer_scene(
        applied_in_place(),
        SteerLanding::AtTurns,
        Form::Words(OPENING_WORDS),
    )
    .await;
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

// The resend of an edited steer with no point of its own is one message of its turn: the
// opening's words, the edit in the steer's place and the later steer's, with the opening's files,
// skill picks and turn speed, and the release sends it so; the next turn's message goes back to
// the draft alone. Killed by the resent range ended at the pressed message,
// by the edited steer sent alone, and by the picks or the speed left out of the merge or of the
// release's send.
#[tokio::test]
async fn a_resend_of_an_edited_steer_is_one_message_of_its_turn() {
    let steer = steer_scene(
        applied_in_place(),
        SteerLanding::AtTurns,
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
        .cut_conversation(
            &hold,
            &steer.scene.target,
            RollbackCompanions::default(),
            ProviderCut::ToMake,
        )
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

// A steer into a turn no message of the person's opened, as Codex's answer turn: where it has no
// point of its own, the undo goes back to the checkpoint that turn's start wrote, asking the cut
// through the steer, rolling back before the turn, putting back both of its edits and naming no
// queue item as its opening, and the resend of the edit is the edit alone; where it has one, the
// undo goes back to the steer. Killed by the turn's start writing no checkpoint, and by the cut
// asked before another queue item.
#[rstest]
#[case::with_no_point_of_its_own(true)]
#[case::with_a_point_of_its_own(false)]
#[tokio::test]
async fn an_undo_on_a_steer_into_an_answer_turn_goes_back_to_that_turns_start(
    #[case] is_cut_at_turns: bool,
) {
    let answer_turn =
        daemon_turn_scene(applied_in_place(), is_cut_at_turns, DaemonTurnOpening::None).await;
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
    if is_cut_at_turns {
        assert_eq!(reach.checkpoint, *start);
        assert_eq!(reach.opening, Some(TurnOpening::Unqueued));
        assert_eq!(positions, [position(start.turn.position.0.get() - 1)]);
        // In path order.
        assert_eq!(restored, [ANSWER_STEER_EDIT, ANSWER_EDIT]);
        assert_eq!(reach.resend_with(edited()), edited());
    } else {
        assert!(reach.is_pressed_message());
        assert_eq!(positions, [start.turn.position]);
        assert_eq!(restored, [ANSWER_STEER_EDIT]);
    }
}

// A steer with no point of its own into a turn a review opened: the undo goes back to
// the turn's start, names the review as its opening, asks the cut through the steer, and the
// resend of the edit is the edit alone, the review being the person's to run again. Killed by the
// review's queue item left off its turn's checkpoint, and by the cut asked before the review.
#[tokio::test]
async fn an_undo_on_a_steer_into_a_review_names_the_review_and_resends_the_steer_alone() {
    let review_turn = daemon_turn_scene(applied_in_place(), true, DaemonTurnOpening::Review).await;
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

// A steer into a turn that sent again a prompt an earlier turn already sent, as Codex's
// faster-model retry turn does with O3, the steer with no point of its own: the undo goes back to
// O3's own checkpoint, asking the cut before O3 and rolling back before its first turn, so O3's
// words go back into the draft and, ahead of the edit, into the resend; both of the retry turn's
// edits are put back. Killed by the reach landing at the retry start less one.
#[tokio::test]
async fn an_undo_on_a_steer_into_a_retry_turn_goes_back_to_the_retried_prompt() {
    let retry_turn = daemon_turn_scene(applied_in_place(), true, DaemonTurnOpening::Retry).await;
    let scene = &retry_turn.scene;
    let retried = retry_turn.opening_id.expect("the retry sent O3 again");

    let (positions, reach) = cut_to_target(scene).await;

    assert_eq!(
        *scene.rewound_message_ids.lock().expect("unpoisoned"),
        [retried.to_string()]
    );
    assert_eq!(positions, [position(LATER_OPENING_POSITION - 1)]);
    assert_eq!(
        reach.opening,
        Some(TurnOpening::Queued {
            queue_item_id: retried,
            kind: QueuedOpeningKind::Message(
                FreeFormText::new(LATER_WORDS.to_owned()).expect("a test message")
            ),
        })
    );
    assert_eq!(cut_words(&reach), [LATER_WORDS, ANSWER_STEER_WORDS]);
    // In path order.
    assert_eq!(
        scene
            .fixture
            .restored_paths(reach.checkpoint.message_sequence),
        [ANSWER_STEER_EDIT, ANSWER_EDIT]
    );
    assert_eq!(
        reach.resend_with(edited()).content.as_str(),
        format!("{LATER_WORDS}\n\n{EDITED_WORDS}")
    );
}

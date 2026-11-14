//! The ends a retried undo comes to: a fork its cut left unrecorded is closed before the retry
//! cuts the source again, a resend recorded with its cut is sent once however often it is
//! retried, a conversation cut back past the point is no cut already made, a provider that checks
//! the cut first is asked to cut and its record read only once it refuses, a lead turn after the
//! recorded cut is read from the log, a group member that landed before the cut goes with the
//! group's words, and an edited message a restart put back into the draft is never sent. How a
//! provider's record shows a cut it made before a restart and the daemon never recorded is read in
//! each driver's own tests.

use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::run::events::CutGroupStart;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::restore::SessionRestoreResend;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::rewind::{
    RewindConversationResult, RewindTargetAsk, RewindTargetPresence,
};
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_session::checkpoints::resends::{is_resend_returned, stage_resend_statement};
use sidekicks_session::checkpoints::restore_cuts::read_recorded_cut;
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_session::run::state_change::RunWriteCompanions;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};

use super::super::client_key;
use super::{
    Fixture, OPENING_WORDS, ProcessClose, SECOND_STEER_POSITION, SteerLanding, TARGET_TURN_NUMBER,
    applied_in_place, applied_on_fork, device, scene, steer_scene,
};
use crate::provider_session::errors::ProviderSessionError;
use crate::service::undo::{ConversationCut, ConversationCutError, ProviderCut};
use crate::test_items::Form;

/// How a retried undo's first attempt ended, or what came between it and the retry.
#[derive(Clone, Copy, Debug)]
enum FirstAttempt {
    /// The provider cut onto a fork whose rollback the store refused, and the fork's close failed.
    ForkLeftRunning,
    /// The cut applied with a resend, and the reply was lost before the resend was sent.
    ReplyLost,
    /// A cut took the conversation back past the point: neither the reach's message nor the one
    /// before it is held.
    CutPastPoint,
    /// The provider checks each cut against its own live conversation first and refuses one for a
    /// message it does not hold: first one it still holds where its cut does not find it, then
    /// one its cut took before the reply was lost.
    RefusedAsNotHeld,
    /// The cut applied, then a child run's turn and a lead turn started.
    TurnSinceCut,
    /// A member of the pressed message's group landed after the reach was read.
    MemberLandedSince,
    /// The resend was kept and the cut recorded with it when the daemon stopped.
    ReturnedWithCut,
    /// The resend was kept and the daemon stopped before the cut was recorded.
    ReturnedWithoutCut,
}

/// The refusal the provider that checks each cut first answers a message it does not hold with.
const NOT_HELD: &str = "target not found";

/// Companions whose one statement matches no row, so the rollback's write that holds them fails.
fn refusing_companions() -> RollbackCompanions {
    let mut write = RunWriteCompanions::default();
    write.statements = vec![WriteStatement {
        sql: Cow::Borrowed("SELECT 1 WHERE 0"),
        bindings: StatementBindings::None,
        expected_row_count: Some(1),
    }];
    RollbackCompanions {
        write,
        ..RollbackCompanions::default()
    }
}

/// The person's edit of the pressed message.
static EDITED: LazyLock<SessionRestoreResend> = LazyLock::new(|| SessionRestoreResend {
    content: FreeFormText::new("Look closer".to_owned()).expect("a test message"),
    attachments: None,
    skills: None,
    output_speed_for_turn: None,
});

/// The session's draft, empty where none is kept.
fn draft(fixture: &Fixture) -> Vec<String> {
    let reader = fixture.database.reader();
    let mut statement = reader
        .prepare("SELECT text FROM session_drafts WHERE session_id = ?1")
        .expect("the test reads the draft");
    statement
        .query_map(params![fixture.session_id.text().as_str()], |row| {
            row.get(0)
        })
        .expect("the test reads the draft")
        .collect::<rusqlite::Result<_>>()
        .expect("the draft reads")
}

// A retried undo ends as the undo asked for. A fork the first attempt left running, its rollback
// refused and its close failed, takes nothing while a close of it fails, then is closed, and the
// retry cuts the source conversation in place. A resend recorded with an applied cut is sent under
// the undo's key by each of two retries and lands once. A conversation that holds neither the
// reach's message nor the one before it fails the read with its cause, and one that holds the
// message before reads the cut made. A provider that checks each cut first is asked to cut whatever
// its record reads; its refusal for a message it still holds ends the cut as that fallback with
// nothing recorded, and for one its record shows cut, the message before held, records the cut it
// made. A lead turn started after the recorded cut is read from the log, a child run's is not. A
// group member that landed after the reach was read goes into the resend, the draft's messages and
// the key's record. An edited message a restart put back into the draft, its cut recorded or not,
// is marked returned and never sent under the key. Killed by a fork never closed again, by a
// process opened while the fork runs, by the retry reading the source as cut, by a record read
// before a cut the provider checks itself, by a refusal recorded as a cut made or one the record
// shows cut left unrecorded, by the resend left out of the key's record, by a resend sent under a
// key of its own, by a cut away message read as the cut made, by the turn read from no log position
// or from a child run, by the group read only before the hold, by the returned row deleted, and by
// a returned resend sent.
#[rstest]
#[case::fork_left_running(FirstAttempt::ForkLeftRunning)]
#[case::reply_lost(FirstAttempt::ReplyLost)]
#[case::cut_past_point(FirstAttempt::CutPastPoint)]
#[case::refused_as_not_held(FirstAttempt::RefusedAsNotHeld)]
#[case::turn_since_cut(FirstAttempt::TurnSinceCut)]
#[case::member_landed_since(FirstAttempt::MemberLandedSince)]
#[case::returned_with_cut(FirstAttempt::ReturnedWithCut)]
#[case::returned_without_cut(FirstAttempt::ReturnedWithoutCut)]
#[tokio::test]
async fn a_retried_undo_ends_applied(#[case] first_attempt: FirstAttempt) {
    let fork_binding_id = mint_runtime_binding_id();
    let fork_answer = applied_on_fork(&fork_binding_id, "fork-conversation");
    let in_place = applied_in_place();
    let asked = Arc::new(AtomicUsize::new(0));
    let is_forked_first = matches!(first_attempt, FirstAttempt::ForkLeftRunning);
    let is_refused = matches!(first_attempt, FirstAttempt::RefusedAsNotHeld);
    let counted = Arc::clone(&asked);
    let answer = Arc::new(move || {
        if is_refused {
            Ok(RewindConversationResult::TargetNotHeld {
                fallback_action: Some(NOT_HELD.to_owned()),
            })
        } else if is_forked_first && counted.fetch_add(1, Ordering::SeqCst) == 0 {
            fork_answer()
        } else {
            in_place()
        }
    });
    let (scene, opening_message_id) = match first_attempt {
        FirstAttempt::CutPastPoint
        | FirstAttempt::RefusedAsNotHeld
        | FirstAttempt::MemberLandedSince => {
            let landing = if matches!(first_attempt, FirstAttempt::MemberLandedSince) {
                SteerLanding::Continued
            } else {
                SteerLanding::Alone
            };
            let steer = steer_scene(answer, landing, Form::Words(OPENING_WORDS)).await;
            (steer.scene, Some(steer.opening_message_id))
        }
        FirstAttempt::ForkLeftRunning
        | FirstAttempt::ReplyLost
        | FirstAttempt::TurnSinceCut
        | FirstAttempt::ReturnedWithCut
        | FirstAttempt::ReturnedWithoutCut => (scene(answer).await, None),
    };
    let fixture = &scene.fixture;
    let provider_sessions = &fixture.queue.provider_sessions;
    let source_binding_id = provider_sessions
        .binding_cursors()
        .current_binding(&fixture.session_id)
        .expect("the scene runs on a binding");
    let undo_key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, undo_key.clone())
        .await;
    let reach = scene.reach().await;
    let cut_once = |edited: Option<&'static SessionRestoreResend>| {
        let reach = &reach;
        let hold = &hold;
        async move {
            fixture
                .queue
                .cut_conversation(
                    hold,
                    reach,
                    RollbackCompanions::default(),
                    ProviderCut::ToMake,
                    edited,
                )
                .await
        }
    };
    let returned_draft = || {
        assert_eq!(draft(fixture), ["Look closer"]);
        assert!(
            is_resend_returned(&fixture.database.reader(), fixture.session_id, &undo_key)
                .expect("the kept resend reads")
        );
    };

    match first_attempt {
        FirstAttempt::ForkLeftRunning => {
            // The cut's close of the fork fails, and so does the one the next open makes.
            scene.failing_closes.store(2, Ordering::SeqCst);
            let first = fixture
                .queue
                .cut_conversation(
                    &hold,
                    &reach,
                    refusing_companions(),
                    ProviderCut::ToMake,
                    None,
                )
                .await;
            let opened_while_running = provider_sessions
                .open(fixture.session_id, scene.run_id)
                .await;
            provider_sessions
                .close_unclosed_fork(fixture.session_id)
                .await
                .expect("the fork closes at last");
            let retry_reach = scene.reach().await;
            let provider_cut = fixture
                .queue
                .read_provider_cut(fixture.session_id, &retry_reach)
                .await
                .expect("the provider's read answers");
            let retried = fixture
                .queue
                .cut_conversation(
                    &hold,
                    &retry_reach,
                    RollbackCompanions::default(),
                    provider_cut,
                    None,
                )
                .await;

            assert!(
                matches!(
                    first,
                    Err(ConversationCutError::ForkUnrecorded(
                        ProviderSessionError::UnclosedFork { .. }
                    ))
                ),
                "{first:?}"
            );
            assert!(
                matches!(
                    opened_while_running,
                    Err(ProviderSessionError::UnclosedFork { .. })
                ),
                "{opened_while_running:?}"
            );
            assert_eq!(provider_cut, ProviderCut::ToMake);
            assert!(
                matches!(retried, Ok(ConversationCut::Applied { .. })),
                "{retried:?}"
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 2);
            let closes = scene.closes.lock().expect("unpoisoned");
            assert_eq!(closes.len(), 3);
            assert!(closes.iter().all(|close| matches!(
                close,
                ProcessClose {
                    cause: SessionCloseCause::UnrecordedOpening,
                    is_append_lock_free: true,
                    is_queue_lock_free: true,
                }
            )));
            let binding_cursors = provider_sessions.binding_cursors();
            assert_eq!(
                binding_cursors.current_binding(&fixture.session_id),
                Some(source_binding_id)
            );
            assert!(!binding_cursors.is_binding_open(&fork_binding_id));
            let rolled_back = fixture
                .event_types()
                .into_iter()
                .filter(|event_type| event_type == "agent.run.rolledBack")
                .count();
            assert_eq!(rolled_back, 1);
        }
        FirstAttempt::ReplyLost => {
            cut_once(Some(&*EDITED)).await.expect("the cut applies");
            // The first attempt's resend is never sent: its reply was lost with the process.
            fixture
                .queue
                .release_undo_hold(hold, None, device())
                .await
                .expect("the first attempt lets the session go");
            let items_before = fixture.count_items();
            for _ in 0..2 {
                let retry = fixture
                    .queue
                    .hold_for_undo(fixture.session_id, undo_key.clone())
                    .await;
                let recorded =
                    read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                        .expect("the key's record reads")
                        .expect("the key recorded its cut");
                fixture
                    .queue
                    .release_undo_hold(retry, recorded.resend, device())
                    .await
                    .expect("the retry sends the resend");
            }

            assert_eq!(fixture.count_items(), items_before + 1);
            let resent = QueueItemReader::new(&fixture.database.reader())
                .get_by_idempotency_key(&fixture.session_id, &undo_key)
                .expect("the resend reads")
                .expect("the resend went under the undo's key");
            assert_eq!(
                resent
                    .body
                    .as_message()
                    .map(|message| message.content.as_str()),
                Some("Look closer")
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
        }
        FirstAttempt::CutPastPoint => {
            let opening_message_id = opening_message_id.expect("the steer scene names its opening");
            let answer = |message_id: String, presence| {
                scene
                    .presence
                    .lock()
                    .expect("unpoisoned")
                    .insert(message_id, presence);
            };
            answer(
                scene.target_message_id.to_string(),
                RewindTargetPresence::CutAway,
            );
            answer(
                opening_message_id.to_string(),
                RewindTargetPresence::CutAway,
            );
            let past = fixture
                .queue
                .read_provider_cut(fixture.session_id, &reach)
                .await;
            answer(opening_message_id.to_string(), RewindTargetPresence::Held);
            let made = fixture
                .queue
                .read_provider_cut(fixture.session_id, &reach)
                .await;

            assert!(
                matches!(past, Err(ConversationCutError::CutPastPoint)),
                "{past:?}"
            );
            assert!(matches!(made, Ok(ProviderCut::AlreadyMade)), "{made:?}");
        }
        FirstAttempt::RefusedAsNotHeld => {
            *scene.ask.lock().expect("unpoisoned") = RewindTargetAsk::AfterRefusal;
            let presence = |message_id: QueueItemId, read| {
                scene
                    .presence
                    .lock()
                    .expect("unpoisoned")
                    .insert(message_id.to_string(), read);
            };
            // The provider's record reads the steer cut, so only a read before the cut takes it.
            presence(scene.target_message_id, RewindTargetPresence::CutAway);
            let provider_cut = fixture
                .queue
                .read_provider_cut(fixture.session_id, &reach)
                .await
                .expect("the provider's read answers");
            presence(scene.target_message_id, RewindTargetPresence::Held);
            let held = cut_once(None).await;
            presence(scene.target_message_id, RewindTargetPresence::CutAway);
            presence(
                opening_message_id.expect("the steer scene names its opening"),
                RewindTargetPresence::Held,
            );
            let made = cut_once(None).await;

            assert_eq!(provider_cut, ProviderCut::ToMake);
            assert!(
                matches!(
                    &held,
                    Ok(ConversationCut::Degraded { fallback_action: Some(action) })
                        if action == NOT_HELD
                ),
                "{held:?}"
            );
            assert!(
                matches!(made, Ok(ConversationCut::Applied { .. })),
                "{made:?}"
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 2);
            assert_eq!(scene.adopts.load(Ordering::SeqCst), 1);
            assert!(
                read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                    .expect("the key's record reads")
                    .is_some()
            );
        }
        FirstAttempt::TurnSinceCut => {
            cut_once(None).await.expect("the cut applies");
            let is_turn_since = || {
                read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                    .expect("the key's record reads")
                    .expect("the key recorded its cut")
                    .is_lead_turn_started_since
            };
            let before_any = is_turn_since();
            let child_run_id = fixture.insert_run("running").await;
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE runs SET parent_run_id = ?1 WHERE run_id = ?2",
                    params![scene.run_id.text().as_str(), child_run_id.text().as_str()],
                )
                .expect("the test makes the run a child");
            fixture
                .append_turn_event(child_run_id, "agent.turn.started", 1)
                .await;
            let after_child = is_turn_since();
            fixture
                .append_turn_event(scene.run_id, "agent.turn.started", TARGET_TURN_NUMBER)
                .await;

            assert!(!before_any);
            assert!(!after_child);
            assert!(is_turn_since());
        }
        FirstAttempt::MemberLandedSince => {
            let (landed_id, _) = fixture
                .insert_steer(
                    scene.run_id,
                    "And the changelog",
                    TARGET_TURN_NUMBER,
                    SECOND_STEER_POSITION,
                    Some(CutGroupStart::Message {
                        message_id: scene.target_message_id,
                    }),
                )
                .await;
            let cut = cut_once(Some(&*EDITED)).await.expect("the cut applies");

            let ConversationCut::Applied { reach, resend, .. } = cut else {
                panic!("the cut applies in place");
            };
            let words = "Look closer\n\nAnd the docs\n\nAnd the changelog";
            assert_eq!(
                resend.as_ref().map(|resend| resend.content.as_str()),
                Some(words)
            );
            assert!(
                reach
                    .cut_messages
                    .iter()
                    .any(|message| message.queue_item_id == landed_id && message.is_resent)
            );
            let recorded =
                read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                    .expect("the key's record reads")
                    .expect("the key recorded its cut");
            assert_eq!(recorded.resend, resend);
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
        }
        FirstAttempt::ReturnedWithCut | FirstAttempt::ReturnedWithoutCut => {
            let is_cut_first = matches!(first_attempt, FirstAttempt::ReturnedWithCut);
            fixture
                .queue
                .writer
                .write(vec![stage_resend_statement(
                    fixture.session_id,
                    &undo_key,
                    &EDITED,
                )])
                .await
                .expect("the resend is kept");
            if is_cut_first {
                cut_once(Some(&*EDITED)).await.expect("the cut applies");
            }
            // The stop dropped the hold with the process; a second start finds nothing more.
            for _ in 0..2 {
                let failures = fixture
                    .queue
                    .recover()
                    .await
                    .expect("the start's reads run");
                assert!(failures.is_empty(), "{failures:?}");
            }
            returned_draft();
            let resend = if is_cut_first {
                read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                    .expect("the key's record reads")
                    .expect("the key recorded its cut")
                    .resend
            } else {
                let ConversationCut::Applied { resend, .. } = cut_once(Some(&*EDITED))
                    .await
                    .expect("the retry cuts as a first attempt")
                else {
                    panic!("the cut applies in place");
                };
                resend
            };
            assert!(resend.is_some());
            fixture
                .queue
                .release_undo_hold(hold, resend, device())
                .await
                .expect("the retry lets the session go");

            assert!(
                QueueItemReader::new(&fixture.database.reader())
                    .get_by_idempotency_key(&fixture.session_id, &undo_key)
                    .expect("the key's item reads")
                    .is_none()
            );
            returned_draft();
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
        }
    }
}

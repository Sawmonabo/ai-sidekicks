//! The conversation cut: refused or degraded cuts write nothing, a companion its check refuses is
//! refused before the provider is asked, an applied one lands with its companions and keeps the
//! hold, a fork moves the session to its binding and records it with the conversation it left, a
//! fork the daemon cannot record is closed and fails the cut, every later run rolls back in the
//! same write, no cut is asked of the provider while a turn is open, and a turn the provider opens
//! once it answered opens after the write. The undo to a steer is in `steer`.

use std::borrow::Cow;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

use rstest::rstest;
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, json};
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::{AgentRunRecoveryResolvedPayload, RunRecoveryChoice};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::restore::SessionRestoreTarget;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::rewind::{ForkedBinding, RewindConversationResult};
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_provider::left_conversations::{LeftConversation, read_left_conversations};
use sidekicks_provider::port::run_host::{RunHost, RunHostError};
use sidekicks_provider::run::turn_end::StartedTurn;
use sidekicks_provider::runtime_binding::store::{mint_runtime_binding_id, read_binding};
use sidekicks_provider::runtime_binding::test_store::{spawned_build, test_provider_account_id};
use sidekicks_provider::runtime_binding::writer::RuntimeBindingWriter;
use sidekicks_session::checkpoints::store::kept::list_checkpoints;
use sidekicks_session::run::binding_cursors::RunBindingCursorError;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::engine::errors::RunEngineError;
use sidekicks_session::run::engine::undo::{
    RollbackCheckError, RollbackCompanionCheck, RollbackCompanions,
};
use sidekicks_session::run::state_change::{RunWriteCompanions, RunWriteError};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::session::appender::SessionEventDraft;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::super::{HELD_WATCH, WAIT, client_key};
use super::{
    OPENING_WORDS, ProcessClose, RewindAnswer, STEER_POSITION, Scene, TARGET_POSITION,
    TARGET_TURN_NUMBER, applied_in_place, cut_words, epoch_position, position, scene, steer_scene,
};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::service::undo::{ConversationCut, ConversationCutError};
use crate::test_items::Form;

/// The companions recovery passes when it undoes to where both sides agree: its resolution, and a
/// guard that holds only while `run_id` stands at `run_version` once the rollback moved it, with
/// `check` as the guard's check.
fn recovery_companions(
    scene: &Scene,
    run_id: RunId,
    run_version: i64,
    check: RollbackCompanionCheck,
) -> RollbackCompanions {
    let session_id = scene.fixture.session_id;
    let mut write = RunWriteCompanions::default();
    write.statements = vec![run_at_version(run_id, run_version)];
    write.preceding_events = vec![
        SessionEventDraft::of_session(
            session_id,
            &SessionEvent::AgentRunRecoveryResolved(AgentRunRecoveryResolvedPayload {
                session_id,
                run_id: scene.run_id,
                choice: RunRecoveryChoice::UndoToAgreed,
            }),
        )
        .expect("the event passes its checks"),
    ];
    RollbackCompanions { write, check }
}

/// The check of [`run_at_version`]'s guard, read before the cut: the rollback advances the run's
/// version by one.
fn checks_run_reaching(run_id: RunId, run_version: i64) -> RollbackCompanionCheck {
    Arc::new(move |reader: &Connection| {
        let version: i64 = reader.query_row(
            "SELECT run_version FROM runs WHERE run_id = ?1",
            [run_id.text().as_str()],
            |row| row.get(0),
        )?;
        if version + 1 == run_version {
            Ok(())
        } else {
            Err(RollbackCheckError::CompanionRefused { companion_index: 0 })
        }
    })
}

/// A companion statement that holds only while `run_id` stands at `run_version`.
fn run_at_version(run_id: RunId, run_version: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed("SELECT 1 FROM runs WHERE run_id = @run_id AND run_version = @version"),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (Cow::Borrowed("@version"), SqlValue::Integer(run_version)),
        ]),
        expected_row_count: Some(1),
    }
}

/// Why a cut wrote nothing.
#[derive(Clone, Copy, Debug)]
enum UnwrittenCut {
    /// The provider took a fallback.
    Degraded,
    /// The provider failed the cut.
    Failed,
    /// The companions' check refused before the provider was asked.
    CheckRefused,
    /// The provider applied it and a companion statement its check missed refused the write.
    WriteRefused,
}

// A cut the provider took a fallback for or failed, or one a companion refuses, writes neither a
// rollback nor the companion's event and leaves the run's version: a companion its check refuses
// is refused before the provider is asked, and one refused only at the write once the provider cut
// says the cut went unrecorded. Killed by a rollback appended before the provider's answer, by the
// companions written apart from the rollback, by the companions' check skipped or read after the
// provider's answer, and by a refused write after the cut answered as a read failure.
#[rstest]
#[case::degraded(UnwrittenCut::Degraded)]
#[case::failed(UnwrittenCut::Failed)]
#[case::check_refused(UnwrittenCut::CheckRefused)]
#[case::write_refused(UnwrittenCut::WriteRefused)]
#[tokio::test]
async fn a_cut_the_provider_or_a_companion_refuses_writes_nothing(#[case] unwritten: UnwrittenCut) {
    let answer: RewindAnswer = match unwritten {
        UnwrittenCut::Degraded => Arc::new(|| {
            Ok(RewindConversationResult::Degraded {
                fallback_action: Some("restartFromHistory".to_owned()),
            })
        }),
        UnwrittenCut::Failed => {
            Arc::new(|| Err(DriverError::Internal("the test's cut fails".into())))
        }
        UnwrittenCut::CheckRefused | UnwrittenCut::WriteRefused => applied_in_place(),
    };
    let scene = scene(answer).await;
    let fixture = &scene.fixture;
    // The rollback moves the run to version 2, so a guard on version 1 refuses its write; only one
    // case's check reads that before the cut, and the others' check nothing, as the default's.
    let check = match unwritten {
        UnwrittenCut::CheckRefused => checks_run_reaching(scene.run_id, 1),
        UnwrittenCut::Degraded | UnwrittenCut::Failed | UnwrittenCut::WriteRefused => {
            RollbackCompanions::default().check
        }
    };
    let companions = recovery_companions(&scene, scene.run_id, 1, check);
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    let cut = fixture
        .queue
        .cut_conversation(&hold, &scene.target, companions)
        .await;

    match unwritten {
        UnwrittenCut::Degraded => assert!(
            matches!(cut, Ok(ConversationCut::Degraded { .. })),
            "{cut:?}"
        ),
        UnwrittenCut::Failed => assert!(
            matches!(cut, Err(ConversationCutError::Queue(QueueError::Driver(_)))),
            "{cut:?}"
        ),
        UnwrittenCut::CheckRefused => {
            assert!(
                matches!(
                    cut,
                    Err(ConversationCutError::CompanionRefused { companion_index: 0 })
                ),
                "{cut:?}"
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 0);
        }
        UnwrittenCut::WriteRefused => assert!(
            matches!(
                cut,
                Err(ConversationCutError::Unrecorded(QueueError::Engine(
                    RunEngineError::Change(RunWriteError::CompanionRefused { .. })
                )))
            ),
            "{cut:?}"
        ),
    }
    let types = fixture.event_types();
    assert!(!types.contains(&"agent.run.rolledBack".to_owned()));
    assert!(!types.contains(&"agent.run.recovery.resolved".to_owned()));
    assert_eq!(fixture.run_version(scene.run_id), 1);
    assert!(scene.closes.lock().expect("unpoisoned").is_empty());
}

// An applied cut lands recovery's resolution, then the target run's rollback at its version plus
// one and the turn before the target's, in one write. Killed by the companions written apart, and
// by the point taken as the target turn's own position.
#[tokio::test]
async fn an_applied_cut_lands_with_its_companions() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let companions = recovery_companions(
        &scene,
        scene.run_id,
        2,
        checks_run_reaching(scene.run_id, 2),
    );
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    let cut = fixture
        .queue
        .cut_conversation(&hold, &scene.target, companions)
        .await
        .expect("the cut applies");

    let ConversationCut::Applied { rollbacks, reach } = cut else {
        panic!("the provider applied the cut");
    };
    let landed: Vec<(RunId, i64, SourcePosition)> = rollbacks
        .iter()
        .map(|rollback| {
            (
                rollback.event.run_id,
                i64::from(rollback.event.run_version),
                rollback.event.target_position,
            )
        })
        .collect();
    assert_eq!(landed, [(scene.run_id, 2, position(TARGET_POSITION - 1))]);
    assert_eq!(cut_words(&reach), [OPENING_WORDS]);
    assert_eq!(
        fixture.event_types(),
        [
            "session.created",
            "agent.run.queued",
            "user.message.sent",
            "agent.run.recovery.resolved",
            "agent.run.rolledBack",
        ]
    );
    assert!(scene.closes.lock().expect("unpoisoned").is_empty());
}

// A checkpoint a cut already cut away is left out of the session's list, and a second cut to it
// refuses before the provider is asked, while the checkpoint of the turn the run opens again at
// the same position, in the epoch the cut opened, is listed. Killed by the list keeping a
// superseded checkpoint, by the list's filter reading the position without the epoch, and by the
// checkpoint's read not refusing one.
#[tokio::test]
async fn a_checkpoint_a_cut_cut_away_is_unlisted_and_refused() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;
    fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");
    let (_, message_sequence) = fixture
        .insert_sent_message(scene.run_id, Form::Words(OPENING_WORDS))
        .await;
    let reopened = fixture
        .insert_checkpoint(
            scene.run_id,
            message_sequence,
            TARGET_TURN_NUMBER + 1,
            epoch_position(1, TARGET_POSITION),
        )
        .await;

    let listed = list_checkpoints(&fixture.database.reader(), |_| None, fixture.session_id)
        .expect("the session's checkpoints read");
    let again = fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await;

    let listed: Vec<SessionRestoreTarget> = listed
        .into_iter()
        .map(|stored| SessionRestoreTarget::Snapshot {
            snapshot_id: stored.checkpoint.checkpoint_id,
        })
        .collect();
    assert_eq!(listed, [reopened]);
    assert!(
        matches!(again, Err(ConversationCutError::Superseded)),
        "{again:?}"
    );
    assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
}

/// A cut the provider applied by forking the conversation onto `binding_id`, which runs on the
/// conversation `resume_handle` under the build `2.0.0` at `/opt/provider/fork`.
fn applied_on_fork(binding_id: &RuntimeBindingId, resume_handle: &str) -> RewindAnswer {
    let fork = ForkedBinding {
        binding_id: binding_id.clone(),
        resume_handle: NonEmptyText::new(resume_handle.to_owned()).expect("a resume handle"),
        spawned_version: spawned_build("2.0.0", "/opt/provider/fork"),
    };
    Arc::new(move || {
        Ok(RewindConversationResult::Applied {
            fork: Some(fork.clone()),
            cut_message_text: None,
        })
    })
}

// A cut to a steer the provider applied by forking the conversation moves the session onto the
// fork's binding, whose cursor opens the next epoch at the steer's point and whose row carries the
// scene's run on the fork's conversation and build, with the source conversation and the fork
// both recorded as left on the predecessor's account and recovery data, so the purge reaches the
// fork whatever becomes of its row, and closes nothing. Killed by a fork fenced as a cut in place,
// by the fence at the opening's point, by no row written, by a row written through a path that
// opens a cursor, by the left conversation taken from the fork, by the fork not recorded as left,
// by the predecessor's recovery data dropped, and by the version or path kept from the
// predecessor.
#[tokio::test]
async fn a_cut_applied_on_a_fork_moves_the_session_to_the_forks_binding() {
    let fork_binding_id = mint_runtime_binding_id();
    let scene = steer_scene(
        applied_on_fork(&fork_binding_id, "fork-conversation"),
        true,
        Form::Words(OPENING_WORDS),
    )
    .await
    .scene;
    let fixture = &scene.fixture;
    let binding_cursors = fixture.queue.provider_sessions.binding_cursors();
    let source_binding_id = binding_cursors
        .current_binding(&fixture.session_id)
        .expect("the scene's session runs on a binding");
    let recovery_data = Map::from_iter([("home".to_owned(), json!("kept"))]);
    binding_cursors
        .keep_recovery_data(source_binding_id, recovery_data.clone())
        .await
        .expect("the source binding keeps its recovery data");
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await
        .expect("the cut applies");

    assert_eq!(
        binding_cursors.current_binding(&fixture.session_id),
        Some(fork_binding_id.clone())
    );
    assert_eq!(
        binding_cursors.standing(&fork_binding_id),
        Some(epoch_position(1, STEER_POSITION - 1))
    );
    let reader = fixture.database.reader();
    let fork_row = read_binding(&reader, &fork_binding_id)
        .expect("the fork's row reads")
        .expect("the fork's row is recorded");
    let forked_build = spawned_build("2.0.0", "/opt/provider/fork");
    assert_eq!(fork_row.run_id, scene.run_id);
    assert_eq!(fork_row.resume_handle.as_deref(), Some("fork-conversation"));
    assert_eq!(fork_row.cli_version, forked_build.cli_version);
    assert_eq!(
        fork_row.resolved_executable_path,
        forked_build.resolved_executable_path.to_string_lossy()
    );
    let mut left: Vec<LeftConversation> = read_left_conversations(&reader, &fixture.session_id)
        .expect("the left conversations read")
        .into_iter()
        .map(|record| record.conversation)
        .collect();
    // Both may be stamped the same instant, so they are compared in one order.
    left.sort_by(|first, second| first.conversation_id.cmp(&second.conversation_id));
    let left_conversation = |conversation_id: &str| LeftConversation {
        session_id: fixture.session_id,
        provider_account_id: test_provider_account_id(),
        conversation_id: conversation_id.to_owned(),
        runtime_metadata: recovery_data.clone(),
    };
    assert_eq!(
        left,
        [
            left_conversation("conversation-1"),
            left_conversation("fork-conversation")
        ]
    );
    assert!(scene.closes.lock().expect("unpoisoned").is_empty());
}

// A fork whose row the store refuses, its handle past the bound, fails the cut once its process is
// closed with the append lock free, leaving the session on no binding and the fork's cursor
// closed, while the rollback stays recorded. Killed by the store's failure swallowed, by the
// fork's cursor left open, by no close, by a close with another cause, and by a close made under
// the append hold or the queue's hold.
#[tokio::test]
async fn a_fork_the_daemon_cannot_record_is_closed_and_fails_the_cut() {
    let fork_binding_id = mint_runtime_binding_id();
    let scene = scene(applied_on_fork(&fork_binding_id, &"f".repeat(4_097))).await;
    let fixture = &scene.fixture;
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    let cut = fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await;

    assert!(
        matches!(
            cut,
            Err(ConversationCutError::ForkUnrecorded(
                ProviderSessionError::Cursor(RunBindingCursorError::Store(_))
            ))
        ),
        "{cut:?}"
    );
    assert_eq!(
        *scene.closes.lock().expect("unpoisoned"),
        [ProcessClose {
            cause: SessionCloseCause::UnrecordedOpening,
            is_append_lock_free: true,
            is_queue_lock_free: true,
        }]
    );
    let binding_cursors = fixture.queue.provider_sessions.binding_cursors();
    assert_eq!(binding_cursors.current_binding(&fixture.session_id), None);
    assert!(!binding_cursors.is_binding_open(&fork_binding_id));
    assert!(
        fixture
            .event_types()
            .contains(&"agent.run.rolledBack".to_owned())
    );
}

// A target in a run that completed, with a later run of the lead after it, rolls both back in one
// write: the target's run to the turn before the target's, the later run to its start, with the
// companions committing in that write, whose guard holds only once the later run moved too.
// Killed by a later run left uncut, by a rollback written per run, and by the companions written
// apart from the later run's rollback.
#[tokio::test]
async fn a_target_in_an_earlier_run_rolls_back_every_later_run_in_one_write() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    fixture.set_run_state(scene.run_id, "completed");
    let later_run_id = fixture.insert_run("running").await;
    let companions = recovery_companions(
        &scene,
        later_run_id,
        2,
        checks_run_reaching(later_run_id, 2),
    );
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    let cut = fixture
        .queue
        .cut_conversation(&hold, &scene.target, companions)
        .await
        .expect("the cut applies");

    let ConversationCut::Applied { rollbacks, .. } = cut else {
        panic!("the provider applied the cut");
    };
    let landed: Vec<(RunId, SourcePosition)> = rollbacks
        .iter()
        .map(|rollback| (rollback.event.run_id, rollback.event.target_position))
        .collect();
    assert_eq!(
        landed,
        [
            (scene.run_id, position(TARGET_POSITION - 1)),
            (later_run_id, position(0)),
        ]
    );
    assert_eq!(fixture.run_version(scene.run_id), 2);
    assert_eq!(fixture.run_version(later_run_id), 2);
    assert!(
        fixture.event_types().ends_with(&[
            "agent.run.recovery.resolved".to_owned(),
            "agent.run.rolledBack".to_owned(),
            "agent.run.rolledBack".to_owned(),
        ]),
        "{:?}",
        fixture.event_types()
    );
}

// A run whose end is written while its turn holds no end yet is not cut: the cut is refused before
// the provider is asked and writes nothing; once the turn's end is written, it applies. Killed by
// the provider asked before the turn's end, and by a rollback written while the turn is open.
#[tokio::test]
async fn a_cut_waits_for_the_turns_end_before_the_provider_is_asked() {
    let scene = scene(applied_in_place()).await;
    let fixture = &scene.fixture;
    fixture
        .append_turn_event(scene.run_id, "agent.turn.started", TARGET_TURN_NUMBER)
        .await;
    fixture.set_run_state(scene.run_id, "interrupted");
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;

    let refused = fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await;
    let rewinds_while_open = scene.rewinds.load(Ordering::SeqCst);
    let version_while_open = fixture.run_version(scene.run_id);
    fixture
        .append_turn_event(scene.run_id, "agent.turn.completed", TARGET_TURN_NUMBER)
        .await;
    let applied = fixture
        .queue
        .cut_conversation(&hold, &scene.target, RollbackCompanions::default())
        .await;

    assert!(
        matches!(
            &refused,
            Err(ConversationCutError::TurnOpen { run_id }) if *run_id == scene.run_id
        ),
        "{refused:?}"
    );
    assert_eq!(rewinds_while_open, 0);
    assert_eq!(version_while_open, 1);
    assert!(
        matches!(applied, Ok(ConversationCut::Applied { .. })),
        "{applied:?}"
    );
    assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
}

/// A turn's opening on the run, as the provider asks the engine for it.
type Opening = JoinHandle<Result<Option<StartedTurn>, RunHostError>>;

// A turn the provider opens on the target's run once it answered the cut, while the cut waits for
// the session's queue lock, opens only after the rollback is written, and the cut lands. Killed by
// the undo's write left unmarked, where the opening writes its start within the watch and its open
// turn refuses the rollback, and by the mark never taken down, where the opening never ends.
#[tokio::test]
async fn a_turn_opened_once_the_provider_answered_opens_after_the_rollback() {
    let opened_on: Arc<OnceLock<(Arc<RunEngine>, RunId)>> = Arc::new(OnceLock::new());
    let (opening_sender, opening_receiver) = oneshot::channel::<Opening>();
    let opening_sender = Arc::new(Mutex::new(Some(opening_sender)));
    let opens = Arc::clone(&opened_on);
    let scene = scene(Arc::new(move || {
        let (engine, run_id) = opens.get().expect("the scene is set").clone();
        let opening = tokio::spawn(async move {
            RunHost::start_turn(engine.as_ref(), run_id, None, None, None).await
        });
        if let Some(sender) = opening_sender.lock().expect("unpoisoned").take() {
            assert!(
                sender.send(opening).is_ok(),
                "the test waits for the opening"
            );
        }
        Ok(RewindConversationResult::Applied {
            fork: None,
            cut_message_text: None,
        })
    }))
    .await;
    let fixture = &scene.fixture;
    assert!(
        opened_on
            .set((Arc::clone(&fixture.queue.engine), scene.run_id))
            .is_ok(),
        "the scene is set once"
    );
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, client_key())
        .await;
    let queue_lock = fixture
        .queue
        .session_lock
        .hold_session(fixture.session_id)
        .await;
    let queue = Arc::clone(&fixture.queue);
    let target = scene.target.clone();
    // The hold comes back with the cut, so its release cannot write while the log is read.
    let cut = tokio::spawn(async move {
        let cut = queue
            .cut_conversation(&hold, &target, RollbackCompanions::default())
            .await;
        (cut, hold)
    });

    let mut opening = timeout(WAIT, opening_receiver)
        .await
        .expect("the provider is asked for the cut")
        .expect("the opening is spawned");
    // Sound only on the current-thread test runtime, where the mark goes in before the opening
    // first runs; on a multi-threaded one the opening could pass its check first.
    let opened_before_the_write = timeout(HELD_WATCH, &mut opening).await.is_ok();
    drop(queue_lock);
    let (cut, _hold) = timeout(WAIT, cut)
        .await
        .expect("the cut ends")
        .expect("the cut's task ends");
    let started = timeout(WAIT, opening)
        .await
        .expect("the opening ends once the write has")
        .expect("the opening's task ends")
        .expect("the turn's start is written");

    assert!(!opened_before_the_write, "the opening waits for the write");
    assert!(
        matches!(cut, Ok(ConversationCut::Applied { .. })),
        "{cut:?}"
    );
    assert!(started.is_some(), "the run is live");
    assert!(
        fixture.event_types().ends_with(&[
            "agent.run.rolledBack".to_owned(),
            "agent.turn.started".to_owned(),
        ]),
        "{:?}",
        fixture.event_types()
    );
}

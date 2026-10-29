//! The controls that act on a session's provider process: a level move, a mode move, the follow
//! of a level its provider reported and a side question's fork.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::{
    DriverError, ProviderReportedLevel, SessionProcessState,
};
use sidekicks_provider::run::posture::{
    ExecutionPostureRejection, compose_execution_posture, resolve_posture,
};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_session::run::session_posture::SessionPostureSource as _;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_session_id;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate as _, RunSetupGateError};
use tokio::sync::Notify;

use super::Opening;
use crate::provider_session::ProviderSessionError;
use crate::provider_session::controls::SideQuestionSource;
use sidekicks_provider::driver::test_registry::new_run_id;

// A move to Sandboxed in a repository whose git folder is gone is refused before the driver hears
// of it as `workspace.rootUnavailable`, the stored level left as it was, whether the session's
// process runs, is down, or was never opened by this daemon; a move to Read-only, whose posture
// names no folder, is stored on a session with no process. Killed by resolving the posture after
// the driver's move, by answering the refusal as a fault, and by reading the folder for a level
// whose posture names none.
#[rstest]
#[case::live(Some(SessionProcessState::Live), PermissionLevel::Sandboxed)]
#[case::down(Some(SessionProcessState::Down), PermissionLevel::Sandboxed)]
#[case::not_opened(None, PermissionLevel::Sandboxed)]
#[case::not_opened_to_readonly(None, PermissionLevel::Readonly)]
#[tokio::test]
async fn a_level_move_whose_root_is_gone_is_refused_before_the_driver_moves(
    #[case] process: Option<SessionProcessState>,
    #[case] level: PermissionLevel,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        if let Some(state) = process {
            driver.expect_session_process_state().return_const(state);
        }
        driver.expect_update_permission_level().never();
    })
    .await;
    let repository = tempfile::tempdir().expect("a scratch repository");
    *lock(&opening.git_folder) = Some(
        FilesystemPath::new(repository.path().to_string_lossy().into_owned())
            .expect("the scratch repository is a path"),
    );
    if process.is_some() {
        opening
            .sessions
            .open(opening.session_id, opening.run_id)
            .await
            .expect("the conversation resumes");
    }
    store_level(&opening, PermissionLevel::Ask);
    repository.close().expect("the repository is removed");

    let moved = opening
        .sessions
        .change_level(opening.session_id, level)
        .await;

    let stored = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    if level == PermissionLevel::Readonly {
        moved.expect("a level naming no folder moves");
        assert_eq!(stored, PermissionLevel::Readonly);
    } else {
        assert!(
            matches!(moved, Err(ProviderSessionError::PostureRefused { .. })),
            "{moved:?}"
        );
        let answered = HandlerError::from(moved.expect_err("the move is refused"));
        assert!(
            matches!(&answered, HandlerError::Refused(refusal)
                if refusal.code == RefusalCode::WorkspaceRootUnavailable),
            "{answered:?}"
        );
        assert_eq!(stored, PermissionLevel::Ask);
    }
}

// A run gated at a stored Sandboxed level whose folder is gone fails with the posture's own
// rejection, which the gate counts a posture the session cannot run, worded for the run and naming
// no move. Killed by the stored read answering the move's refusal, or a fault.
#[tokio::test]
async fn a_run_gated_at_a_stored_level_whose_folder_is_gone_reads_it_unavailable() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver.expect_update_permission_level().never();
    })
    .await;
    let repository = tempfile::tempdir().expect("a scratch repository");
    let git_folder = FilesystemPath::new(repository.path().to_string_lossy().into_owned())
        .expect("the scratch repository is a path");
    *lock(&opening.git_folder) = Some(git_folder.clone());
    store_level(&opening, PermissionLevel::Ask);
    opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Sandboxed)
        .await
        .expect("the level is stored");
    repository.close().expect("the repository is removed");

    let gated = opening
        .execution_postures
        .assert_run_ready(&RunSetupContext {
            run_id: opening.run_id,
            session_id: opening.session_id,
            queue_item: None,
            workspace_id: None,
            execution_posture: compose_execution_posture(PermissionLevel::Ask, git_folder),
        })
        .await;

    let Err(RunSetupGateError::Failed(cause)) = gated else {
        panic!("the gate fails, not {gated:?}");
    };
    assert!(
        matches!(
            cause.downcast_ref::<ExecutionPostureRejection>(),
            Some(ExecutionPostureRejection::UnavailableFolder(_))
        ),
        "{cause:?}"
    );
    assert!(
        describe_error(cause.as_ref()).starts_with("the session's folder is unavailable"),
        "{cause}"
    );
}

// A level move carries a run already past its gate to the moved level's posture. Killed by a move
// that leaves the posture service's runs where they were.
#[tokio::test]
async fn a_level_move_re_postures_a_live_run() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_update_permission_level()
            .times(1)
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    store_level(&opening, PermissionLevel::Readonly);
    let root = FilesystemPath::new("/".to_owned()).expect("the root is a path");
    opening
        .execution_postures
        .assert_run_ready(&RunSetupContext {
            run_id: opening.run_id,
            session_id: opening.session_id,
            queue_item: None,
            workspace_id: None,
            execution_posture: compose_execution_posture(PermissionLevel::Readonly, root.clone()),
        })
        .await
        .expect("the run's posture resolves");

    opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Yolo)
        .await
        .expect("the level moves");

    assert_eq!(
        opening
            .execution_postures
            .resolved_posture_for(&opening.run_id),
        Some(compose_execution_posture(PermissionLevel::Yolo, root))
    );
}

// A mode move on a session whose process is down only stores it, leaving the driver alone; on one
// whose process runs or whose driver brings it back, the driver moves first, and its refusal
// leaves the stored mode as it was. A stored move tells every client in its write. Killed by
// storing before the move, by a restarting process that skips the driver, and by a move stored
// with no notice.
#[rstest]
#[case::live(SessionProcessState::Live, true)]
#[case::restarting(SessionProcessState::Restarting, true)]
#[case::down(SessionProcessState::Down, false)]
#[case::live_taken(SessionProcessState::Live, false)]
#[tokio::test]
async fn a_mode_move_reaches_the_driver_first_unless_the_process_is_down(
    #[case] state: SessionProcessState,
    #[case] is_refused: bool,
) {
    let is_down = state == SessionProcessState::Down;
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_update_session_mode()
            .times(usize::from(!is_down))
            .returning(move |_params| {
                async move {
                    if is_refused {
                        return Err(DriverError::Refused(DomainError::new(
                            "The provider refused the mode.",
                            RefusalCode::SessionModeNotOffered,
                        )));
                    }
                    Ok(())
                }
                .boxed()
            });
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let level = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");

    let moved = opening
        .sessions
        .change_mode(opening.session_id, SessionMode::Plan)
        .await;

    let stored = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    if is_refused {
        assert!(
            matches!(moved, Err(ProviderSessionError::Driver(_))),
            "{moved:?}"
        );
        assert_eq!(stored, SessionMode::Build);
        assert_eq!(posted_notices(&opening), Vec::new());
    } else {
        assert!(moved.is_ok(), "{moved:?}");
        assert_eq!(stored, SessionMode::Plan);
        assert_eq!(
            posted_notices(&opening),
            vec![controls_moved(&opening, level, SessionMode::Plan)]
        );
    }
}

// A side question's copy is forked from the session's newest conversation whether or not a
// process runs it, and a session that never ran has none to fork. Killed by resume material only
// for a session this daemon has not opened, and by none at all.
#[tokio::test]
async fn a_side_question_forks_the_newest_conversation_whatever_the_process() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
    })
    .await;
    let resume_handle =
        |source: Option<SideQuestionSource>| source.map(|source| source.resume.resume_handle);

    let at_rest = opening
        .sessions
        .side_question_source(opening.session_id)
        .await
        .expect("the resume material composes");
    let at_rest_binding = at_rest.as_ref().map(|source| source.binding_id.clone());
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let running = opening
        .sessions
        .side_question_source(opening.session_id)
        .await
        .expect("the resume material composes");
    let never_ran = test_session_id();
    insert_session_row(
        &opening.database.reader(),
        never_ran.text().as_str(),
        None,
        None,
    );
    let none = opening
        .sessions
        .side_question_source(never_ran)
        .await
        .expect("a session with no conversation reads");

    assert_eq!(at_rest_binding, Some(opening.predecessor_id.clone()));
    assert_eq!(resume_handle(at_rest).as_deref(), Some("conversation-1"));
    assert_eq!(resume_handle(running).as_deref(), Some("conversation-1"));
    assert!(none.is_none());
}

// A level Claude Code reports running on a live session moves the process's posture, the session's
// live run, the stored level and every client, told once; the report is followed whole, so a
// session stored in Plan moves to the report's Build with it. Killed by `move_session` skipped, by
// the notice dropped, by a driver move not marked as the provider's own, and by the mode left Plan.
#[tokio::test]
async fn a_followed_level_moves_a_live_session() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_reported_level()
            .return_const(Some(ProviderReportedLevel {
                level: Some(PermissionLevel::Ask),
                session_mode: SessionMode::Build,
            }));
        driver
            .expect_update_permission_level()
            .withf(|params| params.is_provider_reported)
            .times(1)
            .returning(|_params| async { Ok(()) }.boxed());
        driver
            .expect_update_session_mode()
            .withf(|params| params.is_provider_reported && params.mode == SessionMode::Build)
            .times(1)
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    store_level(&opening, PermissionLevel::Readonly);
    store_plan_mode(&opening);
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let root = FilesystemPath::new("/".to_owned()).expect("the root is a path");
    opening
        .execution_postures
        .assert_run_ready(&RunSetupContext {
            run_id: opening.run_id,
            session_id: opening.session_id,
            queue_item: None,
            workspace_id: None,
            execution_posture: compose_execution_posture(PermissionLevel::Readonly, root.clone()),
        })
        .await
        .expect("the run's posture resolves");

    opening
        .sessions
        .follow_reported_level(opening.session_id)
        .await
        .expect("the reported level is followed");

    let stored = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    assert_eq!(stored, PermissionLevel::Ask);
    let stored_mode = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    assert_eq!(stored_mode, SessionMode::Build);
    assert_eq!(
        opening
            .execution_postures
            .resolved_posture_for(&opening.run_id),
        Some(compose_execution_posture(PermissionLevel::Ask, root))
    );
    assert_eq!(
        posted_notices(&opening),
        vec![level_moved(&opening, PermissionLevel::Ask)]
    );
}

// A report that lands while the person's own move holds the session's lock is followed once that
// move is stored, from the newest report, so the reported level is the one left standing and the
// notices arrive in the order the moves were stored. Killed by the follow taken outside the lock,
// which stores the reported level first and the person's over it.
#[tokio::test]
async fn a_report_during_a_move_is_followed_after_it() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (driver_entered, driver_release) = (Arc::clone(&entered), Arc::clone(&release));
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_reported_level()
            .return_const(Some(ProviderReportedLevel {
                level: Some(PermissionLevel::Ask),
                session_mode: SessionMode::Build,
            }));
        driver
            .expect_update_permission_level()
            .times(2)
            .returning(move |params| {
                let (entered, release) = (Arc::clone(&driver_entered), Arc::clone(&driver_release));
                async move {
                    // The person's move waits inside the driver, holding the session's lock.
                    if !params.is_provider_reported {
                        entered.notify_one();
                        release.notified().await;
                    }
                    Ok(())
                }
                .boxed()
            });
    })
    .await;
    let repository = tempfile::tempdir().expect("a scratch repository");
    *lock(&opening.git_folder) = Some(
        FilesystemPath::new(repository.path().to_string_lossy().into_owned())
            .expect("the scratch repository is a path"),
    );
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    let sessions = Arc::clone(&opening.sessions);
    let session_id = opening.session_id;
    let moved = tokio::spawn(async move {
        sessions
            .change_level(session_id, PermissionLevel::Sandboxed)
            .await
    });
    entered.notified().await;
    let transition_lock = Arc::clone(opening.changes.transition_lock());
    let held_alone = transition_lock.queue_handle_count(session_id);
    let sessions = Arc::clone(&opening.sessions);
    let followed = tokio::spawn(async move { sessions.follow_reported_level(session_id).await });
    tokio::time::timeout(
        Duration::from_secs(5),
        transition_lock.wait_for_queue_past(session_id, held_alone),
    )
    .await
    .expect("the follow waits on the session's lock");
    release.notify_one();
    moved
        .await
        .expect("the move's task ends")
        .expect("the level moves");
    followed
        .await
        .expect("the follow's task ends")
        .expect("the reported level is followed");

    let stored = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    assert_eq!(stored, PermissionLevel::Ask);
    assert_eq!(
        posted_notices(&opening),
        vec![
            level_moved(&opening, PermissionLevel::Sandboxed),
            level_moved(&opening, PermissionLevel::Ask),
        ]
    );
}

// A report of the level the session is stored at moves nothing and tells no client. Killed by a
// notice appended, or the driver called, with nothing moved.
#[tokio::test]
async fn a_report_of_the_stored_level_moves_nothing() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_reported_level()
            .return_const(Some(ProviderReportedLevel {
                level: Some(PermissionLevel::Readonly),
                session_mode: SessionMode::Build,
            }));
        driver.expect_update_permission_level().never();
        driver.expect_update_session_mode().never();
    })
    .await;
    store_level(&opening, PermissionLevel::Readonly);
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    opening
        .sessions
        .follow_reported_level(opening.session_id)
        .await
        .expect("the report is read");

    assert_eq!(posted_notices(&opening), Vec::new());
}

// Stores `level` as the session's, as a move before the test would have.
fn store_level(opening: &Opening, level: PermissionLevel) {
    opening
        .database
        .reader()
        .execute(
            "UPDATE sessions SET permission_level = ?1 WHERE id = ?2",
            params![
                <&'static str>::from(level),
                opening.session_id.text().as_str()
            ],
        )
        .expect("the test stores the level");
}

// Stores Plan as the session's mode, as a move before the test would have.
fn store_plan_mode(opening: &Opening) {
    opening
        .database
        .reader()
        .execute(
            "INSERT INTO session_console_state (session_id, session_mode, updated_at)
              VALUES (?1, 'plan', ?2)",
            params![
                opening.session_id.text().as_str(),
                WireInstant::now().as_str()
            ],
        )
        .expect("the test stores the mode");
}

// Every notice the session's log holds, in log order.
fn posted_notices(opening: &Opening) -> Vec<SessionNoticePostedPayload> {
    opening
        .database
        .reader()
        .prepare(
            "SELECT payload FROM session_events WHERE session_id = ?1 AND type = ?2
              ORDER BY sequence",
        )
        .expect("the test reads the log")
        .query_map(
            params![
                opening.session_id.text().as_str(),
                SessionEventType::SessionNoticePosted.as_str()
            ],
            |row| row.get::<_, String>(0),
        )
        .expect("the log reads")
        .map(|payload| {
            serde_json::from_str(&payload.expect("a payload reads")).expect("a notice reads")
        })
        .collect()
}

// The notice of the session moved to `level`, its mode the stored Build.
fn level_moved(opening: &Opening, level: PermissionLevel) -> SessionNoticePostedPayload {
    controls_moved(opening, level, SessionMode::Build)
}

// The notice of the session standing at `level` and `session_mode` after a move.
fn controls_moved(
    opening: &Opening,
    level: PermissionLevel,
    session_mode: SessionMode,
) -> SessionNoticePostedPayload {
    SessionNoticePostedPayload::Notice(SessionNotice::LevelMoved {
        session_id: opening.session_id,
        level,
        session_mode,
    })
}

// The run gate's context for `run_id` of the opening's session, requested at `level` over `/`.
fn gated_at(opening: &Opening, run_id: RunId, level: PermissionLevel) -> RunSetupContext {
    RunSetupContext {
        run_id,
        session_id: opening.session_id,
        queue_item: None,
        workspace_id: None,
        execution_posture: compose_execution_posture(level, slash()),
    }
}

fn slash() -> FilesystemPath {
    FilesystemPath::new("/".to_owned()).expect("the root is a path")
}

// A level move whose store fails moves the driver back, and a run gated while it moves back runs
// at the stored level, as the session's live run does: no run holds a posture its session never
// stored. Killed by moving the session's runs before the store.
#[tokio::test]
async fn a_run_gated_while_a_failed_move_settles_runs_at_the_stored_level() {
    let moving_back = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (driver_moving_back, driver_release) = (Arc::clone(&moving_back), Arc::clone(&release));
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_update_permission_level()
            .times(2)
            .returning(move |params| {
                let (moving_back, release) =
                    (Arc::clone(&driver_moving_back), Arc::clone(&driver_release));
                async move {
                    // The move back, once the store failed, waits for the test's gate.
                    if params.execution_posture.permission_level() == PermissionLevel::Readonly {
                        moving_back.notify_one();
                        release.notified().await;
                    }
                    Ok(())
                }
                .boxed()
            });
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    store_level(&opening, PermissionLevel::Readonly);
    opening
        .execution_postures
        .assert_run_ready(&gated_at(
            &opening,
            opening.run_id,
            PermissionLevel::Readonly,
        ))
        .await
        .expect("the run's posture resolves");
    opening
        .database
        .reader()
        .execute_batch(
            "CREATE TRIGGER refuse_level BEFORE UPDATE OF permission_level ON sessions
             BEGIN SELECT RAISE(ABORT, 'the test refuses the level'); END;",
        )
        .expect("the test refuses every stored level");

    let sessions = Arc::clone(&opening.sessions);
    let session_id = opening.session_id;
    let moved = tokio::spawn(async move {
        sessions
            .change_level(session_id, PermissionLevel::Yolo)
            .await
    });
    moving_back.notified().await;
    let window = new_run_id();
    opening
        .execution_postures
        .assert_run_ready(&gated_at(&opening, window, PermissionLevel::Readonly))
        .await
        .expect("the window's run's posture resolves");
    release.notify_one();
    let moved = moved.await.expect("the move's task ends");

    assert!(
        matches!(moved, Err(ProviderSessionError::LevelNotStored { .. })),
        "{moved:?}"
    );
    let readonly = compose_execution_posture(PermissionLevel::Readonly, slash());
    for run_id in [opening.run_id, window] {
        assert_eq!(
            opening.execution_postures.resolved_posture_for(&run_id),
            Some(readonly.clone())
        );
    }
    let next = new_run_id();
    opening
        .execution_postures
        .assert_run_ready(&gated_at(&opening, next, PermissionLevel::Readonly))
        .await
        .expect("the next run's posture resolves");
    assert_eq!(
        opening.execution_postures.resolved_posture_for(&next),
        Some(readonly)
    );
}

// A report of a mode alone moves the stored mode and tells every client, the level kept, the
// driver told the move is the provider's own: Claude Code's own `plan` on a Build session, and its
// leaving Plan reported at the stored level. Killed by a follow that moves nothing on a report
// with no level move.
#[rstest]
#[case::plan_reported(false, None, SessionMode::Plan)]
#[case::build_reported_at_the_stored_level(
    true,
    Some(PermissionLevel::Readonly),
    SessionMode::Build
)]
#[tokio::test]
async fn a_reported_mode_alone_moves_the_stored_mode(
    #[case] is_stored_plan: bool,
    #[case] reported_level: Option<PermissionLevel>,
    #[case] reported_mode: SessionMode,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_reported_level()
            .return_const(Some(ProviderReportedLevel {
                level: reported_level,
                session_mode: reported_mode,
            }));
        driver.expect_update_permission_level().never();
        driver
            .expect_update_session_mode()
            .withf(move |params| params.is_provider_reported && params.mode == reported_mode)
            .times(1)
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    store_level(&opening, PermissionLevel::Readonly);
    if is_stored_plan {
        store_plan_mode(&opening);
    }
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    opening
        .sessions
        .follow_reported_level(opening.session_id)
        .await
        .expect("the reported mode is followed");

    let stored_mode = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    assert_eq!(stored_mode, reported_mode);
    let stored = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    assert_eq!(stored, PermissionLevel::Readonly);
    assert_eq!(
        posted_notices(&opening),
        vec![controls_moved(
            &opening,
            PermissionLevel::Readonly,
            reported_mode
        )]
    );
}

// A level stored while no process of the session runs is the one a run admitted before the store
// gates at, though its admission read the earlier level. Killed by a gate that runs a session with
// no moved posture at the posture its run was requested at.
#[tokio::test]
async fn a_level_stored_with_no_process_is_the_one_a_run_gates_at() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_driver, _| {}).await;
    store_level(&opening, PermissionLevel::Readonly);

    opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Yolo)
        .await
        .expect("the level is stored");
    opening
        .execution_postures
        .assert_run_ready(&gated_at(
            &opening,
            opening.run_id,
            PermissionLevel::Readonly,
        ))
        .await
        .expect("the run's posture resolves");

    assert_eq!(
        opening
            .execution_postures
            .resolved_posture_for(&opening.run_id),
        Some(compose_execution_posture(PermissionLevel::Yolo, slash()))
    );
}

// A session whose process is gone keeps no moved posture: a move to Sandboxed over a git folder
// removed since is let go, so the next run gates at the stored level over the folder the next
// opening names. Killed by keeping the moved posture past the process.
#[tokio::test]
async fn a_gone_process_keeps_no_moved_posture() {
    let is_down = Arc::new(AtomicBool::new(false));
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), {
        let is_down = Arc::clone(&is_down);
        move |driver, _| {
            driver.expect_session_process_state().returning(move |_| {
                if is_down.load(Ordering::SeqCst) {
                    SessionProcessState::Down
                } else {
                    SessionProcessState::Live
                }
            });
            driver
                .expect_update_permission_level()
                .returning(|_params| async { Ok(()) }.boxed());
        }
    })
    .await;
    let moved_folder = tempfile::tempdir().expect("a scratch git folder");
    *lock(&opening.git_folder) = Some(path_of(moved_folder.path()));
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Sandboxed)
        .await
        .expect("the level moves");

    is_down.store(true, Ordering::SeqCst);
    opening
        .sessions
        .forget_gone_process(opening.session_id)
        .await
        .expect("the gone process is forgotten");
    moved_folder
        .close()
        .expect("the moved git folder is removed");
    let next_folder = tempfile::tempdir().expect("the next opening's git folder");
    *lock(&opening.git_folder) = Some(path_of(next_folder.path()));

    opening
        .execution_postures
        .assert_run_ready(&gated_at(
            &opening,
            opening.run_id,
            PermissionLevel::Readonly,
        ))
        .await
        .expect("the run gates at the stored level over the next opening's folder");
    let resolved = opening
        .execution_postures
        .resolved_posture_for(&opening.run_id)
        .expect("the run holds a posture");
    let over_next_folder = resolve_posture(&compose_execution_posture(
        PermissionLevel::Sandboxed,
        path_of(next_folder.path()),
    ))
    .await
    .expect("the next opening's folder resolves");
    assert_eq!(resolved, over_next_folder);
}

// A level stored while the session's process is down, the driver to bring it back, is the posture
// that process's runs are requested at. Killed by leaving a down process's opened posture at its
// earlier level.
#[tokio::test]
async fn a_down_process_takes_the_level_stored_meanwhile() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Down);
        driver.expect_update_permission_level().never();
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    store_level(&opening, PermissionLevel::Readonly);

    opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Yolo)
        .await
        .expect("the level is stored");

    let opened = opening
        .sessions
        .opened_execution_posture(&opening.session_id)
        .expect("the down process stays opened");
    assert_eq!(opened.permission_level(), PermissionLevel::Yolo);
}

fn path_of(folder: &std::path::Path) -> FilesystemPath {
    FilesystemPath::new(folder.to_string_lossy().into_owned()).expect("a scratch folder is a path")
}

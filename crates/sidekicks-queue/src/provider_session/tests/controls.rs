//! The controls that act on a session's provider process: a level move, a mode move, the follow
//! of a level its provider reported and a side question's fork.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{
    DriverError, ProviderReportedLevel, SessionProcessState,
};
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_session_id;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate as _};
use tokio::sync::Notify;

use super::Opening;
use crate::provider_session::ProviderSessionError;
use crate::provider_session::controls::SideQuestionSource;

// A move to Sandboxed in a repository whose git folder is gone since the process opened is refused
// before the driver hears of it, the stored level left as it was. Killed by resolving the posture
// after the driver's move.
#[tokio::test]
async fn a_level_move_whose_root_is_gone_is_refused_before_the_driver_moves() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver.expect_update_permission_level().never();
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
    let stored_before =
        read_session_permission_level(&opening.database.reader(), &opening.session_id)
            .expect("the stored level reads");
    repository.close().expect("the repository is removed");

    let moved = opening
        .sessions
        .change_level(opening.session_id, PermissionLevel::Sandboxed)
        .await;

    assert!(
        matches!(moved, Err(ProviderSessionError::PostureRefused { .. })),
        "{moved:?}"
    );
    let stored = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    assert_eq!(stored, stored_before);
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
// leaves the stored mode as it was. Killed by storing before the move, and by a restarting process
// that skips the driver.
#[rstest]
#[case::live(SessionProcessState::Live)]
#[case::restarting(SessionProcessState::Restarting)]
#[case::down(SessionProcessState::Down)]
#[tokio::test]
async fn a_mode_move_reaches_the_driver_first_unless_the_process_is_down(
    #[case] state: SessionProcessState,
) {
    let is_down = state == SessionProcessState::Down;
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_update_session_mode()
            .times(usize::from(!is_down))
            .returning(|_params| {
                async {
                    Err(DriverError::Refused(DomainError::new(
                        "The provider refused the mode.",
                        RefusalCode::SessionModeNotOffered,
                    )))
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

    let moved = opening
        .sessions
        .change_mode(opening.session_id, SessionMode::Plan)
        .await;

    let stored = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    if is_down {
        assert!(moved.is_ok(), "{moved:?}");
        assert_eq!(stored, SessionMode::Plan);
    } else {
        assert!(
            matches!(moved, Err(ProviderSessionError::Driver(_))),
            "{moved:?}"
        );
        assert_eq!(stored, SessionMode::Build);
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
// live run, the stored level and every client, told once. Killed by `move_session` skipped, by the
// notice dropped, and by a driver move not marked as the provider's own.
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
    })
    .await;
    store_level(&opening, PermissionLevel::Readonly);
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
    let sessions = Arc::clone(&opening.sessions);
    let followed = tokio::spawn(async move { sessions.follow_reported_level(session_id).await });
    // Long enough for a follow that took no lock to finish before the person's move is stored.
    tokio::time::sleep(Duration::from_millis(200)).await;
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
    SessionNoticePostedPayload::Notice(SessionNotice::LevelMoved {
        session_id: opening.session_id,
        level,
        session_mode: SessionMode::Build,
    })
}

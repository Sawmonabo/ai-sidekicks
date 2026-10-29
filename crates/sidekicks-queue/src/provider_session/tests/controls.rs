//! The controls that act on a session's provider process: a level move, a mode move and a side
//! question's fork.

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, SessionProcessState};
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_session_id;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate as _};

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

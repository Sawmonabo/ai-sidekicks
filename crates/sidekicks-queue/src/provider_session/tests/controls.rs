//! The controls that act on a session's provider process: a mode move, a side question's fork
//! and a review's start.

use std::sync::Mutex;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::{
    SessionCodeReviewStartRequest, SessionMode, SessionReviewTarget,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, SessionProcessState};
use sidekicks_provider::driver::session_control::ResumeSessionParams;
use sidekicks_session::console_state::read_session_mode;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_session_id;

use super::Opening;
use crate::provider_session::ProviderSessionError;

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
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver, _| {
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
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
    })
    .await;
    let resume_handle =
        |resume: Option<ResumeSessionParams>| resume.map(|params| params.resume_handle);

    let at_rest = opening
        .sessions
        .side_question_resume(opening.session_id)
        .await
        .expect("the resume material composes");
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let running = opening
        .sessions
        .side_question_resume(opening.session_id)
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
        .side_question_resume(never_ran)
        .await
        .expect("a session with no conversation reads");

    assert_eq!(resume_handle(at_rest).as_deref(), Some("conversation-1"));
    assert_eq!(resume_handle(running).as_deref(), Some("conversation-1"));
    assert!(none.is_none());
}

// On a session whose process runs, a review starts through the driver at once and nothing is
// queued; on one whose process is down or being brought back, the review is queued as the
// session's next item and the driver is not called. Killed by a direct driver call that skips the
// queue, and by queueing a review a running process could start.
#[rstest]
#[case::live(SessionProcessState::Live)]
#[case::restarting(SessionProcessState::Restarting)]
#[case::down(SessionProcessState::Down)]
#[tokio::test]
async fn a_review_starts_at_once_only_on_a_running_process(#[case] state: SessionProcessState) {
    let is_live = state == SessionProcessState::Live;
    let opening = Opening::new(Box::new(|| {}), Box::new(|| {}), |driver, _| {
        driver.expect_session_process_state().return_const(state);
        driver
            .expect_start_review()
            .times(usize::from(is_live))
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let request = SessionCodeReviewStartRequest {
        session_id: opening.session_id,
        target: SessionReviewTarget::WorkingTree,
    };
    let queued = Mutex::new(Vec::new());

    opening
        .sessions
        .start_review(request.clone(), |request| {
            queued
                .lock()
                .expect("the queued reviews' lock holds")
                .push(request);
            std::future::ready(Ok(()))
        })
        .await
        .expect("the review starts");

    let queued = queued.into_inner().expect("the queued reviews' lock holds");
    if is_live {
        assert!(queued.is_empty(), "{queued:?}");
    } else {
        assert_eq!(queued, [request]);
    }
}

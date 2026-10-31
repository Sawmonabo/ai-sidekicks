//! A session's process restarted or gone: a restart its provider cannot take is refused before its
//! driver, and a process gone with no restart pending is forgotten.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_provider::driver::contract::params_and_results::SessionProcessState;

use super::Opening;
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::test_opening::record_first_provider_capabilities;

// A restart reaches no driver whose provider cannot resume: it is refused with its code and no
// process comes up. Killed by the capability check dropped: the driver that cannot resume is
// resumed.
#[tokio::test]
async fn a_restart_the_provider_cannot_take_is_refused_before_its_driver() {
    let resumes = Arc::new(AtomicUsize::new(0));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
        |_, _| {},
    )
    .await;
    record_first_provider_capabilities(&opening.sessions.deps.providers, false);

    let restarted = opening.sessions.restart(opening.session_id).await;

    assert!(
        matches!(
            &restarted,
            Err(ProviderSessionError::Provider(refusal))
                if refusal.code == RefusalCode::ProviderCapabilityUnsupported
        ),
        "{restarted:?}"
    );
    assert_eq!(resumes.load(Ordering::SeqCst), 0, "no process comes up");
}

// A process gone with no restart pending is forgotten, so the next admission resumes the session
// again; one its driver brings back keeps its opening. Killed by a process gone that is not
// forgotten (the second open resumes nothing), and by forgetting a process the driver restarts.
#[rstest]
#[case::down(SessionProcessState::Down, 2)]
#[case::restarting(SessionProcessState::Restarting, 1)]
#[tokio::test]
async fn a_gone_process_is_forgotten_only_with_no_restart_pending(
    #[case] state: SessionProcessState,
    #[case] expected_resumes: usize,
) {
    let resumes = Arc::new(AtomicUsize::new(0));
    let opening = Opening::new(
        Box::new({
            let resumes = Arc::clone(&resumes);
            move |_| {
                resumes.fetch_add(1, Ordering::SeqCst);
            }
        }),
        Box::new(|| {}),
        |driver, _| {
            driver.expect_session_process_state().return_const(state);
        },
    )
    .await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    opening
        .sessions
        .forget_gone_process(opening.session_id)
        .await
        .expect("the driver answers");
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the session opens again");

    assert_eq!(resumes.load(Ordering::SeqCst), expected_resumes);
}

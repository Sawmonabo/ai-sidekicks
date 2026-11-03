//! A session's process restarted or gone: a restart its provider cannot take is refused before its
//! driver, a process gone with no restart pending is forgotten, and the start's settle of the calls
//! a session held in the background leaves one this daemon opened to its process.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_provider::driver::contract::params_and_results::SessionProcessState;

use super::Opening;
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::test_opening::{
    read_provider_missing_notices, record_first_provider_capabilities,
};

// A restart reaches no driver whose provider cannot resume: it is refused with its code, no
// process comes up, and the provider, installed, is not posted missing. Killed by the capability
// check dropped: the driver that cannot resume is resumed, and by every refusal of the check
// posting the `providerMissing` notice.
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
    assert_eq!(
        read_provider_missing_notices(&opening.database.reader()),
        Vec::new()
    );
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

// The start's settle of the calls a session held in the background skips a session this daemon
// already opened, whose process's resume rebuilt its calls: it answers at once and its driver is
// not asked, which the mock, holding no expectation of the settle, would refuse. Killed by the
// opened check removed (the driver is asked to settle).
#[tokio::test]
async fn a_session_this_daemon_opened_keeps_its_held_calls_for_its_process() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");

    opening
        .sessions
        .settle_held_tool_calls(opening.session_id)
        .await
        .expect("the settle answers");
}

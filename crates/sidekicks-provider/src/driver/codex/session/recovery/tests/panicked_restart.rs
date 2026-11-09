//! A restart that panics still ends: its mark is removed and its waiters are told.

use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service_whose_start_waits;
use crate::driver::codex::session::recovery::build_move::CodexServiceRestart;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::codex::session::test_fixture::relaunches::{
    RefusedRelaunchStep, TakenRelaunches,
};
use crate::driver::ports::SessionRelaunchListener;
use crate::runtime_binding::resume::ResumeFunctionLegs;

// Killed by a restart task that drops no mark as it unwinds: the service then reads as
// restarting for good and the waiter, its sender kept in the recovery, is never told, so the
// bound fails. Real time under a bound.
#[tokio::test]
async fn a_restart_that_panics_clears_its_mark_and_tells_its_waiter() {
    tokio::time::timeout(
        Duration::from_secs(30),
        Box::pin(async {
            let session =
                TestCodexSession::start_on(start_scripted_codex_service_whose_start_waits()).await;
            let folder = tempfile::tempdir().expect("the test makes a folder");
            // The session directory's stand-in panics as the restart opens the resume's binding,
            // after the service came back up.
            let session_relaunched = Arc::new(PortRegistration::new("session relaunched"));
            let relaunches: Arc<dyn SessionRelaunchListener> = Arc::new(TakenRelaunches {
                heard: Box::new(|step| {
                    assert!(!step.starts_with("opened"), "the restart panics at {step}");
                }),
                refused: RefusedRelaunchStep::Nothing,
                legs: ResumeFunctionLegs::default(),
            });
            session_relaunched
                .register(relaunches)
                .expect("the port registers once");
            let recovery = session.recovery(
                folder.path(),
                Arc::new(PortRegistration::new("reviewer denial")),
                Arc::new(PortRegistration::new("process gone")),
                session_relaunched,
            );
            let TestCodexSession {
                scripted, mut task, ..
            } = session;
            let service = Arc::clone(&scripted.service);

            let connection = scripted.publish_reconnecting();
            let mut restarting =
                std::pin::pin!(recovery.restart_and_wait(&service, CodexServiceRestart::InPlace));
            task.drive(async {
                tokio::select! {
                    restarted = &mut restarting => {
                        panic!("the restart waits for its new process: {restarted:?}")
                    }
                    () = scripted.publish_up_once_starting(connection) => {}
                }
            })
            .await;
            let restarted = task.drive(restarting).await;

            let failure = restarted.expect_err("a restart that panicked restarted nothing");
            assert!(
                failure.to_string().contains("ended without an answer"),
                "{failure}"
            );
            assert!(
                !recovery.is_restarting(service.id()),
                "the panicked restart's mark is gone"
            );
        }),
    )
    .await
    .expect("the waiter is told within the bound");
}

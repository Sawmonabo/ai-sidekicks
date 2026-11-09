//! A build change that joins a service's restart under way runs in one more restart after it.

use std::sync::Arc;
use std::time::Duration;

use super::{account_restart_session, serve_resumes};
use crate::driver::codex::session::recovery::build_move::CodexServiceRestart;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::ProviderBuildChange;

// Killed by a joined build change dropped: no second restart runs, so the session's second read
// never comes and the session is never told of the new build; and by a joined request that starts
// a restart of its own, whose waiter then hears the first restart's failure. Real time under a
// bound.
#[tokio::test]
async fn a_build_change_joined_during_a_restart_is_applied_after_it() {
    tokio::time::timeout(
        Duration::from_secs(30),
        Box::pin(async {
            let (session, _folder, steps, recovery) = Box::pin(account_restart_session()).await;
            let settings = session.task.record.thread_settings.clone();
            let TestCodexSession {
                scripted,
                mut task,
                engine,
                ..
            } = session;
            let service = Arc::clone(&scripted.service);
            let change = ProviderBuildChange {
                from_version: "0.163.0".to_owned(),
                to_version: "0.164.0".to_owned(),
            };

            recovery.request_restart(&service, CodexServiceRestart::InPlace);
            let first_read = task.next_item().await;
            let joined =
                recovery.restart_and_wait(&service, CodexServiceRestart::Beside(Some(change)));
            // The first restart fails at once, as a service down after a crash loop refuses a
            // start; the joined change's restart, on that service down, restarts it in place and
            // reads the session again.
            let connection = scripted.publish_crash_loop();
            task.handle(first_read).await;
            let second_read = task.next_item().await;
            scripted.publish_reconnecting();
            task.handle(second_read).await;
            task.drive(scripted.publish_up_once_starting(connection))
                .await;
            let service_side = tokio::spawn(serve_resumes(scripted.script, settings, steps));
            let restarted = task.drive(joined).await;
            service_side.abort();

            restarted.expect("the joined change's restart resumes the conversation");
            let is_told = engine.deliveries().into_iter().any(|delivery| {
                delivery.kind == "sessionNotice"
                    && delivery.payload.is_some_and(|payload| {
                        let payload = payload.to_string();
                        payload.contains("0.163.0") && payload.contains("0.164.0")
                    })
            });
            assert!(
                is_told,
                "the session is told of the build the joined change moved it to"
            );
        }),
    )
    .await
    .expect("the restarts end within the bound");
}

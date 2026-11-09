use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Map, json};
use sidekicks_std::port_registration::PortRegistration;
use tokio::time::{Instant, timeout};

use super::{CodexServiceRestarts, purge_codex_conversations};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service_whose_start_waits;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
use crate::driver::codex::session::recovery::CodexServiceRecovery;
use crate::driver::codex::session::recovery::build_move::CodexServiceRestart;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::{PurgeSessionParams, SessionConversation};
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The conversation whose delete Codex never answers.
const MISSED_THREAD: &str = "missed-thread";

/// An older conversation of the same session on the same service.
const LATER_THREAD: &str = "later-thread";

/// Another session's conversation on the same service, purged while the restart runs.
const OTHER_SESSION_THREAD: &str = "other-session-thread";

/// The recovery's restarts, each request a purge makes counted.
struct CountedRestarts {
    recovery: Arc<CodexServiceRecovery>,
    requests: AtomicUsize,
}

impl CodexServiceRestarts for CountedRestarts {
    fn is_restarting(&self, service_id: CodexServiceId) -> bool {
        self.recovery.is_restarting(service_id)
    }

    fn restart(&self, service: &Arc<CodexService>) {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.recovery
            .request_restart(service, CodexServiceRestart::InPlace);
    }
}

fn conversation(thread_id: &str) -> SessionConversation {
    SessionConversation {
        resume_handle: thread_id.to_owned(),
        provider_account_id: test_provider_account_id(),
        runtime_metadata: Map::new(),
    }
}

// Killed by a delete sent before its conversation is let go, or with no let-go; by a delete bound
// other than 60 s; by a miss answered as deleted; by a later conversation of either session sent
// to the service while its restart runs; by a miss that asks no restart, or more than one; by a
// restart whose mark is gone while it runs; and by a restart that does not first read the home's
// live session, as the recovery's restart does so it can resume it.
#[tokio::test(start_paused = true)]
async fn a_missed_delete_restarts_its_service_once_and_no_purge_sends_it_more_meanwhile() {
    let scripted = start_scripted_codex_service_whose_start_waits();
    scripted.mark_started();
    let mut session = TestCodexSession::start_on(scripted).await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let recovery = session.recovery(
        folder.path(),
        Arc::new(PortRegistration::new("reviewer denial")),
        Arc::new(PortRegistration::new("process gone")),
        Arc::new(PortRegistration::new("session relaunched")),
    );
    let registry = CodexServiceRegistry::holding(&session.scripted);
    let restarts = CountedRestarts {
        recovery: Arc::clone(&recovery),
        requests: AtomicUsize::new(0),
    };
    let params = PurgeSessionParams {
        session_id: new_session_id(),
        conversations: vec![conversation(MISSED_THREAD), conversation(LATER_THREAD)],
    };
    let roles = folder.path().join("roles");
    let began = Instant::now();

    let (purged, ()) = tokio::join!(
        purge_codex_conversations(
            &registry,
            &restarts,
            &roles,
            Duration::from_secs(1),
            &params
        ),
        async {
            let unsubscribe = session.scripted.next_request("thread/unsubscribe").await;
            assert_eq!(unsubscribe["params"]["threadId"], MISSED_THREAD);
            session
                .scripted
                .script
                .answer(&unsubscribe, &json!({"status": "unsubscribed"}));
            let delete = session.scripted.next_request("thread/delete").await;
            assert_eq!(delete["params"]["threadId"], MISSED_THREAD);
        },
    );
    let waited = began.elapsed();
    let other_session = PurgeSessionParams {
        session_id: new_session_id(),
        conversations: vec![conversation(OTHER_SESSION_THREAD)],
    };
    let other_began = Instant::now();
    let other_purged = purge_codex_conversations(
        &registry,
        &restarts,
        &roles,
        Duration::from_secs(1),
        &other_session,
    )
    .await;
    let other_waited = other_began.elapsed();
    recovery.request_restart(&session.scripted.service, CodexServiceRestart::InPlace);
    let is_still_restarting = recovery.is_restarting(session.scripted.service.id());
    let sent_after = session
        .scripted
        .script
        .next_sent_within(Duration::from_secs(5))
        .await;
    let read = timeout(Duration::from_secs(5), session.task.next_item())
        .await
        .expect("the restart reads the home's live session before it stops the service");
    let is_session_read = matches!(
        read,
        CodexSessionInbound::Call(CodexSessionCall::ReadSession { .. })
    );
    session.task.handle(read).await;
    let restarted = timeout(
        Duration::from_secs(5),
        session.scripted.publish_up_once_starting(None),
    )
    .await;

    let failed = purged.expect_err("a delete Codex never answered is no deletion");
    assert_eq!(failed.failures.len(), 2, "{failed}");
    assert!(
        waited >= Duration::from_secs(60) && waited < Duration::from_secs(61),
        "the purge answered after {waited:?}"
    );
    let other_failed = other_purged.expect_err("a restarting service deletes nothing");
    assert_eq!(other_failed.failures.len(), 1, "{other_failed}");
    assert!(
        other_waited < Duration::from_secs(1),
        "the other purge answered after {other_waited:?}"
    );
    assert_eq!(sent_after, None, "the service that missed was sent more");
    assert_eq!(restarts.requests.load(Ordering::SeqCst), 1);
    assert!(
        is_still_restarting,
        "a further request finds the restart under way"
    );
    assert!(
        is_session_read,
        "the restart's first ask of the session reads it"
    );
    assert!(restarted.is_ok(), "the restart started no new process");
}

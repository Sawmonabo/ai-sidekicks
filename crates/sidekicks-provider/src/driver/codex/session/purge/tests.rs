use std::time::Duration;

use serde_json::{Map, json};
use tokio::time::Instant;

use super::{CODEX_THREAD_DELETE_TIMEOUT, purge_codex_conversations};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service_whose_start_waits;
use crate::driver::session_control::{PurgeSessionParams, SessionConversation};
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;

const THREAD: &str = "purged-thread";

// Killed by a delete sent before the conversation is let go, or with no let-go; by a delete
// awaited past the limit, or under another; by a miss answered as deleted; and by a miss that
// restarts no service. The service's own start waits, so the restart is seen as it starts.
#[tokio::test(start_paused = true)]
async fn a_purge_lets_go_before_the_delete_and_restarts_the_service_on_a_missed_delete() {
    let mut scripted = start_scripted_codex_service_whose_start_waits();
    scripted.mark_started();
    let registry = CodexServiceRegistry::holding(&scripted);
    let roles = tempfile::tempdir().expect("the test makes a folder");
    let params = PurgeSessionParams {
        session_id: new_session_id(),
        conversations: vec![SessionConversation {
            resume_handle: THREAD.to_owned(),
            provider_account_id: test_provider_account_id(),
            runtime_metadata: Map::new(),
        }],
    };
    let began = Instant::now();

    let (purged, ()) = tokio::join!(
        purge_codex_conversations(&registry, roles.path(), Duration::from_secs(1), &params),
        async {
            let unsubscribe = scripted.next_request("thread/unsubscribe").await;
            assert_eq!(unsubscribe["params"]["threadId"], THREAD);
            scripted
                .script
                .answer(&unsubscribe, &json!({"status": "unsubscribed"}));
            let delete = scripted.next_request("thread/delete").await;
            assert_eq!(delete["params"]["threadId"], THREAD);
        },
    );
    let waited = began.elapsed();
    let restarted = tokio::time::timeout(
        Duration::from_secs(5),
        scripted.publish_up_once_starting(None),
    )
    .await;

    let failed = purged.expect_err("a delete Codex never answered is no deletion");
    assert_eq!(failed.failures.len(), 1, "{failed}");
    assert!(
        waited >= CODEX_THREAD_DELETE_TIMEOUT
            && waited < CODEX_THREAD_DELETE_TIMEOUT + Duration::from_secs(1),
        "the purge answered after {waited:?}"
    );
    assert!(restarted.is_ok(), "the missed delete restarted no service");
}

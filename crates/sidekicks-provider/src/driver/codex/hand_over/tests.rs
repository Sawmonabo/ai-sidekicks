use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use serde_json::json;
use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use super::summarize_on_copy;
use crate::driver::codex::pricing::CodexRecorderPricing;
use crate::driver::codex::service::supervisor::test_service::{bind_test_listener, send_on_socket};
use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::session::side_questions::test_copies::{
    COPY_THREAD, COPY_TURN, STORED_THREAD, open_copy, read_only_profile, resting_session,
};
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::{ExportHandoverBriefParams, HandoverSummaryKind};
use crate::hand_over::brief::HANDOVER_SUMMARY_TEMPLATE;
use crate::runtime_binding::store::mint_runtime_binding_id;

/// How long the test waits for the copy to be served and let go.
const SERVE_WAIT: Duration = Duration::from_secs(10);

/// The copy's answer to the template.
const SUMMARY: &str = "1. The goal of this work: fix the login page.";

// Killed by a copy forked anything but ephemeral, read-only and asking nothing, by a turn sent
// anything but the template, and by an answer not returned as the template's.
#[tokio::test(flavor = "multi_thread")]
async fn a_hand_over_summary_forks_an_ephemeral_copy_that_answers_the_template() {
    let session = TestCodexSession::start().await;
    let Some(listener) = bind_test_listener(session.scripted.service.socket_path()) else {
        return;
    };
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let session_id: SessionId = session.task.record.session_id;
    let params = ExportHandoverBriefParams {
        session_id,
        binding_id: mint_runtime_binding_id(),
        resume: resting_session(session_id, Path::new("/")),
    };
    let profile = read_only_profile(folder.path());
    let served = tokio::spawn(async move {
        let (mut socket, fork, turn) = open_copy(&listener, &profile).await;
        for frame in [
            json!({"jsonrpc": "2.0", "method": "item/completed", "params": {
                "threadId": COPY_THREAD,
                "turnId": COPY_TURN,
                "item": {"type": "agentMessage", "id": "item-1", "text": SUMMARY},
            }}),
            json!({"jsonrpc": "2.0", "method": "turn/completed", "params": {
                "threadId": COPY_THREAD,
                "turn": {"id": COPY_TURN, "items": [], "status": "completed"},
            }}),
        ] {
            send_on_socket(&mut socket, frame).await;
        }
        // The copy goes with its connection once its turn ended.
        while let Some(Ok(_message)) = socket.next().await {}
        (fork, turn, profile)
    });

    let filing = SessionUsageFiling {
        usage: Arc::new(PortRegistration::new("usage")),
        session_id,
        binding_id: params.binding_id.clone(),
        provider_account_id: params.resume.provider_account_id.clone(),
        pricing: CodexRecorderPricing::new(Arc::clone(&session.task.pricing)),
    };
    let exported = summarize_on_copy(&establishment, &params, filing)
        .await
        .expect("the copy answers the template");
    let (fork, turn, profile) = tokio::time::timeout(SERVE_WAIT, served)
        .await
        .expect("the daemon lets the copy's connection go once it answered")
        .expect("the service served the copy");

    assert_eq!(exported.summary, SUMMARY);
    assert_eq!(exported.kind, HandoverSummaryKind::Template);
    assert_eq!(
        exported.declared_losses,
        [
            DeclaredLossKind::ProviderPrivateReasoning,
            DeclaredLossKind::ConversationHistorySummarized,
        ]
    );
    assert_eq!(fork["threadId"], STORED_THREAD);
    assert_eq!(fork["ephemeral"], true);
    assert_eq!(fork["permissions"], profile.as_str());
    assert_eq!(fork["approvalPolicy"], "never");
    assert_eq!(turn["input"][0]["text"], HANDOVER_SUMMARY_TEMPLATE);
}

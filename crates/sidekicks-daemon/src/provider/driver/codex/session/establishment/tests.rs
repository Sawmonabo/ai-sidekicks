use serde_json::{Map, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::test_session::TestCodexSession;
use crate::provider::driver::session_control::CreateSessionParams;

// Killed by dropping the profile's read-back, and by dropping the let-go of the conversation a
// refused read-back leaves.
#[tokio::test(start_paused = true)]
async fn a_start_whose_profile_reads_back_wrong_lets_its_conversation_go_and_installs_nothing() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let params = CreateSessionParams {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        config: Map::new(),
        model: ProviderToken::new("gpt-5".to_owned()).expect("the model fits"),
        larger_window: None,
        execution_posture: Some(compose_execution_posture(
            PermissionLevel::Ask,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        )),
        output_speed: None,
        options: Vec::new(),
        row_values: Default::default(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id: None,
        on_mcp_server_status: None,
    };

    let created = tokio::spawn(async move { establishment.create(&params).await.map(|_| ()) });
    let script = &mut session.scripted.script;
    let started = script.next_sent().await;
    assert_eq!(started["method"], "thread/start");
    script.answer(
        &started,
        &json!({
            "thread": {"id": "thread-started", "sessionId": "codex-session"},
            "activePermissionProfile": {"id": "another-profile"},
        }),
    );
    let unsubscribed = script.next_sent().await;
    assert_eq!(unsubscribed["method"], "thread/unsubscribe");
    assert_eq!(unsubscribed["params"]["threadId"], "thread-started");
    script.answer(&unsubscribed, &json!({"status": "unsubscribed"}));

    assert!(matches!(
        created.await.expect("the create's task ends"),
        Err(CodexError::Transport { .. })
    ));
    assert!(session.scripted.service.threads_of(&session_id).is_empty());
}

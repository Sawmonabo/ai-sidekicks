use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{CodexSessionEstablishment, CodexSessionEstablishmentDependencies};
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::codex::commands::CodexProviderCommandCache;
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::test_session::TestCodexSession;
use crate::provider::driver::session_control::CreateSessionParams;
use crate::provider::driver::{
    PROVIDERS, ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::spawn_environment::ReservedEnvironmentNames;

// Every session runs in one folder on the person's own sign-in.
struct OneFolder(PathBuf);

impl SessionSpawnContextResolver for OneFolder {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        let working_directory = self.0.clone();
        async move {
            Ok(SessionSpawnContext {
                working_directory,
                git_common_folder: None,
                every_project_rows: Vec::new(),
                project_rows: Vec::new(),
                account_folders: None,
            })
        }
        .boxed()
    }

    fn resolve_account_folders(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<
        '_,
        Result<Option<ProviderAccountFolders>, Box<dyn std::error::Error + Send + Sync>>,
    > {
        async { Ok(None) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn std::error::Error + Send + Sync>>> {
        async { Err("the test reads no generation".into()) }.boxed()
    }
}

// Killed by dropping the profile's read-back, and by dropping the let-go of the conversation a
// refused read-back leaves.
#[tokio::test(start_paused = true)]
async fn a_start_whose_profile_reads_back_wrong_lets_its_conversation_go_and_installs_nothing() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = CodexSessionEstablishment::new(CodexSessionEstablishmentDependencies {
        services: CodexServiceRegistry::holding(&session.scripted),
        spawn_contexts: Arc::new(OneFolder(folder.path().join("work"))),
        execution_postures: Arc::new(ExecutionPostureService::new(
            folder.path(),
            folder.path().join("session-token"),
        )),
        base_environment: Arc::from([]),
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(PROVIDERS)),
        helper_roles_folder: folder.path().join("roles"),
        tool_server_route: Arc::new(PortRegistration::new("tool server route")),
        delivery: Arc::clone(&session.task.calls.forks.delivery),
        pending_compactions: session.task.calls.forks.pending_compactions.clone(),
        provider_commands: CodexProviderCommandCache::new(
            Arc::new(PortRegistration::new("server prompts")),
            Arc::new(|_session_id| None),
        ),
    });
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

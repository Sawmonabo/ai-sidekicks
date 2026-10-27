//! The opening the queue's tests open a session's provider session with: the table's first
//! provider at a read-only posture over the root, its driver's contract version recorded.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::Map;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider_session::{ProviderSessionOpening, ProviderSessionOpeningComposer};
use sidekicks_driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::capabilities::{DriverCapabilities, DriverCapabilityFlags};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::CreateSessionParams;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_provider::runtime_binding::test_store::spawned_build;

/// The table's first provider.
pub(crate) fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

/// Composes every session's opening on the table's first provider, read-only over the root.
pub(crate) fn test_opening_composer() -> ProviderSessionOpeningComposer {
    Arc::new(|session_id| {
        async move {
            let root = FilesystemPath::new("/".to_owned()).expect("the root is a path");
            Ok(ProviderSessionOpening {
                provider: first_provider(),
                git_folder: root.clone(),
                create_params: CreateSessionParams {
                    session_id,
                    agent_id: AgentId::new(&mint_uuid_v7().to_string())
                        .expect("a minted UUID is an agent id"),
                    config: Map::new(),
                    model: ProviderToken::new("test-model".to_owned()).expect("a model token"),
                    larger_window: None,
                    execution_posture: Some(compose_execution_posture(
                        PermissionLevel::Readonly,
                        root,
                    )),
                    output_speed: None,
                    options: Vec::new(),
                    row_values: ProviderRowValues::default(),
                    callback_tools: None,
                    subagent_policy: None,
                    tool_servers: None,
                    output_schema: None,
                    provider_account_id: None,
                    on_mcp_server_status: None,
                },
                spawned_version: spawned_build("1.0.0", "/opt/provider/bin"),
                function_legs_for: Arc::new(|_| ResumeFunctionLegs::default()),
            })
        }
        .boxed()
    })
}

/// Records the first provider's capabilities in `providers`, so its contract version reads.
pub(crate) fn record_first_provider_capabilities(providers: &ProviderRegistry) {
    providers
        .record_capabilities(
            &first_provider(),
            DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|_| false),
                contract_version: FreeFormText::new("1.0.0".to_owned())
                    .expect("a contract version"),
            },
        )
        .expect("the first provider is registered");
}

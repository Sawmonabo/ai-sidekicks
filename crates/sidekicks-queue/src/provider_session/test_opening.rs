//! The opening tests open a session's provider session with: the table's first provider at a
//! read-only posture over the root, and an idle sleep standing in that records each opening;
//! the queue's own tests also record that provider's contract version.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::Map;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
#[cfg(test)]
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::PROVIDERS;
#[cfg(test)]
use sidekicks_provider::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
#[cfg(test)]
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::CreateSessionParams;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_session::idle_sleep::openings::SessionProcessFollower;
use sidekicks_std::mutex_lock::lock;

use crate::provider_session::{ProviderSessionOpening, ProviderSessionOpeningComposer};

/// The table's first provider.
pub(crate) fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

/// Composes every session's opening on the table's first provider, read-only over the root, on
/// the account it is given.
pub fn test_opening_composer() -> ProviderSessionOpeningComposer {
    Arc::new(|session_id, provider_account_id| {
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
                    effort: None,
                    larger_window: None,
                    execution_posture: Some(compose_execution_posture(
                        PermissionLevel::Readonly,
                        root,
                    )),
                    mode: SessionMode::Build,
                    output_speed: None,
                    options: Vec::new(),
                    row_values: ProviderRowValues::default(),
                    callback_tools: None,
                    subagent_policy: None,
                    tool_servers: None,
                    output_schema: None,
                    provider_account_id,
                    on_mcp_server_status: None,
                },
                function_legs_for: Arc::new(|_| ResumeFunctionLegs::default()),
            })
        }
        .boxed()
    })
}

/// An idle sleep standing in for the provider sessions' tests, recording each session it was told
/// opened; a close it is told of changes nothing the tests read.
#[derive(Default)]
pub struct RecordedProcessFollowing {
    followed: Mutex<Vec<SessionId>>,
}

impl RecordedProcessFollowing {
    /// Each session it was told opened, in order.
    pub fn followed(&self) -> Vec<SessionId> {
        lock(&self.followed).clone()
    }
}

impl SessionProcessFollower for RecordedProcessFollowing {
    fn follow_awake(&self, session_id: SessionId) {
        lock(&self.followed).push(session_id);
    }

    fn forget_closed(&self, _session_id: SessionId) {}
}

/// Records the first provider's capabilities in `providers`, so its contract version reads and,
/// where `is_resumable`, it resumes.
#[cfg(test)]
pub(crate) fn record_first_provider_capabilities(providers: &ProviderRegistry, is_resumable: bool) {
    providers
        .record_capabilities(
            &first_provider(),
            DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| {
                    is_resumable && flag == DriverCapabilityFlag::Resume
                }),
                contract_version: FreeFormText::new("1.0.0".to_owned())
                    .expect("a contract version"),
            },
        )
        .expect("the first provider is registered");
}

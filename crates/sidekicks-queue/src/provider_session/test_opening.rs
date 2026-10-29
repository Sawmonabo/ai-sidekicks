//! The opening tests open a session's provider session with: the table's first provider at a
//! read-only posture over the root, an idle sleep standing in that records each opening, and a
//! resumed runs' ingress standing in that records each resume's runs; the queue's own tests also
//! record that provider's contract version.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
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
use sidekicks_provider::run::posture::{ExecutionPostureService, compose_execution_posture};
use sidekicks_provider::runtime_binding::resume::ResumeFunctionLegs;
use sidekicks_session::idle_sleep::openings::SessionProcessFollower;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::provider_session::resumed_runs::{ResumedRuns, ResumedRunsIngress};
use crate::provider_session::{
    ProviderSessionGitFolderReader, ProviderSessionOpening, ProviderSessionOpeningComposer,
};

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

/// Reads every session's git folder as the root, as [`test_opening_composer`] composes it.
pub fn test_git_folder_reader() -> ProviderSessionGitFolderReader {
    Arc::new(|_session_id| {
        async { Ok(FilesystemPath::new("/".to_owned()).expect("the root is a path")) }.boxed()
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

/// A posture service for the provider sessions' tests, whose credential list no test resolves.
pub fn test_execution_postures() -> Arc<ExecutionPostureService> {
    Arc::new(ExecutionPostureService::new(
        Path::new("/home"),
        PathBuf::from("/home/daemon.token"),
    ))
}

/// What a resumed runs' stand-in runs as each resume's runs are handed to it.
pub type ResumedRunsHook = Box<dyn Fn(&ResumedRuns) + Send + Sync>;

/// A resumed runs' ingress standing in for the provider sessions' tests, settling nothing and
/// recording each resume's runs it was handed, after running its hook on them.
pub struct RecordedResumedRuns {
    taken: Mutex<Vec<ResumedRuns>>,
    on_take: ResumedRunsHook,
}

impl RecordedResumedRuns {
    /// A stand-in that runs `on_take` as each resume's runs are handed to it.
    pub fn new(on_take: ResumedRunsHook) -> Self {
        Self {
            taken: Mutex::new(Vec::new()),
            on_take,
        }
    }

    /// Each resume's runs it was handed, in order.
    pub fn taken(&self) -> Vec<ResumedRuns> {
        lock(&self.taken).clone()
    }

    /// The resumed runs' port with this stand-in registered on it.
    pub fn registered(self: &Arc<Self>) -> Arc<PortRegistration<Arc<dyn ResumedRunsIngress>>> {
        let port = PortRegistration::new("resumed runs");
        port.register(Arc::clone(self) as Arc<dyn ResumedRunsIngress>)
            .expect("a new port holds no ingress yet");
        Arc::new(port)
    }
}

impl Default for RecordedResumedRuns {
    fn default() -> Self {
        Self::new(Box::new(|_| {}))
    }
}

impl ResumedRunsIngress for RecordedResumedRuns {
    fn take_resumed_runs(
        &self,
        resumed: ResumedRuns,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        (self.on_take)(&resumed);
        lock(&self.taken).push(resumed);
        async { Ok(()) }.boxed()
    }
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

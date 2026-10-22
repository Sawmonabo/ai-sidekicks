//! The daemon services a scripted session reaches: approval ports and a queue intake that record
//! what reaches them, files whose read takes a set time, the bindings of daemon turns and a machine
//! with no repositories.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::binding_id;
use crate::mutex_lock::lock;
use crate::provider::callback_tools::host::{
    CallbackToolActivityRecord, CallbackToolActivitySink, CallbackToolExecutor, CallbackToolHost,
    CallbackToolPortError, CallbackToolSpawnRequest,
};
use crate::provider::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use crate::provider::driver::attachments::{
    AttachmentResolver, ProviderAttachment, UnresolvedAttachmentCause, UnresolvedAttachmentMarker,
};
use crate::provider::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::ports::{DriverPorts, MessageTakenListener};
use crate::provider::driver::run_control::{
    DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
};
use crate::provider::port::permission_ask::{
    PermissionAskPort, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};
use crate::provider::port::repository_reader::{RepositoryReader, RepositoryReading};
use crate::provider::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::provider::port::usage_sink::UsageSink;
use crate::provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};

/// What reached the approval ports, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PortCall {
    /// An ask, by its request id.
    Ask(String),
    /// An ask's withdrawal, by its request id.
    AskWithdrawn(String),
    /// A reviewer's block, by the run it was made in.
    Denial(RunId),
    /// The held presses of an ended process's binding, released.
    PressesReleased(RuntimeBindingId),
}

/// Approval ports and the queue's intake of taken messages, each recording what reaches it.
#[derive(Default)]
pub(crate) struct RecordingPorts {
    calls: Mutex<Vec<PortCall>>,
    taken: Mutex<Vec<(String, RunId)>>,
}

impl RecordingPorts {
    /// Every call so far, in order.
    pub(crate) fn calls(&self) -> Vec<PortCall> {
        lock(&self.calls).clone()
    }

    /// The messages reported taken so far, with the run each was reported under.
    pub(crate) fn taken(&self) -> Vec<(String, RunId)> {
        lock(&self.taken).clone()
    }

    fn record(&self, call: PortCall) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.calls).push(call);
        async { Ok(()) }.boxed()
    }
}

impl PermissionAskPort for RecordingPorts {
    fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::Ask(ask.request_id))
    }

    fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::AskWithdrawn(withdrawal.request_id))
    }
}

impl ReviewerDenialPort for RecordingPorts {
    fn take_denial(
        &self,
        denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::Denial(denial.run_id))
    }

    fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        lock(&self.calls).push(PortCall::PressesReleased(binding_id.clone()));
    }
}

impl MessageTakenListener for RecordingPorts {
    fn message_taken(&self, _session_id: SessionId, message_id: &str, run_id: RunId) {
        lock(&self.taken).push((message_id.to_owned(), run_id));
    }
}

/// Registers what a scripted driver composes over: `recording` as the approval ports and the
/// queue's intake, every daemon turn on one binding, and a machine with no repositories.
pub(crate) fn register_scripted_ports(ports: &DriverPorts, recording: &Arc<RecordingPorts>) {
    ports
        .daemon_turn_bindings
        .register(Arc::new(ScriptedBindings))
        .expect("the turn bindings register once");
    ports
        .repositories
        .register(Arc::new(NoRepositories))
        .expect("the repositories register once");
    ports
        .reviewer_denials
        .register(recording.clone())
        .expect("the denials register once");
    ports
        .permission_asks
        .register(recording.clone())
        .expect("the asks register once");
    ports
        .message_taken
        .register(recording.clone())
        .expect("the intake registers once");
}

/// A usage record that keeps each metered delta and answers one set of sums as every thread's
/// already reported ones.
#[derive(Default)]
pub(crate) struct RecordingUsage {
    reported: Mutex<UsageAxisCounts>,
    metered: Mutex<Vec<(SessionId, MeteredUsageDelta)>>,
}

impl RecordingUsage {
    /// Answers `reported` as the sums already reported under every thread.
    pub(crate) fn report_prior(&self, reported: UsageAxisCounts) {
        *lock(&self.reported) = reported;
    }

    /// Every delta metered so far, with its session, in order.
    pub(crate) fn metered(&self) -> Vec<(SessionId, MeteredUsageDelta)> {
        lock(&self.metered).clone()
    }
}

impl UsageSink for RecordingUsage {
    fn record_metered(&self, session_id: SessionId, delta: MeteredUsageDelta) {
        lock(&self.metered).push((session_id, delta));
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: &str,
    ) -> Result<UsageAxisCounts, Box<dyn Error + Send + Sync>> {
        Ok(*lock(&self.reported))
    }
}

/// Files whose read takes the given time: every id answers its unresolved marker once its delay
/// passed, so a message's blocks name it.
#[derive(Default)]
pub(crate) struct ScriptedAttachments {
    delays: Mutex<HashMap<ArtifactId, Duration>>,
}

impl ScriptedAttachments {
    /// A file whose read takes `delay`.
    pub(crate) fn slow_file(&self, delay: Duration) -> ArtifactId {
        let artifact_id = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
        lock(&self.delays).insert(artifact_id, delay);
        artifact_id
    }
}

impl AttachmentResolver for ScriptedAttachments {
    fn resolve_attachments(
        &self,
        _session_id: SessionId,
        artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>>> {
        let delay = artifact_ids
            .iter()
            .filter_map(|artifact_id| lock(&self.delays).get(artifact_id).copied())
            .max()
            .unwrap_or_default();
        async move {
            tokio::time::sleep(delay).await;
            Ok(artifact_ids
                .into_iter()
                .map(|artifact_id| {
                    ProviderAttachment::Unresolved(UnresolvedAttachmentMarker {
                        artifact_id,
                        cause: UnresolvedAttachmentCause::Deleted,
                    })
                })
                .collect())
        }
        .boxed()
    }
}

/// Opens every daemon turn on one binding.
pub(crate) struct ScriptedBindings;

impl DaemonTurnBindingResolver for ScriptedBindings {
    fn open_daemon_turn_binding(
        &self,
        _run_id: RunId,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        async {
            Ok(DaemonTurnBinding {
                binding_id: binding_id("daemon-turn"),
                agent_id: AgentId::new(&mint_uuid_v7().to_string())
                    .expect("a minted UUID is an agent id"),
            })
        }
        .boxed()
    }
}

/// A machine with no repositories.
pub(crate) struct NoRepositories;

impl RepositoryReader for NoRepositories {
    fn read_repository<'a>(
        &'a self,
        _working_folder: &'a Path,
    ) -> BoxFuture<'a, Option<RepositoryReading>> {
        async { None }.boxed()
    }

    fn is_owned_by_user<'a>(&'a self, _path: &'a Path) -> BoxFuture<'a, bool> {
        async { false }.boxed()
    }
}

/// A callback-tool host with no approval seam, so every spawn's registry is withheld.
pub(crate) fn test_callback_tool_host() -> Arc<CallbackToolHost> {
    Arc::new(CallbackToolHost::new(
        Arc::new(NoCallbackTools),
        Arc::new(NoCallbackTools),
        None,
    ))
}

/// The callback-tool binding of a spawn of `session_id` that offers none.
pub(crate) fn test_callback_tool_binding(session_id: SessionId) -> Arc<CallbackToolSpawnBinding> {
    Arc::new(bind_callback_tools_for_spawn(
        &test_callback_tool_host(),
        CallbackToolSpawnRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            requested_tools: Vec::new(),
            provider_registration_unavailable: None,
        },
    ))
}

// Runs no tool and records nothing: no seam is registered, so no call reaches either.
struct NoCallbackTools;

impl CallbackToolExecutor for NoCallbackTools {
    fn execute(
        &self,
        _invocation: CallbackToolInvocation,
    ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>> {
        async { Ok(CallbackToolResult::Completed { output: None }) }.boxed()
    }
}

impl CallbackToolActivitySink for NoCallbackTools {
    fn record<'a>(
        &'a self,
        _record: &'a CallbackToolActivityRecord,
    ) -> BoxFuture<'a, Result<(), CallbackToolPortError>> {
        async { Ok(()) }.boxed()
    }
}

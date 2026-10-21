//! The daemon services a scripted session reaches: approval ports that record what reaches them,
//! files whose read takes a set time, the bindings of daemon turns and a machine with no
//! repositories.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
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
use crate::provider::driver::attachments::{
    AttachmentResolver, ProviderAttachment, UnresolvedAttachmentCause, UnresolvedAttachmentMarker,
};
use crate::provider::driver::run_control::{
    DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
};
use crate::provider::port::permission_ask::{
    PermissionAskPort, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};
use crate::provider::port::repository_reader::{RepositoryReader, RepositoryReading};
use crate::provider::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};

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

/// Approval ports that record what reaches them.
#[derive(Default)]
pub(crate) struct RecordingPorts {
    calls: Mutex<Vec<PortCall>>,
}

impl RecordingPorts {
    /// Every call so far, in order.
    pub(crate) fn calls(&self) -> Vec<PortCall> {
        lock(&self.calls).clone()
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
pub(super) struct ScriptedBindings;

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
pub(super) struct NoRepositories;

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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

//! The bindings and the admission of each turn the daemon starts on a test session.

use std::sync::Mutex;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::test_record_posture;
use crate::driver::run_control::{
    DaemonTurnAdmission, DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
    DaemonTurnProcess,
};
use crate::runtime_binding::test_store::test_provider_account_id;

/// Opens each turn the daemon starts on the binding the test names, for the session's lead, and
/// admits each on the account and at the posture a test session runs on.
pub(crate) struct TestDaemonTurnBindings {
    /// The session's lead.
    pub(crate) agent_id: AgentId,
    binding_id: Mutex<Option<RuntimeBindingId>>,
}

impl TestDaemonTurnBindings {
    /// Opens no turn until [`Self::open_on`] names a binding.
    pub(crate) fn new(agent_id: AgentId) -> Self {
        Self {
            agent_id,
            binding_id: Mutex::new(None),
        }
    }

    /// Opens every later turn on `binding_id`.
    pub(crate) fn open_on(&self, binding_id: RuntimeBindingId) {
        *self.lock() = Some(binding_id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<RuntimeBindingId>> {
        lock(&self.binding_id)
    }
}

impl DaemonTurnBindingResolver for TestDaemonTurnBindings {
    fn open_daemon_turn_binding(
        &self,
        _run_id: RunId,
        session_id: SessionId,
        _process: DaemonTurnProcess,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        let binding = self.lock().clone().map(|binding_id| DaemonTurnBinding {
            binding_id,
            agent_id: self.agent_id,
            step_bound: None,
        });
        async move { binding.ok_or(DaemonTurnBindingError::NoProviderSession { session_id }) }
            .boxed()
    }

    fn admit_daemon_turn(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
        async {
            Ok(DaemonTurnAdmission {
                admitted_provider_account_id: test_provider_account_id(),
                execution_posture: test_record_posture(),
            })
        }
        .boxed()
    }
}

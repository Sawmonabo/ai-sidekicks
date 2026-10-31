//! The serving socket's watch: a connection that fails is logged, its handshake and subscriptions
//! dropped by the connection's own close, and a listener that fails marks the daemon degraded in
//! its status read.

use std::error::Error;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::daemon::status::DaemonProcessState;
use sidekicks_ipc::registry::TransportId;
use sidekicks_std::mutex_lock::lock;

use crate::ipc::local_gateway::{SupervisionDisconnectReason, SupervisionHooks};

/// Where the daemon is in its own life: starting until it is ready, then running, degraded once
/// its listener failed, and stopping from its stop on.
pub(crate) struct ProcessStateTracker {
    state: Mutex<DaemonProcessState>,
}

impl ProcessStateTracker {
    /// A tracker of a daemon that is starting.
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(DaemonProcessState::Starting),
        })
    }

    /// Where the daemon is now.
    pub(crate) fn read(&self) -> DaemonProcessState {
        *lock(&self.state)
    }

    /// The start is done: a daemon still starting runs, and one whose listener failed meanwhile
    /// stays degraded.
    pub(crate) fn mark_ready(&self) {
        let mut state = lock(&self.state);
        if *state == DaemonProcessState::Starting {
            *state = DaemonProcessState::Running;
        }
    }

    /// The listener failed: the daemon serves with a fault, unless it is already stopping.
    pub(crate) fn mark_degraded(&self) {
        let mut state = lock(&self.state);
        if *state != DaemonProcessState::Stopping {
            *state = DaemonProcessState::Degraded;
        }
    }

    /// The stop has begun.
    pub(crate) fn mark_stopping(&self) {
        *lock(&self.state) = DaemonProcessState::Stopping;
    }
}

/// The serving socket's hooks.
pub(crate) struct ServingSocketHooks {
    /// The daemon's place in its life, degraded on a listener failure.
    pub(super) process_state: Arc<ProcessStateTracker>,
}

impl SupervisionHooks for ServingSocketHooks {
    fn on_disconnect(&self, _transport: TransportId, _reason: SupervisionDisconnectReason) {}

    fn on_error(&self, transport: TransportId, error: &(dyn Error + 'static)) {
        tracing::warn!(
            transport = transport.0,
            error,
            "a connection to the daemon failed"
        );
    }

    fn on_listener_error(&self, error: &(dyn Error + 'static)) {
        tracing::error!(
            error,
            "the daemon's listener failed, so the daemon serves degraded"
        );
        self.process_state.mark_degraded();
    }
}

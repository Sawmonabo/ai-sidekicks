//! The machine probe's gate: at most one probe per provider at a time. A read that asks for a
//! probe while one runs for its provider waits for that probe to end and reads what it recorded,
//! never starting a second process. The gate holds only which providers are being probed; the
//! status tracker keeps what each probe read.

use std::collections::HashMap;
use std::sync::Mutex;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

/// Which providers a machine probe is running for. Its lock is held only to look up, add or
/// remove a provider, never across an await.
#[derive(Debug, Default)]
pub struct McpMachineProbeGate {
    /// Each provider being probed, with the sender whose drop tells its waiters the probe ended.
    running: Mutex<HashMap<ProviderId, watch::Sender<()>>>,
}

/// A read's turn at the gate: to run the provider's probe, or to wait for the one running.
pub(crate) enum McpMachineProbeTurn<'gate> {
    /// No probe runs for the provider; the holder runs it, and the provider is free again once
    /// the hold drops, finished or not.
    Run(McpMachineProbeHold<'gate>),
    /// A probe runs for the provider; the read waits for it with [`wait_for_machine_probe`].
    Wait(watch::Receiver<()>),
}

/// The running probe's place at the gate; dropping it frees the provider and wakes every read
/// waiting on it.
pub(crate) struct McpMachineProbeHold<'gate> {
    gate: &'gate McpMachineProbeGate,
    provider: ProviderId,
}

impl McpMachineProbeGate {
    /// The turn of a read that asks to probe `provider`.
    pub(crate) fn enter(&self, provider: &ProviderId) -> McpMachineProbeTurn<'_> {
        let mut running = lock(&self.running);
        if let Some(sender) = running.get(provider) {
            return McpMachineProbeTurn::Wait(sender.subscribe());
        }
        running.insert(provider.clone(), watch::Sender::new(()));
        McpMachineProbeTurn::Run(McpMachineProbeHold {
            gate: self,
            provider: provider.clone(),
        })
    }

    /// How many reads wait on `provider`'s running probe; `None` when none runs.
    #[cfg(test)]
    pub(crate) fn waiting_reads(&self, provider: &ProviderId) -> Option<usize> {
        lock(&self.running)
            .get(provider)
            .map(watch::Sender::receiver_count)
    }
}

impl Drop for McpMachineProbeHold<'_> {
    fn drop(&mut self) {
        // The sender drops with its entry, which ends every waiter's wait.
        lock(&self.gate.running).remove(&self.provider);
    }
}

/// Waits until the probe `receiver` was handed for has ended.
pub(crate) async fn wait_for_machine_probe(mut receiver: watch::Receiver<()>) {
    // Nothing is ever sent, so the wait ends only when the running probe's hold drops the sender.
    while receiver.changed().await.is_ok() {}
}

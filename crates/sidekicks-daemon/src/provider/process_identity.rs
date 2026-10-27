//! Which provider process runs a session, as the daemon started it, and the read of it per session.

use sidekicks_contracts::session::id::SessionId;

/// One provider process as the daemon started it: the operating system's id for it, which a later
/// process may reuse, and the daemon-wide count of its spawn, which no later spawn repeats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProviderProcessIdentity {
    /// The operating system's process id.
    pub(crate) process_id: u32,
    /// The spawn's place in the daemon's one count of provider spawns.
    pub(crate) spawn_sequence: u64,
}

/// The identity of each session's provider process.
pub(crate) trait ProviderProcessIds: Send + Sync {
    /// The identity of `session_id`'s provider process, or `None` while none runs.
    fn process_identity(&self, session_id: &SessionId) -> Option<ProviderProcessIdentity>;
}

/// The provider process a test's session runs.
#[cfg(test)]
pub(crate) const TEST_PROVIDER_PROCESS: ProviderProcessIdentity = ProviderProcessIdentity {
    process_id: 7,
    spawn_sequence: 1,
};

/// A test's session's provider process, as the test sets it; none runs until it sets one.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct ProcessStandIn(std::sync::Mutex<Option<ProviderProcessIdentity>>);

#[cfg(test)]
impl ProcessStandIn {
    /// Makes `process` the session's provider process; `None` when none runs.
    pub(crate) fn set(&self, process: Option<ProviderProcessIdentity>) {
        *crate::mutex_lock::lock(&self.0) = process;
    }
}

#[cfg(test)]
impl ProviderProcessIds for ProcessStandIn {
    fn process_identity(&self, _session_id: &SessionId) -> Option<ProviderProcessIdentity> {
        *crate::mutex_lock::lock(&self.0)
    }
}

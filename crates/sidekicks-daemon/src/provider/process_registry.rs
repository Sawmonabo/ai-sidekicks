//! Which provider process runs each session, as the daemon started it: one daemon-wide count of
//! provider spawns, never reused, and the identity of each session's live process. Each driver
//! records its process at spawn and removes it at exit.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use sidekicks_contracts::session::id::SessionId;

use crate::mutex_lock::lock;
use crate::provider::process_identity::{ProviderProcessIdentity, ProviderProcessIds};

/// The daemon's provider processes by session, and the count their spawn sequences come from.
#[derive(Default)]
pub(crate) struct ProviderProcessRegistry {
    // Relaxed is enough: an identity is published to readers through the map's lock.
    spawn_count: AtomicU64,
    processes: Mutex<HashMap<SessionId, ProviderProcessIdentity>>,
}

impl ProviderProcessRegistry {
    /// The next spawn's place in the daemon's one count, which no later spawn repeats.
    pub(crate) fn mint_spawn_sequence(&self) -> u64 {
        self.spawn_count.fetch_add(1, Ordering::Relaxed)
    }

    /// Records `identity` as the process now running `session_id`, replacing the one before.
    pub(crate) fn record(&self, session_id: SessionId, identity: ProviderProcessIdentity) {
        lock(&self.processes).insert(session_id, identity);
    }

    /// Removes `session_id`'s entry when its process, `identity`, has exited; a later process's
    /// entry stays, so a replaced process's late exit never removes its successor.
    pub(crate) fn remove_exited(&self, session_id: SessionId, identity: ProviderProcessIdentity) {
        let mut processes = lock(&self.processes);
        if processes
            .get(&session_id)
            .is_some_and(|recorded| recorded.spawn_sequence == identity.spawn_sequence)
        {
            processes.remove(&session_id);
        }
    }
}

impl ProviderProcessIds for ProviderProcessRegistry {
    fn process_identity(&self, session_id: &SessionId) -> Option<ProviderProcessIdentity> {
        lock(&self.processes).get(session_id).copied()
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::session::id::SessionId;

    use super::ProviderProcessRegistry;
    use crate::provider::process_identity::{ProviderProcessIdentity, ProviderProcessIds};

    // Killed by removing a session's entry on any exit without comparing its spawn sequence.
    #[test]
    fn a_replaced_process_exit_leaves_its_successor_recorded() {
        let registry = ProviderProcessRegistry::default();
        let session_id =
            SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d").expect("a valid session id");
        let first = ProviderProcessIdentity {
            process_id: 40,
            spawn_sequence: registry.mint_spawn_sequence(),
        };
        let second = ProviderProcessIdentity {
            // The system may give the successor the same process id.
            process_id: 40,
            spawn_sequence: registry.mint_spawn_sequence(),
        };
        assert_ne!(first.spawn_sequence, second.spawn_sequence);
        registry.record(session_id, first);
        registry.record(session_id, second);
        registry.remove_exited(session_id, first);
        assert_eq!(registry.process_identity(&session_id), Some(second));
        registry.remove_exited(session_id, second);
        assert_eq!(registry.process_identity(&session_id), None);
    }
}

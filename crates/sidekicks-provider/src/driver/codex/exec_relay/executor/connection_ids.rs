//! Each connection's own process ids and the ids the relay runs them under on its one executor. A
//! process id is the client's own string, so two connections may both start `mcp-stdio-1`; the
//! relay starts each under an id of its own, `sidekicks-process-<n>`, and turns the executor's
//! messages about it back to its owner's id.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use tokio::time::Instant;

use super::RelayConnectionId;

/// What opens every process id the relay mints.
const RELAY_PROCESS_PREFIX: &str = "sidekicks-process-";

/// The id a connection's request reaches the executor under when it names no process the
/// connection started; it names no process there, so the executor answers it as unknown.
pub(super) const UNKNOWN_ID: &str = "sidekicks-unknown";

/// How long the executor keeps a closed process for its late reads, and the relay its ids.
const CLOSED_PROCESS_RETENTION: Duration = Duration::from_secs(30);

/// The connection a relay id's process belongs to and the id that connection gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IdOwner {
    /// The connection that started the process.
    pub(super) connection: RelayConnectionId,
    /// The connection's own id for it.
    pub(super) own_id: String,
}

// A process the relay runs under one of its ids.
struct OwnedProcess {
    owner: IdOwner,
    is_closed: bool,
}

/// Every connection's process ids and the relay ids they map to, both ways.
#[derive(Default)]
pub(super) struct ConnectionIds {
    relay_ids: HashMap<RelayConnectionId, HashMap<String, String>>,
    processes: HashMap<String, OwnedProcess>,
    // The relay ids of closed processes, by when they are forgotten, the earliest first.
    closing: VecDeque<(Instant, String)>,
    minted: u64,
}

impl ConnectionIds {
    /// The relay id a start of `connection`'s own `own_id` runs under, and whether it was minted
    /// now: a process the connection still has under that id keeps its relay id, so the executor
    /// refuses the second start as it would on a connection of its own.
    pub(super) fn mint(&mut self, connection: RelayConnectionId, own_id: &str) -> (String, bool) {
        self.forget_closed();
        let kept = self
            .relay_ids
            .get(&connection)
            .and_then(|ids| ids.get(own_id))
            .filter(|relay_id| {
                self.processes
                    .get(*relay_id)
                    .is_some_and(|process| !process.is_closed)
            });
        if let Some(relay_id) = kept {
            return (relay_id.clone(), false);
        }
        self.minted += 1;
        let relay_id = format!("{RELAY_PROCESS_PREFIX}{}", self.minted);
        self.relay_ids
            .entry(connection)
            .or_default()
            .insert(own_id.to_owned(), relay_id.clone());
        self.processes.insert(
            relay_id.clone(),
            OwnedProcess {
                owner: IdOwner {
                    connection,
                    own_id: own_id.to_owned(),
                },
                is_closed: false,
            },
        );
        (relay_id, true)
    }

    /// The relay id `connection`'s own `own_id` runs under; [`UNKNOWN_ID`] for an id it started no
    /// process under.
    pub(super) fn relay_id(&self, connection: RelayConnectionId, own_id: &str) -> &str {
        self.relay_ids
            .get(&connection)
            .and_then(|ids| ids.get(own_id))
            .map_or(UNKNOWN_ID, String::as_str)
    }

    /// The connection and own id of the process the relay runs under `relay_id`.
    pub(super) fn owner(&self, relay_id: &str) -> Option<&IdOwner> {
        self.processes.get(relay_id).map(|process| &process.owner)
    }

    /// Forgets `relay_id`, whose start the executor refused.
    pub(super) fn forget(&mut self, relay_id: &str) {
        let Some(process) = self.processes.remove(relay_id) else {
            return;
        };
        let owner = process.owner;
        if let Some(ids) = self.relay_ids.get_mut(&owner.connection)
            && ids.get(&owner.own_id).is_some_and(|kept| kept == relay_id)
        {
            ids.remove(&owner.own_id);
        }
    }

    /// Marks `relay_id`'s process closed: its ids last as long as the executor keeps it, and a new
    /// start under its own id gets a new relay id.
    pub(super) fn close(&mut self, relay_id: &str) {
        let Some(process) = self.processes.get_mut(relay_id) else {
            return;
        };
        if !process.is_closed {
            process.is_closed = true;
            self.closing.push_back((
                Instant::now() + CLOSED_PROCESS_RETENTION,
                relay_id.to_owned(),
            ));
        }
        self.forget_closed();
    }

    /// Forgets every id of `connection`, which went away.
    pub(super) fn forget_connection(&mut self, connection: RelayConnectionId) {
        if let Some(ids) = self.relay_ids.remove(&connection) {
            for relay_id in ids.values() {
                self.processes.remove(relay_id);
            }
        }
    }

    // Forgets the closed processes the executor no longer keeps.
    fn forget_closed(&mut self) {
        let now = Instant::now();
        while let Some((_due, relay_id)) = self.closing.front().filter(|(due, _)| *due <= now) {
            let relay_id = relay_id.clone();
            self.closing.pop_front();
            self.forget(&relay_id);
        }
    }
}

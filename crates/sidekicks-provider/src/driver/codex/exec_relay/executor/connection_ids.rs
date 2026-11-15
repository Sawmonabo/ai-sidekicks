//! Each connection's own ids of one kind (its processes, its open files or its http requests) and
//! the ids the relay sends them under on its one executor. Each id is the client's own string, so
//! two connections may both start `mcp-stdio-1` or both stream `http-1`; the relay sends each
//! under an id of its own and turns the executor's messages naming it back to its owner's id.

use std::collections::{HashMap, VecDeque};

use tokio::time::Instant;

use super::RelayConnectionId;
use super::detached::DETACHED_CONNECTION_HOLD;
use crate::driver::codex::exec_relay::methods::RelayIdKind;

/// The id a connection's request reaches the executor under when it names no id the connection
/// minted; it names nothing there, so the executor answers it as unknown.
pub(super) const UNKNOWN_ID: &str = "sidekicks-unknown";

/// The connection a relay id belongs to and the id that connection gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IdOwner {
    /// The connection that minted the id.
    pub(super) connection: RelayConnectionId,
    /// The connection's own id for it.
    pub(super) own_id: String,
}

/// What a mint under a connection's own id comes to.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum IdMint {
    /// A relay id minted now, which only the mint's refusal forgets.
    New(String),
    /// The relay id of the live id the connection still has open, so the executor refuses the
    /// second use as it would on a connection of its own.
    Live(String),
    /// None: the connection's earlier mint under the same own id is still unanswered.
    Pending,
}

// Where one relay id stands: minted and not yet answered, answered as begun, or a process closed
// and kept for its late reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum IdState {
    Pending,
    Live,
    Closed,
}

// An id the relay sends under one of its own.
struct OwnedId {
    owner: IdOwner,
    state: IdState,
    // The number of the last event the executor reported under the id, an http request's body
    // delta.
    last_seq: u64,
}

/// Every connection's ids of one kind and the relay ids they map to, both ways.
pub(super) struct ConnectionIds {
    kind: RelayIdKind,
    relay_ids: HashMap<RelayConnectionId, HashMap<String, String>>,
    owned: HashMap<String, OwnedId>,
    // The relay ids of closed ids, by when they are forgotten, the earliest first.
    closing: VecDeque<(Instant, String)>,
    minted: u64,
}

impl ConnectionIds {
    /// An empty table of `kind`'s ids.
    pub(super) fn new(kind: RelayIdKind) -> Self {
        Self {
            kind,
            relay_ids: HashMap::new(),
            owned: HashMap::new(),
            closing: VecDeque::new(),
            minted: 0,
        }
    }

    /// The relay id `connection`'s own `own_id` is sent under: minted now, or the one of the
    /// id it still has open; none while its earlier mint under `own_id` is unanswered, since two
    /// mints sharing one relay id could not tell which the executor took.
    pub(super) fn mint(&mut self, connection: RelayConnectionId, own_id: &str) -> IdMint {
        self.forget_closed();
        let kept = self
            .relay_ids
            .get(&connection)
            .and_then(|ids| ids.get(own_id))
            .and_then(|relay_id| Some((relay_id, self.owned.get(relay_id)?.state)));
        match kept {
            Some((_relay_id, IdState::Pending)) => return IdMint::Pending,
            Some((relay_id, IdState::Live)) => return IdMint::Live(relay_id.clone()),
            Some((_, IdState::Closed)) | None => {}
        }
        self.minted += 1;
        let relay_id = match self.kind {
            RelayIdKind::Process => format!("sidekicks-process-{}", self.minted),
            // In hex, so the handle stays within the executor's 32 bytes.
            RelayIdKind::FileHandle => format!("sidekicks-file-{:x}", self.minted),
            RelayIdKind::HttpRequest => format!("sidekicks-http-{}", self.minted),
        };
        self.relay_ids
            .entry(connection)
            .or_default()
            .insert(own_id.to_owned(), relay_id.clone());
        self.owned.insert(
            relay_id.clone(),
            OwnedId {
                owner: IdOwner {
                    connection,
                    own_id: own_id.to_owned(),
                },
                state: IdState::Pending,
                last_seq: 0,
            },
        );
        IdMint::New(relay_id)
    }

    /// Marks `relay_id` live, its mint's answer having begun it.
    pub(super) fn mark_live(&mut self, relay_id: &str) {
        if let Some(owned) = self.owned.get_mut(relay_id)
            && owned.state == IdState::Pending
        {
            owned.state = IdState::Live;
        }
    }

    /// The relay id `connection`'s own `own_id` is sent under; [`UNKNOWN_ID`] for an id it never
    /// minted.
    pub(super) fn relay_id(&self, connection: RelayConnectionId, own_id: &str) -> &str {
        self.relay_ids
            .get(&connection)
            .and_then(|ids| ids.get(own_id))
            .map_or(UNKNOWN_ID, String::as_str)
    }

    /// The connection and own id the relay sends under `relay_id`.
    pub(super) fn owner(&self, relay_id: &str) -> Option<&IdOwner> {
        self.owned.get(relay_id).map(|owned| &owned.owner)
    }

    /// Forgets `relay_id`, whose mint the executor refused or whose use has ended.
    pub(super) fn forget(&mut self, relay_id: &str) {
        let Some(owned) = self.owned.remove(relay_id) else {
            return;
        };
        let owner = owned.owner;
        if let Some(ids) = self.relay_ids.get_mut(&owner.connection)
            && ids.get(&owner.own_id).is_some_and(|kept| kept == relay_id)
        {
            ids.remove(&owner.own_id);
        }
    }

    /// Marks `relay_id` closed: a process's ids last for [`DETACHED_CONNECTION_HOLD`], as long as
    /// the executor keeps a closed process for its late reads and as long as a hold that began
    /// before the close can still read it back, and a new start under its own id gets a new relay
    /// id; a file handle or an http request is forgotten at once.
    pub(super) fn close(&mut self, relay_id: &str) {
        if self.kind != RelayIdKind::Process {
            self.forget(relay_id);
            return;
        }
        let Some(owned) = self.owned.get_mut(relay_id) else {
            return;
        };
        if owned.state != IdState::Closed {
            owned.state = IdState::Closed;
            self.closing.push_back((
                Instant::now() + DETACHED_CONNECTION_HOLD,
                relay_id.to_owned(),
            ));
        }
        self.forget_closed();
    }

    /// Forgets every id of `connection`, which went away, and answers the relay ids of those its
    /// mint's answer had made live; a mint's answer that comes later finds its id owned by no one.
    pub(super) fn forget_connection(&mut self, connection: RelayConnectionId) -> Vec<String> {
        let Some(ids) = self.relay_ids.remove(&connection) else {
            return Vec::new();
        };
        ids.into_values()
            .filter(|relay_id| {
                self.owned
                    .remove(relay_id)
                    .is_some_and(|owned| owned.state == IdState::Live)
            })
            .collect()
    }

    /// Hands every id of `from`, whose dropped connection's session `to` resumed, to `to`.
    pub(super) fn move_connection(&mut self, from: RelayConnectionId, to: RelayConnectionId) {
        let Some(ids) = self.relay_ids.remove(&from) else {
            return;
        };
        for relay_id in ids.values() {
            if let Some(owned) = self.owned.get_mut(relay_id) {
                owned.owner.connection = to;
            }
        }
        self.relay_ids.insert(to, ids);
    }

    /// Notes `seq` as the number of the last event the executor reported under `relay_id`.
    pub(super) fn note_seq(&mut self, relay_id: &str, seq: u64) {
        if let Some(owned) = self.owned.get_mut(relay_id) {
            owned.last_seq = owned.last_seq.max(seq);
        }
    }

    /// Forgets every id, the executor having ended, and answers the owner of each live one with
    /// the number of the last event reported under it.
    pub(super) fn clear(&mut self) -> Vec<(IdOwner, u64)> {
        let owned = std::mem::take(&mut self.owned);
        *self = Self::new(self.kind);
        owned
            .into_values()
            .filter(|owned| owned.state == IdState::Live)
            .map(|owned| (owned.owner, owned.last_seq))
            .collect()
    }

    // Forgets the closed ids the executor no longer keeps.
    fn forget_closed(&mut self) {
        let now = Instant::now();
        while let Some((_due, relay_id)) = self.closing.front().filter(|(due, _)| *due <= now) {
            let relay_id = relay_id.clone();
            self.closing.pop_front();
            self.forget(&relay_id);
        }
    }
}

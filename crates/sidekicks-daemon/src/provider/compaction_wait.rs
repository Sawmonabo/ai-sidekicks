//! The pending-compaction wait both drivers share. Both providers answer a compaction request
//! before the work is done, so `applied` is admitted only by the provider's typed compaction frame:
//! arm, dispatch, then wait for it.
//!
//! - The wait has no time limit of its own: it ends when the frame arrives, when the provider ends
//!   the compaction's turn without one, or when the binding stops being live.
//! - A late frame still becomes `agent.run.context.compacted` on its ordinary route, waited on or
//!   not.
//! - Settlement is per key; withdrawal is per waiter and settles no one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::oneshot;

/// How a compaction wait ended; only `Observed` admits `applied`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompactionWaitTerminal {
    /// The provider's typed compaction frame arrived.
    Observed,
    /// The provider ended the compaction's turn without a compaction frame.
    NotCompacted,
    /// The binding stopped being live before a compaction frame arrived.
    BindingLost,
}

impl CompactionWaitTerminal {
    /// Why a wait settled with no compaction, in words for the driver's diagnostic; `None` for
    /// `Observed`.
    pub(crate) const fn failure_detail(self) -> Option<&'static str> {
        match self {
            Self::Observed => None,
            Self::NotCompacted => {
                Some("the provider ended the compaction's turn without a compaction frame")
            }
            Self::BindingLost => {
                Some("the binding stopped being live before a compaction frame arrived")
            }
        }
    }
}

/// The settlement handed to one waiter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CompactionWaitSettlement {
    /// How the wait ended.
    pub(crate) terminal: CompactionWaitTerminal,
    /// Where the compaction's boundary sits, when the frame says; `None` unless `Observed`.
    pub(crate) boundary_position: Option<u64>,
}

/// The armed waits: each key's waiters by their id, and the next id to hand out.
#[derive(Default)]
struct ArmedWaits {
    /// Each key's waiters; a key goes with its last waiter.
    by_key: HashMap<String, HashMap<u64, oneshot::Sender<CompactionWaitSettlement>>>,
    /// The id the next armed waiter takes.
    next_waiter_id: u64,
}

/// The pending compactions of one driver, keyed by the driver's address for a live binding. The
/// key names the binding a wait was dispatched under, so a path that replaces the binding can
/// release its stranded waits; clones share the same waits.
#[derive(Clone, Default)]
pub(crate) struct PendingCompactionRegistry {
    /// The waits every clone shares.
    waits: Arc<Mutex<ArmedWaits>>,
}

impl PendingCompactionRegistry {
    /// Arms a wait for `key`. Arm before dispatching: a frame delivered before the registration
    /// would find no waiter, and the wait would never see it.
    pub(crate) fn arm(&self, key: &str) -> ArmedCompactionWait {
        let (sender, receiver) = oneshot::channel();
        let mut waits = self.waits.lock().unwrap_or_else(PoisonError::into_inner);
        let waiter_id = waits.next_waiter_id;
        waits.next_waiter_id += 1;
        waits
            .by_key
            .entry(key.to_owned())
            .or_default()
            .insert(waiter_id, sender);
        ArmedCompactionWait {
            waits: Arc::clone(&self.waits),
            key: key.to_owned(),
            waiter_id,
            receiver: Some(receiver),
        }
    }

    /// A typed compaction frame arrived on `key`: settles every waiter; a no-op with none armed.
    pub(crate) fn observe_boundary(&self, key: &str, boundary_position: Option<u64>) {
        self.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::Observed,
                boundary_position,
            },
        );
    }

    /// The provider ended the turn that ran the compaction on `key`, which delivers its frame
    /// before that end: settles every waiter still armed. A no-op with none.
    pub(crate) fn observe_turn_end(&self, key: &str) {
        self.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::NotCompacted,
                boundary_position: None,
            },
        );
    }

    /// The binding behind `key` is gone (teardown, quarantine): settles every waiter. A no-op
    /// with none.
    pub(crate) fn release_binding(&self, key: &str) {
        self.settle_all(
            key,
            CompactionWaitSettlement {
                terminal: CompactionWaitTerminal::BindingLost,
                boundary_position: None,
            },
        );
    }

    /// How many waits are armed for `key`.
    pub(crate) fn pending_count_for(&self, key: &str) -> usize {
        self.waits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .by_key
            .get(key)
            .map_or(0, HashMap::len)
    }

    fn settle_all(&self, key: &str, settlement: CompactionWaitSettlement) {
        let waiters = self
            .waits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .by_key
            .remove(key);
        for sender in waiters.into_iter().flat_map(HashMap::into_values) {
            // A send fails only for a waiter dropping at this moment, which has withdrawn.
            let _withdrawn = sender.send(settlement);
        }
    }
}

/// One armed wait. Dropping it before it settles withdraws it without settling any other waiter,
/// so a caller drops it on a failed dispatch and awaits [`Self::settled`] on a successful one.
#[must_use = "dropping the wait withdraws it"]
pub(crate) struct ArmedCompactionWait {
    /// The waits this one is registered in.
    waits: Arc<Mutex<ArmedWaits>>,
    /// The key the wait was armed for.
    key: String,
    /// This waiter's id among the key's waiters.
    waiter_id: u64,
    /// Where the settlement arrives; taken once the wait is awaited.
    receiver: Option<oneshot::Receiver<CompactionWaitSettlement>>,
}

impl ArmedCompactionWait {
    /// Waits for the wait's terminal. Dropping the future before it ends withdraws the wait.
    pub(crate) async fn settled(mut self) -> CompactionWaitSettlement {
        let receiver = self
            .receiver
            .take()
            .expect("the receiver is taken only here, which consumes the wait");
        receiver.await.expect(
            "a registration's sender is dropped only after it sends or when this waiter withdraws",
        )
    }
}

impl Drop for ArmedCompactionWait {
    fn drop(&mut self) {
        let mut waits = self.waits.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(waiters) = waits.by_key.get_mut(&self.key) {
            waiters.remove(&self.waiter_id);
            if waiters.is_empty() {
                waits.by_key.remove(&self.key);
            }
        }
    }
}

//! A wait per key, armed before the action whose result settles it, so a result that lands while
//! the action runs still finds its waiter.
//!
//! - A key holds any number of waiters; a settlement reaches every waiter of its key, or of every
//!   key a predicate picks, and takes them out.
//! - A wait dropped before it settles withdraws itself alone and settles no one.
//! - The map's lock is held only while the map changes, never across an await or a send, so a
//!   settler on another task never waits on a waiter.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::mutex_lock::lock;

/// Each key's waiters by their id, and the id the next waiter takes.
struct ArmedWaits<Key, Settlement> {
    /// Each key's waiters; a key goes with its last waiter.
    by_key: HashMap<Key, HashMap<u64, oneshot::Sender<Settlement>>>,
    /// The id the next armed waiter takes.
    next_waiter_id: u64,
}

/// The armed waits on keys of one kind; clones share the same waits.
pub(crate) struct KeyedWaits<Key, Settlement> {
    /// The waits every clone shares. No holder panics while it changes the map, so a poisoned
    /// lock still holds whole waits.
    waits: Arc<Mutex<ArmedWaits<Key, Settlement>>>,
}

impl<Key, Settlement> Clone for KeyedWaits<Key, Settlement> {
    fn clone(&self) -> Self {
        Self {
            waits: Arc::clone(&self.waits),
        }
    }
}

impl<Key, Settlement> Default for KeyedWaits<Key, Settlement> {
    fn default() -> Self {
        Self {
            waits: Arc::new(Mutex::new(ArmedWaits {
                by_key: HashMap::new(),
                next_waiter_id: 0,
            })),
        }
    }
}

impl<Key: Eq + Hash + Clone, Settlement: Clone> KeyedWaits<Key, Settlement> {
    /// Arms a wait on `key`. Arm before the action whose result settles it: a settlement sent
    /// before the wait is armed finds no waiter.
    pub(crate) fn arm(&self, key: Key) -> ArmedWait<Key, Settlement> {
        let (sender, receiver) = oneshot::channel();
        let mut waits = lock(&self.waits);
        let waiter_id = waits.next_waiter_id;
        waits.next_waiter_id += 1;
        waits
            .by_key
            .entry(key.clone())
            .or_default()
            .insert(waiter_id, sender);
        drop(waits);
        ArmedWait {
            waits: Arc::clone(&self.waits),
            key,
            waiter_id,
            receiver: Some(receiver),
        }
    }

    /// Settles every waiter on `key` with `settlement`; a no-op with none armed.
    pub(crate) fn settle_all<Lookup>(&self, key: &Lookup, settlement: Settlement)
    where
        Key: Borrow<Lookup>,
        Lookup: Eq + Hash + ?Sized,
    {
        let waiters = lock(&self.waits).by_key.remove(key);
        send_to_each(
            waiters.into_iter().flat_map(HashMap::into_values),
            &settlement,
        );
    }

    /// Settles every waiter on each key `is_settled` picks with `settlement`; a no-op with none.
    pub(crate) fn settle_where(
        &self,
        mut is_settled: impl FnMut(&Key) -> bool,
        settlement: Settlement,
    ) {
        let mut waits = lock(&self.waits);
        let settled_keys: Vec<Key> = waits
            .by_key
            .keys()
            .filter(|key| is_settled(*key))
            .cloned()
            .collect();
        let waiters: Vec<_> = settled_keys
            .iter()
            .filter_map(|key| waits.by_key.remove(key))
            .flat_map(HashMap::into_values)
            .collect();
        drop(waits);
        send_to_each(waiters, &settlement);
    }

    /// How many waits are armed on `key`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the drivers' compaction arms the wait and reads it"
        )
    )]
    pub(crate) fn pending_count_for<Lookup>(&self, key: &Lookup) -> usize
    where
        Key: Borrow<Lookup>,
        Lookup: Eq + Hash + ?Sized,
    {
        lock(&self.waits).by_key.get(key).map_or(0, HashMap::len)
    }
}

// Sends `settlement` to each of `waiters`, the map's lock already released.
fn send_to_each<Settlement: Clone>(
    waiters: impl IntoIterator<Item = oneshot::Sender<Settlement>>,
    settlement: &Settlement,
) {
    for sender in waiters {
        // A send fails only for a waiter dropping at this moment, which has withdrawn.
        let _withdrawn = sender.send(settlement.clone());
    }
}

/// One armed wait. Dropping it before it settles withdraws it without settling any other waiter,
/// so a caller drops it when the action failed or answered first, and awaits [`Self::settled`]
/// otherwise.
#[must_use = "dropping the wait withdraws it"]
pub(crate) struct ArmedWait<Key: Eq + Hash, Settlement> {
    /// The waits this one is registered in.
    waits: Arc<Mutex<ArmedWaits<Key, Settlement>>>,
    /// The key the wait was armed on.
    key: Key,
    /// This waiter's id among the key's waiters.
    waiter_id: u64,
    /// Where the settlement arrives; taken once the wait is awaited.
    receiver: Option<oneshot::Receiver<Settlement>>,
}

impl<Key: Eq + Hash, Settlement> ArmedWait<Key, Settlement> {
    /// Waits for the wait's settlement. Dropping the future before it ends withdraws the wait.
    pub(crate) async fn settled(mut self) -> Settlement {
        let receiver = self
            .receiver
            .take()
            .expect("the receiver is taken only here, which consumes the wait");
        receiver.await.expect(
            "a registration's sender is dropped only after it sends or when this waiter withdraws",
        )
    }
}

impl<Key: Eq + Hash, Settlement> Drop for ArmedWait<Key, Settlement> {
    fn drop(&mut self) {
        let mut waits = lock(&self.waits);
        if let Some(waiters) = waits.by_key.get_mut(&self.key) {
            waiters.remove(&self.waiter_id);
            if waiters.is_empty() {
                waits.by_key.remove(&self.key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures::poll;

    use super::KeyedWaits;

    // Every waiter of a key is settled together, a predicate settles every key it picks, and a
    // dropped wait withdraws only itself. Killed by settling one waiter per key, and by a drop that
    // takes out the whole key.
    #[tokio::test]
    async fn a_settlement_reaches_every_waiter_it_names_and_a_drop_withdraws_one() {
        let waits = KeyedWaits::<(u8, u8), &str>::default();
        let first = waits.arm((1, 1));
        let second = waits.arm((1, 1));
        let withdrawn = waits.arm((1, 1));
        let same_run = waits.arm((1, 2));
        let other_run = waits.arm((2, 1));
        drop(withdrawn);
        assert_eq!(waits.pending_count_for(&(1, 1)), 2);

        waits.settle_all(&(1, 1), "row");
        assert_eq!(first.settled().await, "row");
        assert_eq!(second.settled().await, "row");

        waits.settle_where(|(run, _)| *run == 1, "ended");
        assert_eq!(same_run.settled().await, "ended");
        let mut other_run = std::pin::pin!(other_run.settled());
        assert!(poll!(other_run.as_mut()).is_pending());
        assert_eq!(waits.pending_count_for(&(2, 1)), 1);
    }
}

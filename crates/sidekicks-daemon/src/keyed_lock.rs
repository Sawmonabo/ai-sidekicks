//! A lock per key: callers on one key hold it one at a time in arrival order, callers on different
//! keys never wait for each other.
//!
//! - Acquiring returns a hold, and the hold is the reentrancy: code a holder calls on the same key
//!   takes the hold by reference instead of acquiring again, so it cannot wait on its own holder,
//!   and a task the holder spawns is handed the hold, since a hold on a `'static` lock is itself
//!   `'static`.
//! - The hold ends when it drops, by a value, an error or a cancel alike.
//! - Each key's queue is a FIFO mutex, removed once no caller holds or waits on it, so the map never
//!   grows with every key ever locked.
//! - Work that must land whole, or not at all, runs held in a task of its own (`run_held`), which
//!   keeps the key until the work ends even after its caller stops waiting.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::{OwnedMutexGuard, oneshot};
use tokio::task::JoinError;

/// A per-key, first-come-first-served lock held across awaits; see the module doc.
pub(crate) struct KeyedLock<Key> {
    canonical_key: fn(Key) -> Key,
    // Each key's queue, held by its holder and every waiter.
    queues: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
}

impl<Key: Eq + Hash + Clone> KeyedLock<Key> {
    /// A lock whose keys are compared as given.
    pub(crate) fn new() -> Self {
        Self::with_canonical_key(|key| key)
    }

    /// A lock that maps every spelling of one key to one value with `canonical_key`, so one key
    /// takes one lock.
    pub(crate) fn with_canonical_key(canonical_key: fn(Key) -> Key) -> Self {
        Self {
            canonical_key,
            queues: Mutex::new(HashMap::new()),
        }
    }

    /// Waits for `requested_key` behind every caller that asked for it first and returns the hold,
    /// which releases the key when it drops. Dropping the future while it waits gives up its place.
    pub(crate) async fn acquire(&self, requested_key: Key) -> KeyHold<'_, Key> {
        let key = (self.canonical_key)(requested_key);
        let queue = Arc::clone(self.lock_queues().entry(key.clone()).or_default());
        let mut hold = KeyHold {
            lock: self,
            key,
            queue: Some(Arc::clone(&queue)),
            guard: None,
        };
        hold.guard = Some(queue.lock_owned().await);
        hold
    }

    /// Runs `work` once `key` is held, in a task of its own that keeps the key until `work` ends
    /// even after the caller stops waiting, so work that lands late always lands before the next
    /// caller on that key runs. A task still waiting for the key when its caller stops waiting
    /// leaves the queue and drops `work` unrun; work that ends after its caller stopped waiting is
    /// handed to `landed_late`. Answers `None` only to a caller no longer waiting. Fails with the
    /// task's error when the work panics.
    pub(crate) async fn run_held<Answer: Send + 'static>(
        self: &Arc<Self>,
        key: Key,
        work: impl Future<Output = Answer> + Send + 'static,
        landed_late: impl FnOnce(&Answer) + Send + 'static,
    ) -> Result<Option<Answer>, JoinError>
    where
        Key: Send + Sync + 'static,
    {
        // The caller holds the receiver while it waits and drops it when it stops waiting.
        let (mut still_waiting, _caller_waits) = oneshot::channel::<()>();
        let lock = Arc::clone(self);
        tokio::spawn(async move {
            let _held = tokio::select! {
                held = lock.acquire(key) => held,
                () = still_waiting.closed() => return None,
            };
            // The caller may stop waiting just as the key comes free.
            if still_waiting.is_closed() {
                return None;
            }
            let answer = work.await;
            if still_waiting.is_closed() {
                landed_late(&answer);
            }
            Some(answer)
        })
        .await
    }

    fn lock_queues(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Arc<tokio::sync::Mutex<()>>>> {
        // The map holds no invariant a panicking holder could break.
        self.queues.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One caller's hold on one key of a [`KeyedLock`], from its wait to its release: dropping it ends
/// the hold, wakes the next waiter and removes the key's queue once no one else holds or waits on
/// it. Code that runs on the holder's key takes it by reference.
pub(crate) struct KeyHold<'lock, Key: Eq + Hash + Clone> {
    lock: &'lock KeyedLock<Key>,
    key: Key,
    queue: Option<Arc<tokio::sync::Mutex<()>>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl<Key: Eq + Hash + Clone> KeyHold<'_, Key> {
    /// The key held, in its canonical spelling.
    pub(crate) fn key(&self) -> &Key {
        &self.key
    }
}

impl<Key: Eq + Hash + Clone> Drop for KeyHold<'_, Key> {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut queues = self.lock.lock_queues();
        drop(self.queue.take());
        // A waiter or a new holder keeps its own handle on the queue, taken under the map's lock.
        if queues
            .get(&self.key)
            .is_some_and(|queue| Arc::strong_count(queue) == 1)
        {
            queues.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::poll;
    use tokio::sync::Notify;

    use super::{KeyHold, KeyedLock};

    async fn yield_a_few_times() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    // Work on the held key, as code a holder calls takes the hold.
    async fn work_on(hold: &KeyHold<'_, &'static str>) -> &'static str {
        yield_a_few_times().await;
        *hold.key()
    }

    #[tokio::test]
    async fn work_given_the_hold_runs_on_it_and_a_spawned_task_carries_it() {
        static LOCK: LazyLock<KeyedLock<&'static str>> = LazyLock::new(KeyedLock::new);
        let hold = LOCK.acquire("session").await;
        assert_eq!(work_on(&hold).await, "session");

        let mut outside = std::pin::pin!(LOCK.acquire("session"));
        assert!(poll!(outside.as_mut()).is_pending());
        // The hold goes to a spawned task; the key stays held until that task ends.
        let spawned = tokio::spawn(async move { work_on(&hold).await });
        assert_eq!(spawned.await.expect("the spawned task ends"), "session");
        drop(outside.await);
        assert!(LOCK.lock_queues().is_empty());
    }

    #[tokio::test]
    async fn a_second_caller_on_one_key_waits_for_the_first_to_release() {
        let lock = KeyedLock::<&str>::new();
        let first = lock.acquire("session").await;
        let mut second = std::pin::pin!(lock.acquire("session"));
        assert!(poll!(second.as_mut()).is_pending());
        yield_a_few_times().await;
        assert!(poll!(second.as_mut()).is_pending());
        drop(first);
        drop(second.await);
        assert!(lock.lock_queues().is_empty());
    }

    #[tokio::test]
    async fn callers_on_different_keys_hold_at_once() {
        let lock = KeyedLock::<&str>::new();
        let holding = AtomicUsize::new(0);
        let both_hold = Notify::new();
        let hold_until_both = |key| {
            let (lock, holding, both_hold) = (&lock, &holding, &both_hold);
            async move {
                let _hold = lock.acquire(key).await;
                if holding.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                    both_hold.notify_waiters();
                } else {
                    both_hold.notified().await;
                }
            }
        };
        tokio::join!(hold_until_both("first"), hold_until_both("second"));
        assert_eq!(holding.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failure_or_a_drop_releases_the_key() {
        let lock = KeyedLock::<&str>::new();
        let failed: Result<(), &str> = async {
            let _hold = lock.acquire("session").await;
            Err("refused")
        }
        .await;
        assert_eq!(failed, Err("refused"));
        assert!(lock.lock_queues().is_empty());

        let held = lock.acquire("session").await;
        let mut dropped = Box::pin(lock.acquire("session"));
        assert!(poll!(dropped.as_mut()).is_pending());
        drop(dropped);
        assert_eq!(lock.lock_queues().len(), 1);
        drop(held);
        assert!(lock.lock_queues().is_empty());
        drop(lock.acquire("session").await);
        assert!(lock.lock_queues().is_empty());
    }
}

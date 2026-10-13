//! A reentrant lock per key: callers on one key run one at a time in arrival order, callers on
//! different keys never wait for each other.
//!
//! - Callers nest: a caller holding key K that calls code taking K again runs that code on its own
//!   hold. A plain mutex would deadlock, so the holds ride in a task-local set: code inside a hold
//!   on K reuses it, and a caller outside that scope waits.
//! - The set holds every hold the task runs inside, across locks and keys, because nesting crosses
//!   keys: a hold on A that nests a hold on B must acquire B, and a further nested call on A must
//!   still reenter.
//! - A hold is marked released when it ends, and a released hold grants no reentrancy: a task given
//!   the holder's keys may outlive the hold, so it then acquires normally.
//! - Each key's queue is a FIFO mutex, removed once no caller holds or waits on it, so the map never
//!   grows with every key ever locked.

use std::any::Any;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::OwnedMutexGuard;

tokio::task_local! {
    // Every hold the current task runs inside, across every keyed lock.
    static HOLDS: HeldKeys;
}

// Each lock's own id, so one task-local set serves every lock.
static NEXT_LOCK_ID: AtomicU64 = AtomicU64::new(0);

// One acquisition: the lock it belongs to, its key, and whether it has ended.
#[derive(Clone)]
struct Hold {
    lock_id: u64,
    key: Arc<dyn Any + Send + Sync>,
    is_released: Arc<AtomicBool>,
}

/// The holds a task runs inside, across every keyed lock. A task that must be spawned inside a hold
/// takes [`HeldKeys::current`] with it and runs in [`HeldKeys::scope`], so it reenters the holds
/// while they last.
#[derive(Clone, Default)]
pub(crate) struct HeldKeys(Vec<Hold>);

impl HeldKeys {
    /// The holds the calling task runs inside; empty outside every hold.
    pub(crate) fn current() -> Self {
        HOLDS.try_with(Clone::clone).unwrap_or_default()
    }

    /// Runs `work` inside these holds, as the task that took them runs.
    pub(crate) async fn scope<Work: Future>(self, work: Work) -> Work::Output {
        HOLDS.scope(self, work).await
    }

    fn is_live<Key: Eq + 'static>(&self, lock_id: u64, key: &Key) -> bool {
        self.0.iter().any(|hold| {
            hold.lock_id == lock_id
                && !hold.is_released.load(Ordering::Acquire)
                && hold.key.downcast_ref::<Key>() == Some(key)
        })
    }

    fn with(mut self, hold: Hold) -> Self {
        self.0.push(hold);
        self
    }
}

/// A per-key, reentrant, first-come-first-served lock held across awaits. Work on the same key
/// inside a hold runs as a future of the holder, never a spawned task, unless that task runs in
/// [`HeldKeys::scope`].
pub(crate) struct KeyedLock<Key> {
    id: u64,
    canonical_key: fn(Key) -> Key,
    // Each key's queue, held by its holder and every waiter.
    queues: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
}

impl<Key: Eq + Hash + Clone + Send + Sync + 'static> KeyedLock<Key> {
    /// A lock whose keys are compared as given.
    pub(crate) fn new() -> Self {
        Self::with_canonical_key(|key| key)
    }

    /// A lock that maps every spelling of one key to one value with `canonical_key`, so one key
    /// takes one lock.
    pub(crate) fn with_canonical_key(canonical_key: fn(Key) -> Key) -> Self {
        Self {
            id: NEXT_LOCK_ID.fetch_add(1, Ordering::Relaxed),
            canonical_key,
            queues: Mutex::new(HashMap::new()),
        }
    }

    /// Runs `critical` holding `requested_key` and releases it when `critical` ends, with a value,
    /// an error or by being dropped. Inside a live hold on the same key, runs `critical` on that
    /// hold, which only its acquiring frame releases.
    pub(crate) async fn run<Output, Critical: Future<Output = Output>>(
        &self,
        requested_key: Key,
        critical: impl FnOnce() -> Critical,
    ) -> Output {
        let key = (self.canonical_key)(requested_key);
        let held_keys = HeldKeys::current();
        if held_keys.is_live(self.id, &key) {
            return critical().await;
        }
        let queue = Arc::clone(self.lock_queues().entry(key.clone()).or_default());
        let mut lease = KeyLease {
            lock: self,
            key: key.clone(),
            queue: Some(Arc::clone(&queue)),
            guard: None,
            is_released: None,
        };
        lease.guard = Some(queue.lock_owned().await);
        let is_released = Arc::new(AtomicBool::new(false));
        lease.is_released = Some(Arc::clone(&is_released));
        let holds = held_keys.with(Hold {
            lock_id: self.id,
            key: Arc::new(key),
            is_released,
        });
        HOLDS.scope(holds, async move { critical().await }).await
    }

    /// Whether the calling task runs inside a live hold on any key of this lock.
    pub(crate) fn is_held_here(&self) -> bool {
        HOLDS
            .try_with(|held_keys| {
                held_keys.0.iter().any(|hold| {
                    hold.lock_id == self.id && !hold.is_released.load(Ordering::Acquire)
                })
            })
            .unwrap_or(false)
    }

    fn lock_queues(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Arc<tokio::sync::Mutex<()>>>> {
        // The map holds no invariant a panicking holder could break.
        self.queues.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// A caller's place on one key, from its wait to its release: dropping it ends the hold, wakes the
// next waiter and removes the key's queue once no one else holds or waits on it.
struct KeyLease<'lock, Key: Eq + Hash + Clone + Send + Sync + 'static> {
    lock: &'lock KeyedLock<Key>,
    key: Key,
    queue: Option<Arc<tokio::sync::Mutex<()>>>,
    guard: Option<OwnedMutexGuard<()>>,
    is_released: Option<Arc<AtomicBool>>,
}

impl<Key: Eq + Hash + Clone + Send + Sync + 'static> Drop for KeyLease<'_, Key> {
    fn drop(&mut self) {
        if let Some(is_released) = &self.is_released {
            is_released.store(true, Ordering::Release);
        }
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::poll;
    use tokio::sync::Notify;

    use super::KeyedLock;

    async fn yield_a_few_times() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn a_nested_call_on_the_held_key_runs_on_the_outer_hold() {
        let lock = KeyedLock::<&str>::new();
        let inner = lock
            .run("session", || async {
                assert!(lock.is_held_here());
                lock.run("session", || async { "inner done" }).await
            })
            .await;
        assert_eq!(inner, "inner done");
        assert!(!lock.is_held_here());
        assert!(lock.lock_queues().is_empty());
    }

    #[tokio::test]
    async fn a_second_caller_on_one_key_waits_for_the_first_to_release() {
        let lock = Arc::new(KeyedLock::<&str>::new());
        let first_holds = Arc::new(Notify::new());
        let first_may_end = Arc::new(Notify::new());
        let first = tokio::spawn({
            let (lock, first_holds, first_may_end) = (
                Arc::clone(&lock),
                Arc::clone(&first_holds),
                Arc::clone(&first_may_end),
            );
            async move {
                lock.run("session", || async {
                    first_holds.notify_one();
                    first_may_end.notified().await;
                })
                .await;
            }
        });
        first_holds.notified().await;
        let mut second = std::pin::pin!(lock.run("session", || async { "second ran" }));
        assert!(poll!(second.as_mut()).is_pending());
        yield_a_few_times().await;
        assert!(poll!(second.as_mut()).is_pending());
        first_may_end.notify_one();
        first.await.expect("the first holder ends");
        assert_eq!(second.await, "second ran");
        assert!(lock.lock_queues().is_empty());
    }

    #[tokio::test]
    async fn callers_on_different_keys_hold_at_once() {
        let lock = KeyedLock::<&str>::new();
        let holding = AtomicUsize::new(0);
        let both_hold = Notify::new();
        let hold_until_both = || async {
            if holding.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                both_hold.notify_waiters();
            } else {
                both_hold.notified().await;
            }
        };
        tokio::join!(
            lock.run("first", hold_until_both),
            lock.run("second", hold_until_both)
        );
        assert_eq!(holding.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn only_the_acquiring_frame_releases_on_a_failure() {
        let lock = KeyedLock::<&str>::new();
        let failed: Result<(), &str> = lock.run("session", || async { Err("refused") }).await;
        assert_eq!(failed, Err("refused"));
        assert!(lock.lock_queues().is_empty());
        assert_eq!(
            lock.run("session", || async { "acquired again" }).await,
            "acquired again"
        );

        lock.run("session", || async {
            let inner: Result<(), &str> =
                lock.run("session", || async { Err("inner refused") }).await;
            assert_eq!(inner, Err("inner refused"));
            assert!(lock.is_held_here());
            assert_eq!(
                lock.run("session", || async { "still reentrant" }).await,
                "still reentrant"
            );
            assert_eq!(lock.lock_queues().len(), 1);
        })
        .await;
        assert!(!lock.is_held_here());
        assert!(lock.lock_queues().is_empty());

        let mut dropped = Box::pin(lock.run("session", || std::future::pending::<()>()));
        assert!(poll!(dropped.as_mut()).is_pending());
        drop(dropped);
        assert!(lock.lock_queues().is_empty());
        assert_eq!(
            lock.run("session", || async { "after a drop" }).await,
            "after a drop"
        );
    }
}

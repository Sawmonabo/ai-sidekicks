//! A lock per key: callers on one key hold it one at a time in arrival order, callers on different
//! keys never wait for each other.
//!
//! - Acquiring returns a hold, and the hold is the reentrancy: code a holder calls on the same key
//!   takes the hold by reference instead of acquiring again, so it cannot wait on its own holder,
//!   and a task the holder spawns is handed the hold, since a hold on a `'static` lock is itself
//!   `'static`.
//! - The hold ends when it drops, by a value, an error or a cancel alike.
//! - A caller that must fix its place before it awaits takes it with `try_acquire`: the hold when
//!   the key is free, else a wait that keeps the place it took.
//! - Each key's queue is a FIFO mutex, removed once no caller holds or waits on it, so the map
//!   never grows with every key ever locked.
//! - Work that must land whole, or not at all, runs held in a task of its own (`run_held`), which
//!   keeps the key until the work ends even after its caller stops waiting.

mod handles;
pub mod read_write;

use std::hash::Hash;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use tokio::sync::{OwnedMutexGuard, oneshot};
use tokio::task::JoinError;

use crate::keyed_lock::handles::{KeyHandle, KeyHandles};

/// A per-key, first-come-first-served lock held across awaits; see the module doc.
pub struct KeyedLock<Key> {
    canonical_key: fn(Key) -> Key,
    // Each key's queue, held by its holder and every waiter.
    queues: KeyHandles<Key, tokio::sync::Mutex<()>>,
}

impl<Key: Eq + Hash + Clone> Default for KeyedLock<Key> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Key: Eq + Hash + Clone> KeyedLock<Key> {
    /// A lock whose keys are compared as given.
    pub fn new() -> Self {
        Self::with_canonical_key(|key| key)
    }

    /// A lock that maps every spelling of one key to one value with `canonical_key`, so one key
    /// takes one lock.
    pub(crate) fn with_canonical_key(canonical_key: fn(Key) -> Key) -> Self {
        Self {
            canonical_key,
            queues: KeyHandles::new(),
        }
    }

    /// Waits for `requested_key` behind every caller that asked for it first and returns the hold,
    /// which releases the key when it drops. Dropping the future while it waits gives up its place.
    pub async fn acquire(&self, requested_key: Key) -> KeyHold<'_, Key> {
        let mut hold = KeyHold {
            guard: None,
            handle: self.queues.join((self.canonical_key)(requested_key)),
        };
        hold.guard = Some(hold.handle.key_lock().lock_owned().await);
        hold
    }

    /// Holds every key of `requested_keys`, each once, taking them one after another in sorted
    /// order, so two callers that each hold several of the same keys never wait on each other.
    pub async fn acquire_all(
        &self,
        requested_keys: impl IntoIterator<Item = Key>,
    ) -> Vec<KeyHold<'_, Key>>
    where
        Key: Ord,
    {
        let mut keys: Vec<Key> = requested_keys.into_iter().map(self.canonical_key).collect();
        keys.sort();
        keys.dedup();
        let mut holds = Vec::with_capacity(keys.len());
        for key in keys {
            holds.push(self.acquire(key).await);
        }
        holds
    }

    /// Takes `requested_key`'s place in line at once, with no await: the hold when no one holds or
    /// waits on the key, else a wait that keeps this place behind every caller that asked first,
    /// which awaiting carries on from and dropping gives up.
    pub fn try_acquire(&self, requested_key: Key) -> Result<KeyHold<'_, Key>, KeyWait<'_, Key>>
    where
        Key: Send + Sync,
    {
        // Unconstrained in every poll, the first one's join of the queue included, so no exhausted
        // task budget holds a poll of the wait back.
        let mut acquiring: Pin<Box<dyn Future<Output = KeyHold<'_, Key>> + Send + '_>> =
            Box::pin(tokio::task::unconstrained(self.acquire(requested_key)));
        // One poll joins the key's queue, which tokio's mutex serves in the order it was joined;
        // the task that awaits the wait polls it again with its own waker from that place.
        match acquiring
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(hold) => Ok(hold),
            Poll::Pending => Err(KeyWait(acquiring)),
        }
    }

    /// Runs `work` once `key` is held, in a task of its own that keeps the key until `work` ends
    /// even after the caller stops waiting, so work that lands late always lands before the next
    /// caller on that key runs. A task still waiting for the key when its caller stops waiting
    /// leaves the queue and drops `work` unrun; work that ends after its caller stopped waiting is
    /// handed to `landed_late`. Fails `Unanswered` only to a caller no longer waiting, and
    /// `Interrupted` with the task's error when the work panics.
    pub async fn run_held<Answer: Send + 'static>(
        self: &Arc<Self>,
        key: Key,
        work: impl Future<Output = Answer> + Send + 'static,
        landed_late: impl FnOnce(&Answer) + Send + 'static,
    ) -> Result<Answer, HeldWorkEnd>
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
        .map_err(HeldWorkEnd::Interrupted)?
        .ok_or(HeldWorkEnd::Unanswered)
    }

    /// How many handles on `requested_key`'s queue its holder and its waiters keep, beside the
    /// map's own; 0 when no one holds or waits on it. A waiter keeps handles of its own, so the
    /// count rises once a caller waits behind the holder.
    #[cfg(any(test, feature = "test-support"))]
    pub fn queue_handle_count(&self, requested_key: Key) -> usize {
        self.queues
            .handle_count(&(self.canonical_key)(requested_key))
    }

    /// Waits until `requested_key`'s queue holds more handles than `handles`, a count
    /// [`Self::queue_handle_count`] read, as once another caller joins its line; woken by each
    /// caller that joins a queue, never by a timer.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn wait_for_queue_past(&self, requested_key: Key, handles: usize) {
        self.queues
            .wait_for_handles_past(&(self.canonical_key)(requested_key), handles)
            .await;
    }
}

/// How work run under [`KeyedLock::run_held`] ended without answering.
#[derive(Debug, thiserror::Error)]
pub enum HeldWorkEnd {
    /// The work was skipped, since its caller stopped waiting before the key was held.
    #[error("the held work was skipped once its caller stopped waiting")]
    Unanswered,
    /// The task that ran the work ended before the work finished.
    #[error("the held work ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// One caller's hold on one key of a [`KeyedLock`], from its wait to its release: dropping it ends
/// the hold, wakes the next waiter and removes the key's queue once no one else holds or waits on
/// it. Code that runs on the holder's key takes it by reference.
pub struct KeyHold<'lock, Key: Eq + Hash + Clone> {
    // Declared before `handle`, so the guard drops first.
    guard: Option<OwnedMutexGuard<()>>,
    handle: KeyHandle<'lock, Key, tokio::sync::Mutex<()>>,
}

impl<Key: Eq + Hash + Clone> KeyHold<'_, Key> {
    /// The key held, in its canonical spelling.
    pub fn key(&self) -> &Key {
        self.handle.key()
    }
}

/// A caller's place in a key's line, taken by [`KeyedLock::try_acquire`] behind every caller that
/// asked first: awaiting it answers the hold once those ahead release the key, and dropping it
/// gives up the place.
pub struct KeyWait<'lock, Key: Eq + Hash + Clone>(
    Pin<Box<dyn Future<Output = KeyHold<'lock, Key>> + Send + 'lock>>,
);

impl<'lock, Key: Eq + Hash + Clone> Future for KeyWait<'lock, Key> {
    type Output = KeyHold<'lock, Key>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.0.as_mut().poll(context)
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
        assert_eq!(LOCK.queues.key_count(), 0);
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
        assert_eq!(lock.queues.key_count(), 0);
    }

    // A place taken with no await is kept ahead of a caller that asks later, whichever polls first.
    // Killed by a `try_acquire` that only tries the lock and joins the queue at the first await.
    #[tokio::test]
    async fn a_place_taken_with_no_await_is_served_before_a_later_caller() {
        let lock = KeyedLock::<&str>::new();
        let Ok(first) = lock.try_acquire("session") else {
            panic!("a free key is held at once");
        };
        let Err(placed) = lock.try_acquire("session") else {
            panic!("a held key is not held twice");
        };
        let mut later = std::pin::pin!(lock.acquire("session"));
        assert!(poll!(later.as_mut()).is_pending());
        drop(first);
        assert!(
            poll!(later.as_mut()).is_pending(),
            "the place taken first comes first"
        );
        let placed = placed.await;
        assert!(poll!(later.as_mut()).is_pending());
        drop(placed);
        drop(later.await);
        assert_eq!(lock.queues.key_count(), 0);
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
        assert_eq!(lock.queues.key_count(), 0);

        let held = lock.acquire("session").await;
        let mut dropped = Box::pin(lock.acquire("session"));
        assert!(poll!(dropped.as_mut()).is_pending());
        drop(dropped);
        assert_eq!(lock.queues.key_count(), 1);
        drop(held);
        assert_eq!(lock.queues.key_count(), 0);
        drop(lock.acquire("session").await);
        assert_eq!(lock.queues.key_count(), 0);
    }
}

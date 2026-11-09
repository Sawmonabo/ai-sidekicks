//! A read and write lock per key: on one key any number of readers hold at once and a writer holds
//! alone, served in arrival order, so a writer waiting keeps every later reader behind it; callers
//! on different keys never wait for each other.
//!
//! - Acquiring returns a hold, which ends when it drops, by a value, an error or a cancel alike.
//!   A caller takes one hold per operation and passes it down: a second read on a key whose writer
//!   waits behind the first would wait on its own holder.
//! - Each key's lock is removed once no caller holds or waits on it, so the map never grows with
//!   every key ever locked.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::mutex_lock::lock;

/// A per-key, first-come-first-served read and write lock held across awaits; see the module doc.
pub struct KeyedReadWriteLock<Key> {
    // Each key's lock, held by its holders and every waiter.
    locks: Mutex<HashMap<Key, Arc<RwLock<()>>>>,
    // Told each time a caller joins a key's line, so a test awaits a waiter instead of polling.
    #[cfg(any(test, feature = "test-support"))]
    line_joined: tokio::sync::Notify,
}

impl<Key: Eq + Hash + Clone> Default for KeyedReadWriteLock<Key> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Key: Eq + Hash + Clone> KeyedReadWriteLock<Key> {
    /// A lock with no key held.
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            line_joined: tokio::sync::Notify::new(),
        }
    }

    /// Waits for `key` behind every writer that asked for it first and returns a shared hold,
    /// which other readers share. Dropping the future while it waits gives up its place.
    pub async fn read(&self, key: Key) -> KeyReadHold<'_, Key> {
        let release = self.join_line(key);
        let guard = Arc::clone(&release.handle).read_owned().await;
        KeyReadHold {
            _guard: guard,
            _release: release,
        }
    }

    /// Waits for `key` behind every caller that asked for it first and returns the one hold on it.
    /// Dropping the future while it waits gives up its place.
    pub async fn write(&self, key: Key) -> KeyWriteHold<'_, Key> {
        let release = self.join_line(key);
        let guard = Arc::clone(&release.handle).write_owned().await;
        KeyWriteHold {
            _guard: guard,
            _release: release,
        }
    }

    /// How many handles on `key`'s lock its holders and its waiters keep, beside the map's own; 0
    /// when no one holds or waits on it.
    #[cfg(any(test, feature = "test-support"))]
    pub fn handle_count(&self, key: &Key) -> usize {
        self.lock_map()
            .get(key)
            .map_or(0, |handle| Arc::strong_count(handle) - 1)
    }

    /// Waits until `key`'s lock holds more handles than `handles`, a count
    /// [`Self::handle_count`] read, as once another caller joins its line; woken by each caller
    /// that joins a line, never by a timer.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn wait_for_line_past(&self, key: &Key, handles: usize) {
        loop {
            let joined = self.line_joined.notified();
            let mut joined = std::pin::pin!(joined);
            // Registered before the count is read, so a join after the read still wakes it.
            joined.as_mut().enable();
            if self.handle_count(key) > handles {
                return;
            }
            joined.await;
        }
    }

    // Takes a handle on `key`'s lock, made when no one holds or waits on it.
    fn join_line(&self, key: Key) -> Release<'_, Key> {
        let handle = Arc::clone(self.lock_map().entry(key.clone()).or_default());
        #[cfg(any(test, feature = "test-support"))]
        self.line_joined.notify_waiters();
        Release {
            lock: self,
            key,
            handle,
        }
    }

    fn lock_map(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Arc<RwLock<()>>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.locks)
    }
}

/// One reader's shared hold on one key of a [`KeyedReadWriteLock`]: dropping it ends the hold and
/// removes the key's lock once no one else holds or waits on it.
pub struct KeyReadHold<'lock, Key: Eq + Hash + Clone> {
    // Declared before `_release`, so the guard drops first.
    _guard: OwnedRwLockReadGuard<()>,
    _release: Release<'lock, Key>,
}

/// The one writer's hold on one key of a [`KeyedReadWriteLock`]: dropping it ends the hold, lets
/// the callers waiting behind it in, and removes the key's lock once no one holds or waits on it.
pub struct KeyWriteHold<'lock, Key: Eq + Hash + Clone> {
    // Declared before `_release`, so the guard drops first.
    _guard: OwnedRwLockWriteGuard<()>,
    _release: Release<'lock, Key>,
}

/// A caller's handle on a key's lock, from joining its line to the end of its hold.
struct Release<'lock, Key: Eq + Hash + Clone> {
    lock: &'lock KeyedReadWriteLock<Key>,
    key: Key,
    handle: Arc<RwLock<()>>,
}

impl<Key: Eq + Hash + Clone> Drop for Release<'_, Key> {
    fn drop(&mut self) {
        let mut locks = self.lock.lock_map();
        // The map's handle and this one alone: a waiter or a new holder keeps its own, taken
        // under the map's lock, and this hold's guard dropped before it.
        if locks
            .get(&self.key)
            .is_some_and(|handle| Arc::strong_count(handle) == 2)
        {
            locks.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use futures::poll;

    use super::KeyedReadWriteLock;

    // Kills: a writer let in beside a reader, a reader let in beside a writer, a reader that asked
    // after a waiting writer let in ahead of it, and a key's lock kept once no one holds it.
    #[tokio::test]
    async fn readers_share_a_key_a_writer_holds_it_alone_and_a_waiting_writer_comes_first() {
        let lock = KeyedReadWriteLock::<&str>::new();
        let first = lock.read("session").await;
        let second = lock.read("session").await;
        let mut writer = std::pin::pin!(lock.write("session"));
        assert!(
            poll!(writer.as_mut()).is_pending(),
            "a writer waits for readers"
        );
        let mut later_reader = std::pin::pin!(lock.read("session"));
        assert!(
            poll!(later_reader.as_mut()).is_pending(),
            "a reader that asked after a waiting writer waits behind it"
        );
        let other = lock.write("other").await;
        drop((first, second, other));
        let written = writer.await;
        assert!(
            poll!(later_reader.as_mut()).is_pending(),
            "a writer holds alone"
        );
        drop(written);
        drop(later_reader.await);
        assert!(lock.lock_map().is_empty());
    }

    // Kills: a dropped wait that keeps the key's lock in the map.
    #[tokio::test]
    async fn a_wait_given_up_releases_its_place() {
        let lock = KeyedReadWriteLock::<&str>::new();
        let held = lock.write("session").await;
        let held_count = lock.handle_count(&"session");
        let mut dropped = Box::pin(lock.read("session"));
        assert!(poll!(dropped.as_mut()).is_pending());
        assert!(lock.handle_count(&"session") > held_count);
        drop(dropped);
        assert_eq!(lock.handle_count(&"session"), held_count);
        drop(held);
        assert!(lock.lock_map().is_empty());
    }
}

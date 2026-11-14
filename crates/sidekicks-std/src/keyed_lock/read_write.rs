//! A read and write lock per key: on one key any number of readers hold at once and a writer holds
//! alone, served in arrival order, so a writer waiting keeps every later reader behind it; callers
//! on different keys never wait for each other.
//!
//! - Acquiring returns a hold, which ends when it drops, by a value, an error or a cancel alike.
//!   A caller takes one hold per operation and passes it down: a second read on a key whose writer
//!   waits behind the first would wait on its own holder.
//! - Each key's lock is removed once no caller holds or waits on it, so the map never grows with
//!   every key ever locked.

use std::hash::Hash;

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::keyed_lock::handles::{KeyHandle, KeyHandles};

/// A per-key, first-come-first-served read and write lock held across awaits; see the module doc.
pub struct KeyedReadWriteLock<Key> {
    // Each key's lock, held by its holders and every waiter.
    locks: KeyHandles<Key, RwLock<()>>,
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
            locks: KeyHandles::new(),
        }
    }

    /// Waits for `key` behind every writer that asked for it first and returns a shared hold,
    /// which other readers share. Dropping the future while it waits gives up its place.
    pub async fn read(&self, key: Key) -> KeyReadHold<'_, Key> {
        let handle = self.locks.join(key);
        let guard = handle.key_lock().read_owned().await;
        KeyReadHold {
            _guard: guard,
            _handle: handle,
        }
    }

    /// Waits for `key` behind every caller that asked for it first and returns the one hold on it.
    /// Dropping the future while it waits gives up its place.
    pub async fn write(&self, key: Key) -> KeyWriteHold<'_, Key> {
        let handle = self.locks.join(key);
        let guard = handle.key_lock().write_owned().await;
        KeyWriteHold {
            _guard: guard,
            _handle: handle,
        }
    }

    /// How many handles on `key`'s lock its holders and its waiters keep, beside the map's own; 0
    /// when no one holds or waits on it.
    #[cfg(any(test, feature = "test-support"))]
    pub fn handle_count(&self, key: &Key) -> usize {
        self.locks.handle_count(key)
    }

    /// Waits until `key`'s lock holds more handles than `handles`, a count
    /// [`Self::handle_count`] read, as once another caller joins its line; woken by each caller
    /// that joins a line, never by a timer.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn wait_for_line_past(&self, key: &Key, handles: usize) {
        self.locks.wait_for_handles_past(key, handles).await;
    }
}

/// One reader's shared hold on one key of a [`KeyedReadWriteLock`]: dropping it ends the hold and
/// removes the key's lock once no one else holds or waits on it.
pub struct KeyReadHold<'lock, Key: Eq + Hash + Clone> {
    // Declared before `_handle`, so the guard drops first.
    _guard: OwnedRwLockReadGuard<()>,
    _handle: KeyHandle<'lock, Key, RwLock<()>>,
}

/// The one writer's hold on one key of a [`KeyedReadWriteLock`]: dropping it ends the hold, lets
/// the callers waiting behind it in, and removes the key's lock once no one holds or waits on it.
pub struct KeyWriteHold<'lock, Key: Eq + Hash + Clone> {
    // Declared before `_handle`, so the guard drops first.
    _guard: OwnedRwLockWriteGuard<()>,
    _handle: KeyHandle<'lock, Key, RwLock<()>>,
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
        assert_eq!(lock.locks.key_count(), 0);
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
        assert_eq!(lock.locks.key_count(), 0);
    }
}

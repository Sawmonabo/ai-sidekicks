//! The map both keyed locks keep of each key's lock: a caller takes a handle on it when it joins
//! the key's line and gives it back when its hold ends, and the entry goes once only the map's own
//! handle is left, so the map never grows with every key ever locked.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::mutex_lock::lock;

/// Each key's lock, `Lock` made at a key's first caller and removed once no caller keeps it.
pub(super) struct KeyHandles<Key, Lock> {
    // Each key's lock, held by its holders and every waiter.
    locks: Mutex<HashMap<Key, Arc<Lock>>>,
    // Told each time a caller joins a key's line, so a test awaits a waiter instead of polling.
    #[cfg(any(test, feature = "test-support"))]
    line_joined: tokio::sync::Notify,
}

impl<Key: Eq + Hash + Clone, Lock: Default> KeyHandles<Key, Lock> {
    /// A map with no key held.
    pub(super) fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            line_joined: tokio::sync::Notify::new(),
        }
    }

    /// Takes a handle on `key`'s lock, made when no one holds or waits on it.
    pub(super) fn join(&self, key: Key) -> KeyHandle<'_, Key, Lock> {
        let handle = Arc::clone(self.lock_map().entry(key.clone()).or_default());
        #[cfg(any(test, feature = "test-support"))]
        self.line_joined.notify_waiters();
        KeyHandle {
            handles: self,
            key,
            handle: Some(handle),
        }
    }

    /// How many handles on `key`'s lock its holders and its waiters keep, beside the map's own; 0
    /// when no one holds or waits on it.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn handle_count(&self, key: &Key) -> usize {
        self.lock_map()
            .get(key)
            .map_or(0, |handle| Arc::strong_count(handle) - 1)
    }

    /// Waits until `key`'s lock holds more handles than `handles`, as once another caller joins its
    /// line; woken by each caller that joins a line, never by a timer.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) async fn wait_for_handles_past(&self, key: &Key, handles: usize) {
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

    /// How many keys have a lock in the map.
    #[cfg(test)]
    pub(super) fn key_count(&self) -> usize {
        self.lock_map().len()
    }

    fn lock_map(&self) -> MutexGuard<'_, HashMap<Key, Arc<Lock>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.locks)
    }
}

/// One caller's handle on a key's lock, from joining its line to the end of its hold; a hold
/// declares its guard before it, so the guard drops first.
pub(super) struct KeyHandle<'handles, Key: Eq + Hash + Clone, Lock> {
    handles: &'handles KeyHandles<Key, Lock>,
    key: Key,
    // Taken only by the drop, which gives it back under the map's lock.
    handle: Option<Arc<Lock>>,
}

impl<Key: Eq + Hash + Clone, Lock> KeyHandle<'_, Key, Lock> {
    /// The key this handle is on.
    pub(super) fn key(&self) -> &Key {
        &self.key
    }

    /// The key's lock.
    pub(super) fn key_lock(&self) -> Arc<Lock> {
        Arc::clone(
            self.handle
                .as_ref()
                .expect("the handle is kept until its drop"),
        )
    }
}

impl<Key: Eq + Hash + Clone, Lock> Drop for KeyHandle<'_, Key, Lock> {
    fn drop(&mut self) {
        let mut locks = lock(&self.handles.locks);
        drop(self.handle.take());
        // A waiter or a new holder keeps its own handle, taken under the map's lock.
        if locks
            .get(&self.key)
            .is_some_and(|handle| Arc::strong_count(handle) == 1)
        {
            locks.remove(&self.key);
        }
    }
}

//! The keyed store both readings keep their latest reading and its subscribers in.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_ipc::stream::latest_value::{
    LatestValueOutlet, LatestValueOutletId, LatestValueOutlets,
};
use sidekicks_std::mutex_lock::lock;

/// The latest reading under each key and the subscribers following it. A publish replaces the
/// held reading and hands it to every subscriber, each of which keeps only the newest; a release
/// drops a key's reading and ends its subscribers' streams.
pub(crate) struct LatestReadings<Key, Reading> {
    held: Mutex<HeldReadings<Key, Reading>>,
}

// The readings held by key, each stamped so a detach from a released one never reaches the
// reading held after it under the same key.
struct HeldReadings<Key, Reading> {
    next_generation: u64,
    by_key: HashMap<Key, HeldReading<Reading>>,
}

// One key's latest reading and subscribers; kept while it holds either.
struct HeldReading<Reading> {
    generation: u64,
    latest: Option<Reading>,
    readers: LatestValueOutlets<Reading>,
}

impl<Key, Reading> Default for LatestReadings<Key, Reading> {
    fn default() -> Self {
        Self {
            held: Mutex::new(HeldReadings {
                next_generation: 0,
                by_key: HashMap::new(),
            }),
        }
    }
}

impl<Key: Copy + Eq + Hash + Send + 'static, Reading: Clone + Send + 'static>
    LatestReadings<Key, Reading>
{
    /// Holds `reading` as `key`'s latest, in place of the one held, and hands it to every
    /// subscriber of `key`.
    pub(crate) fn publish(&self, key: Key, reading: Reading) {
        let mut held = self.lock();
        let held_reading = held.held_reading(key);
        held_reading.readers.send(&reading);
        held_reading.latest = Some(reading);
    }

    /// Sends `key`'s held reading through `outlet` at once, if there is one, then each later
    /// one, until the answered detach runs or `key` is released.
    pub(crate) fn follow(
        self: &Arc<Self>,
        key: Key,
        outlet: LatestValueOutlet<Reading>,
    ) -> impl FnOnce() + Send + use<Key, Reading> {
        let (generation, id) = {
            let mut held = self.lock();
            let held_reading = held.held_reading(key);
            if let Some(latest) = &held_reading.latest {
                outlet.send(latest.clone());
            }
            (held_reading.generation, held_reading.readers.attach(outlet))
        };
        let readings = Arc::downgrade(self);
        move || {
            if let Some(readings) = readings.upgrade() {
                readings.detach(key, generation, id);
            }
        }
    }

    /// Drops `key`'s reading and its subscribers, whose streams then finish.
    pub(crate) fn release(&self, key: &Key) {
        let released = self.lock().by_key.remove(key);
        // Outside the lock: each dropped outlet wakes its feed.
        drop(released);
    }

    /// Drops the reading and subscribers of every key `is_released` picks.
    pub(crate) fn release_where(&self, is_released: impl Fn(&Key) -> bool) {
        let released: Vec<HeldReading<Reading>> = {
            let mut held = self.lock();
            let keys: Vec<Key> = held
                .by_key
                .keys()
                .copied()
                .filter(|key| is_released(key))
                .collect();
            keys.iter()
                .filter_map(|key| held.by_key.remove(key))
                .collect()
        };
        drop(released);
    }

    // Removes the subscriber `id` of `key`'s held reading stamped `generation`, and the entry
    // once it holds neither a reading nor a subscriber.
    fn detach(&self, key: Key, generation: u64, id: LatestValueOutletId) {
        let mut held = self.lock();
        let Some(held_reading) = held.by_key.get_mut(&key) else {
            return;
        };
        if held_reading.generation != generation {
            return;
        }
        held_reading.readers.detach(id);
        if held_reading.latest.is_none() && held_reading.readers.is_empty() {
            held.by_key.remove(&key);
        }
    }

    fn lock(&self) -> MutexGuard<'_, HeldReadings<Key, Reading>> {
        // Every change keeps the held readings whole.
        lock(&self.held)
    }
}

impl<Key: Eq + Hash, Reading> HeldReadings<Key, Reading> {
    // `key`'s held reading, a new empty one stamped with the next generation when none is held.
    fn held_reading(&mut self, key: Key) -> &mut HeldReading<Reading> {
        let next_generation = &mut self.next_generation;
        self.by_key.entry(key).or_insert_with(|| {
            let generation = *next_generation;
            *next_generation += 1;
            HeldReading {
                generation,
                latest: None,
                readers: LatestValueOutlets::default(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_ipc::stream::feed::{CreditGate, Feed as _};
    use sidekicks_ipc::stream::latest_value::LatestValueFeed;

    use super::*;

    #[tokio::test]
    async fn a_subscriber_behind_two_publishes_reads_only_the_newest() {
        let readings: Arc<LatestReadings<u8, u32>> = Arc::new(LatestReadings::default());
        let gate = CreditGate::with_credit(1);
        readings.publish(1, 10);
        let follower = Arc::clone(&readings);
        let mut feed =
            LatestValueFeed::open(|outlet| async move { Ok(follower.follow(1, outlet)) })
                .await
                .expect("the follow opens");
        // A subscriber that joins after a publish reads the held reading at once.
        assert_eq!(feed.next(&gate).await.expect("never fails"), Some(10));

        readings.publish(1, 11);
        readings.publish(1, 12);
        assert_eq!(feed.next(&gate).await.expect("never fails"), Some(12));

        // A release ends the stream rather than leaving it waiting.
        readings.release(&1);
        assert_eq!(feed.next(&gate).await.expect("never fails"), None);

        // The ended subscriber's detach never reaches a subscriber of the key's next held reading.
        let follower = Arc::clone(&readings);
        let mut next_feed =
            LatestValueFeed::open(|outlet| async move { Ok(follower.follow(1, outlet)) })
                .await
                .expect("the follow opens");
        drop(feed);
        readings.publish(1, 13);
        assert_eq!(next_feed.next(&gate).await.expect("never fails"), Some(13));
    }
}

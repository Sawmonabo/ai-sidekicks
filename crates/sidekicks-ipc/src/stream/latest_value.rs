//! The newest-value feeds: a subscription whose every value is whole and replaces the one before
//! (a list sent entire, a card's whole state), and its keyed form, where a value replaces only the
//! one before it under the same key. While the subscription's gate is closed only the newest value
//! waits, one per key in the keyed form, so a slow reader costs at most one value per key and
//! always ends on the newest.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

use crate::registry::HandlerError;
use crate::stream::feed::{Feed, SendGate};

/// The values a source sent that its feed has not read yet.
trait PendingValues {
    /// One value the feed reads.
    type Emission;

    /// The next value to read, removed from what waits; `None` when nothing waits.
    fn take_next(&mut self) -> Option<Self::Emission>;
}

/// The single form waits as one newest value.
impl<Emission> PendingValues for Option<Emission> {
    type Emission = Emission;

    fn take_next(&mut self) -> Option<Emission> {
        self.take()
    }
}

/// The keyed form's waiting values: each key's newest value not yet read, and the keys in the
/// order they first waited. A key is in the order once however often it is sent before it is
/// read, so what waits is bounded by the number of keys.
struct KeyedValues<Key, Emission> {
    newest: HashMap<Key, Emission>,
    order: VecDeque<Key>,
}

impl<Key, Emission> Default for KeyedValues<Key, Emission> {
    fn default() -> Self {
        Self {
            newest: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

impl<Key: Eq + Hash + Clone, Emission> KeyedValues<Key, Emission> {
    fn insert(&mut self, key: Key, value: Emission) {
        match self.newest.entry(key) {
            // A key already waiting keeps its place and takes the newer value.
            Entry::Occupied(mut waiting) => {
                waiting.insert(value);
            }
            Entry::Vacant(vacant) => {
                self.order.push_back(vacant.key().clone());
                vacant.insert(value);
            }
        }
    }
}

impl<Key: Eq + Hash + Clone, Emission> PendingValues for KeyedValues<Key, Emission> {
    type Emission = Emission;

    fn take_next(&mut self) -> Option<Emission> {
        let key = self.order.pop_front()?;
        Some(
            self.newest
                .remove(&key)
                .expect("every key in the order waits with its value"),
        )
    }
}

/// What waits between a source and its feed.
struct WaitingValues<Pending> {
    /// The values not yet read; a later send replaces the one it supersedes.
    pending: Pending,
    /// Why the source stopped following, answered by the feed's next read.
    failure: Option<HandlerError>,
    /// The source dropped its outlet or failed, so nothing more is sent.
    has_source_stopped: bool,
    /// The feed dropped, so nothing sent is read.
    is_feed_gone: bool,
}

/// The values a source sent, and the signal that wakes the feed on each send.
struct SourceValues<Pending> {
    waiting: Mutex<WaitingValues<Pending>>,
    sent: Notify,
}

impl<Pending> SourceValues<Pending> {
    fn lock(&self) -> MutexGuard<'_, WaitingValues<Pending>> {
        lock(&self.waiting)
    }
}

/// The source's end of a feed: every change does nothing once the feed dropped or the source
/// stopped, and dropping it stops the source, so the stream ends once what waits is read.
struct SourceEnd<Pending> {
    values: Arc<SourceValues<Pending>>,
}

impl<Pending> SourceEnd<Pending> {
    fn update(&self, change: impl FnOnce(&mut WaitingValues<Pending>)) {
        {
            let mut waiting = self.values.lock();
            if waiting.is_feed_gone || waiting.has_source_stopped {
                return;
            }
            change(&mut waiting);
        }
        self.values.sent.notify_one();
    }
}

impl<Pending: Default> SourceEnd<Pending> {
    /// Stops the stream with `failure`, which the feed's next read answers; what waits is dropped.
    fn fail(&self, failure: HandlerError) {
        self.update(|waiting| {
            waiting.pending = Pending::default();
            waiting.failure = Some(failure);
            waiting.has_source_stopped = true;
        });
    }
}

impl<Pending> Drop for SourceEnd<Pending> {
    fn drop(&mut self) {
        self.update(|waiting| waiting.has_source_stopped = true);
    }
}

/// The feed's end: it reads what the source sent, and dropping it marks the feed gone, drops what
/// waits and runs the source's detach.
struct ReaderEnd<Pending: Default, Detach: FnOnce() + Send> {
    values: Arc<SourceValues<Pending>>,
    /// What stops the source following; `None` only while `open` waits for it.
    detach: Option<Detach>,
}

impl<Pending: Default, Detach: FnOnce() + Send> ReaderEnd<Pending, Detach> {
    /// Opens the reader: `follow` starts the source with its end and answers the detach; a follow
    /// that fails opens nothing and answers its failure.
    async fn open<Follow, Following>(follow: Follow) -> Result<Self, HandlerError>
    where
        Follow: FnOnce(SourceEnd<Pending>) -> Following,
        Following: Future<Output = Result<Detach, HandlerError>>,
    {
        let values = Arc::new(SourceValues {
            waiting: Mutex::new(WaitingValues {
                pending: Pending::default(),
                failure: None,
                has_source_stopped: false,
                is_feed_gone: false,
            }),
            sent: Notify::new(),
        });
        // Held before the follow, so a failed follow drops it and the source's changes do nothing.
        let mut reader = Self {
            values: Arc::clone(&values),
            detach: None,
        };
        reader.detach = Some(follow(SourceEnd { values }).await?);
        Ok(reader)
    }
}

impl<Pending: PendingValues + Default, Detach: FnOnce() + Send> ReaderEnd<Pending, Detach> {
    /// The next value, read once `gate` lets a frame through when there is one: the source's
    /// failure as the error, `None` once the source stopped and nothing waits, else the next
    /// waiting value, awaiting a send while nothing waits.
    async fn read(
        &mut self,
        gate: Option<&dyn SendGate>,
    ) -> Result<Option<Pending::Emission>, HandlerError> {
        loop {
            if let Some(gate) = gate
                && gate.ready().await.is_err()
            {
                return Ok(None);
            }
            {
                let mut waiting = self.values.lock();
                if let Some(failure) = waiting.failure.take() {
                    return Err(failure);
                }
                if let Some(value) = waiting.pending.take_next() {
                    return Ok(Some(value));
                }
                if waiting.has_source_stopped {
                    return Ok(None);
                }
            }
            // A send between the check and this wait leaves a permit, so none is missed.
            self.values.sent.notified().await;
        }
    }
}

impl<Pending: Default, Detach: FnOnce() + Send> Drop for ReaderEnd<Pending, Detach> {
    fn drop(&mut self) {
        // Marked first, so a send the detach sets off is ignored.
        {
            let mut waiting = self.values.lock();
            waiting.is_feed_gone = true;
            waiting.pending = Pending::default();
        }
        if let Some(detach) = self.detach.take() {
            detach();
        }
    }
}

/// What a source hands its feed values through. Every call does nothing once the feed dropped or
/// the source failed; dropping it ends the stream once the waiting value is read.
pub struct LatestValueOutlet<Emission> {
    source: SourceEnd<Option<Emission>>,
}

impl<Emission> LatestValueOutlet<Emission> {
    /// Sends a whole value, replacing the one still waiting.
    pub fn send(&self, value: Emission) {
        self.source.update(|waiting| waiting.pending = Some(value));
    }

    /// Stops the stream for a source that can no longer follow: the feed's next read answers
    /// `failure`, so the subscription ends refused, and the waiting value is dropped.
    pub fn fail(&self, failure: HandlerError) {
        self.source.fail(failure);
    }
}

/// What a keyed source hands its feed values through: each key keeps only its newest value until
/// the feed reads it. Every call does nothing once the feed dropped or the source failed; dropping
/// it ends the stream once the waiting values are read.
pub struct KeyedLatestValueOutlet<Key, Emission> {
    source: SourceEnd<KeyedValues<Key, Emission>>,
}

impl<Key: Eq + Hash + Clone, Emission> KeyedLatestValueOutlet<Key, Emission> {
    /// Sends `key`'s whole value, replacing the one still waiting for that key; a key not waiting
    /// is read after every key already waiting.
    pub fn send(&self, key: Key, value: Emission) {
        self.source
            .update(|waiting| waiting.pending.insert(key, value));
    }

    /// Stops the stream for a source that can no longer follow: the feed's next read answers
    /// `failure`, so the subscription ends refused, and every waiting value is dropped.
    pub fn fail(&self, failure: HandlerError) {
        self.source.fail(failure);
    }
}

/// One reader's place among a source's readers, which its detach removes it by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LatestValueOutletId(u64);

/// Outlets kept under the ids attaching them answered.
struct AttachedOutlets<Outlet> {
    next_id: u64,
    outlets: Vec<(LatestValueOutletId, Outlet)>,
}

impl<Outlet> Default for AttachedOutlets<Outlet> {
    fn default() -> Self {
        Self {
            next_id: 0,
            outlets: Vec::new(),
        }
    }
}

impl<Outlet> AttachedOutlets<Outlet> {
    fn attach(&mut self, outlet: Outlet) -> LatestValueOutletId {
        let id = LatestValueOutletId(self.next_id);
        self.next_id += 1;
        self.outlets.push((id, outlet));
        id
    }

    fn detach(&mut self, id: LatestValueOutletId) {
        self.outlets.retain(|(outlet_id, _)| *outlet_id != id);
    }
}

/// The outlets of every reader of one value, each kept until its detach removes it by the id
/// attaching it answered.
pub struct LatestValueOutlets<Emission> {
    attached: AttachedOutlets<LatestValueOutlet<Emission>>,
}

impl<Emission> Default for LatestValueOutlets<Emission> {
    fn default() -> Self {
        Self {
            attached: AttachedOutlets::default(),
        }
    }
}

impl<Emission> LatestValueOutlets<Emission> {
    /// Keeps `outlet` and answers the id its detach removes it by.
    pub fn attach(&mut self, outlet: LatestValueOutlet<Emission>) -> LatestValueOutletId {
        self.attached.attach(outlet)
    }

    /// Drops the outlet `id` names; an id already removed changes nothing.
    pub fn detach(&mut self, id: LatestValueOutletId) {
        self.attached.detach(id);
    }

    /// Whether no reader is attached.
    pub fn is_empty(&self) -> bool {
        self.attached.outlets.is_empty()
    }

    /// How many readers are attached.
    pub fn len(&self) -> usize {
        self.attached.outlets.len()
    }

    /// The ids of every attached outlet.
    pub fn ids(&self) -> impl Iterator<Item = LatestValueOutletId> + '_ {
        self.attached.outlets.iter().map(|(id, _)| *id)
    }
}

impl<Emission: Clone> LatestValueOutlets<Emission> {
    /// Sends `value` whole through every attached outlet.
    pub fn send(&self, value: &Emission) {
        for (_, outlet) in &self.attached.outlets {
            outlet.send(value.clone());
        }
    }

    /// Sends `value` whole through the outlet `id` names; an id not attached sends nothing.
    pub fn send_to(&self, id: LatestValueOutletId, value: &Emission) {
        if let Some((_, outlet)) = self
            .attached
            .outlets
            .iter()
            .find(|(outlet_id, _)| *outlet_id == id)
        {
            outlet.send(value.clone());
        }
    }
}

/// The keyed outlets of every reader of one keyed source, each kept until its detach removes it by
/// the id attaching it answered.
pub struct KeyedLatestValueOutlets<Key, Emission> {
    attached: AttachedOutlets<KeyedLatestValueOutlet<Key, Emission>>,
}

impl<Key, Emission> Default for KeyedLatestValueOutlets<Key, Emission> {
    fn default() -> Self {
        Self {
            attached: AttachedOutlets::default(),
        }
    }
}

impl<Key, Emission> KeyedLatestValueOutlets<Key, Emission> {
    /// Keeps `outlet` and answers the id its detach removes it by.
    pub fn attach(&mut self, outlet: KeyedLatestValueOutlet<Key, Emission>) -> LatestValueOutletId {
        self.attached.attach(outlet)
    }

    /// Drops the outlet `id` names; an id already removed changes nothing.
    pub fn detach(&mut self, id: LatestValueOutletId) {
        self.attached.detach(id);
    }
}

impl<Key: Eq + Hash + Clone, Emission: Clone> KeyedLatestValueOutlets<Key, Emission> {
    /// Sends `key`'s whole `value` through every attached outlet.
    pub fn send(&self, key: &Key, value: &Emission) {
        for (_, outlet) in &self.attached.outlets {
            outlet.send(key.clone(), value.clone());
        }
    }
}

/// A subscription's newest-value feed: it reads only once its gate lets a frame through, and then
/// the newest value sent, so the reader ends on the newest value; it finishes once the source
/// dropped its outlet and nothing waits. Dropping it runs the source's detach.
pub struct LatestValueFeed<Emission, Detach: FnOnce() + Send> {
    reader: ReaderEnd<Option<Emission>, Detach>,
}

impl<Emission, Detach: FnOnce() + Send> LatestValueFeed<Emission, Detach> {
    /// Opens a feed: `follow` starts following the source, which may send at once through the
    /// outlet, and answers the detach the feed runs when it drops. The detach runs synchronously,
    /// so a source whose release must await spawns that release from it. A follow that fails opens
    /// nothing, and its failure is the subscribe call's.
    pub async fn open<Follow, Following>(follow: Follow) -> Result<Self, HandlerError>
    where
        Follow: FnOnce(LatestValueOutlet<Emission>) -> Following,
        Following: Future<Output = Result<Detach, HandlerError>>,
    {
        let reader = ReaderEnd::open(|source| follow(LatestValueOutlet { source })).await?;
        Ok(Self { reader })
    }
}

impl<Emission: Send, Detach: FnOnce() + Send> Feed for LatestValueFeed<Emission, Detach> {
    type Emission = Emission;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<Emission>, HandlerError>> {
        self.reader.read(Some(gate)).boxed()
    }
}

/// A subscription's keyed newest-value feed: each read takes the key that waited longest, with
/// its newest value, so a slow reader ends on every key's newest value; it finishes once the source
/// dropped its outlet and nothing waits. Dropping it runs the source's detach.
pub struct KeyedLatestValueFeed<Key, Emission, Detach: FnOnce() + Send> {
    reader: ReaderEnd<KeyedValues<Key, Emission>, Detach>,
}

impl<Key, Emission, Detach: FnOnce() + Send> KeyedLatestValueFeed<Key, Emission, Detach> {
    /// Opens a feed: `follow` starts following the source, which may send at once through the
    /// outlet, and answers the detach the feed runs when it drops. The detach runs synchronously,
    /// so a source whose release must await spawns that release from it. A follow that fails opens
    /// nothing, and its failure is the subscribe call's.
    pub async fn open<Follow, Following>(follow: Follow) -> Result<Self, HandlerError>
    where
        Follow: FnOnce(KeyedLatestValueOutlet<Key, Emission>) -> Following,
        Following: Future<Output = Result<Detach, HandlerError>>,
    {
        let reader = ReaderEnd::open(|source| follow(KeyedLatestValueOutlet { source })).await?;
        Ok(Self { reader })
    }
}

impl<Key: Eq + Hash + Clone, Emission, Detach: FnOnce() + Send>
    KeyedLatestValueFeed<Key, Emission, Detach>
{
    /// The next waiting key's newest value with no send gate, for a reader inside the daemon:
    /// `Ok(None)` once the source stopped and nothing waits, and the source's failure as the error.
    pub async fn recv(&mut self) -> Result<Option<Emission>, HandlerError> {
        self.reader.read(None).await
    }
}

impl<Key: Eq + Hash + Clone + Send, Emission: Send, Detach: FnOnce() + Send> Feed
    for KeyedLatestValueFeed<Key, Emission, Detach>
{
    type Emission = Emission;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<Emission>, HandlerError>> {
        self.reader.read(Some(gate)).boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::stream::feed::CreditGate;

    #[tokio::test]
    async fn a_burst_sent_while_the_gate_is_closed_is_read_as_the_newest_alone() {
        let detached = Arc::new(AtomicBool::new(false));
        let mut outlet = None;
        let source_detached = Arc::clone(&detached);
        let mut feed = LatestValueFeed::open(|source_outlet| {
            outlet = Some(source_outlet);
            async move { Ok(move || source_detached.store(true, Ordering::SeqCst)) }
        })
        .await
        .expect("the follow succeeds");
        let outlet = outlet.expect("the follow kept the outlet");

        let gate = Arc::new(CreditGate::with_credit(0));
        let reader_gate = Arc::clone(&gate);
        let reader = tokio::spawn(async move {
            let first = feed.next(&*reader_gate).await;
            (first, feed)
        });
        for projects in 1..=5_u32 {
            outlet.send(projects);
        }
        gate.credit.add_permits(1);
        let (first, mut feed) = reader.await.expect("the reader ran");
        assert_eq!(first.expect("the source never fails"), Some(5));

        // Nothing older waits behind the newest: once the source stops, the stream ends.
        drop(outlet);
        assert_eq!(
            feed.next(&*gate).await.expect("the source never fails"),
            None
        );
        drop(feed);
        assert!(detached.load(Ordering::SeqCst), "the source was detached");
    }

    // One slot shared by every key would let one key's value evict the other's.
    #[tokio::test]
    async fn keys_sent_while_the_gate_is_closed_are_read_once_each_as_their_newest_in_order() {
        let mut outlet = None;
        let mut feed = KeyedLatestValueFeed::open(|source_outlet| {
            outlet = Some(source_outlet);
            async move { Ok(|| {}) }
        })
        .await
        .expect("the follow succeeds");
        let outlet = outlet.expect("the follow kept the outlet");

        let gate = Arc::new(CreditGate::with_credit(0));
        let reader_gate = Arc::clone(&gate);
        let reader = tokio::spawn(async move {
            let first = feed.next(&*reader_gate).await;
            (first, feed)
        });
        outlet.send("alpha", ("alpha", 1_u32));
        outlet.send("beta", ("beta", 1));
        outlet.send("alpha", ("alpha", 2));
        outlet.send("beta", ("beta", 2));
        outlet.send("alpha", ("alpha", 3));
        gate.credit.add_permits(1);
        let (first, mut feed) = reader.await.expect("the reader ran");
        assert_eq!(first.expect("the source never fails"), Some(("alpha", 3)));
        assert_eq!(
            feed.next(&*gate).await.expect("the source never fails"),
            Some(("beta", 2))
        );

        // Each key was read once: once the source stops, the stream ends.
        drop(outlet);
        assert_eq!(
            feed.next(&*gate).await.expect("the source never fails"),
            None
        );
    }
}

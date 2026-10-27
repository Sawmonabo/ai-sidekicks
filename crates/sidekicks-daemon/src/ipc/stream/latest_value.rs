//! The newest-value feed: a subscription whose every value is whole and replaces the one before
//! (a list sent entire, a card's whole state). While the subscription's gate is closed only the
//! newest value waits, so a slow reader costs at most one value and always ends on the newest.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio::sync::Notify;

use crate::registry::HandlerError;
use crate::stream::feed::{Feed, SendGate};
use sidekicks_std::mutex_lock::lock;

/// What waits between a source and its feed.
struct WaitingValue<Emission> {
    /// The newest value not yet read; a later send replaces it.
    newest: Option<Emission>,
    /// Why the source stopped following, answered by the feed's next read.
    failure: Option<HandlerError>,
    /// The source dropped its outlet or failed, so nothing more is sent.
    has_source_stopped: bool,
    /// The feed dropped, so nothing sent is read.
    is_feed_gone: bool,
}

/// The value a source sent, and the signal that wakes the feed on each send.
struct SourceValue<Emission> {
    waiting: Mutex<WaitingValue<Emission>>,
    sent: Notify,
}

impl<Emission> SourceValue<Emission> {
    fn lock(&self) -> MutexGuard<'_, WaitingValue<Emission>> {
        lock(&self.waiting)
    }
}

/// What a source hands its feed values through. Every call does nothing once the feed dropped or
/// the source failed; dropping it ends the stream once the waiting value is read.
pub(crate) struct LatestValueOutlet<Emission> {
    value: Arc<SourceValue<Emission>>,
}

impl<Emission> LatestValueOutlet<Emission> {
    /// Sends a whole value, replacing the one still waiting.
    pub(crate) fn send(&self, value: Emission) {
        self.update(|waiting| waiting.newest = Some(value));
    }

    /// Stops the stream for a source that can no longer follow: the feed's next read answers
    /// `failure`, so the subscription ends refused, and the waiting value is dropped.
    pub(crate) fn fail(&self, failure: HandlerError) {
        self.update(|waiting| {
            waiting.newest = None;
            waiting.failure = Some(failure);
            waiting.has_source_stopped = true;
        });
    }

    fn update(&self, change: impl FnOnce(&mut WaitingValue<Emission>)) {
        {
            let mut waiting = self.value.lock();
            if waiting.is_feed_gone || waiting.has_source_stopped {
                return;
            }
            change(&mut waiting);
        }
        self.value.sent.notify_one();
    }
}

impl<Emission> Drop for LatestValueOutlet<Emission> {
    fn drop(&mut self) {
        self.update(|waiting| waiting.has_source_stopped = true);
    }
}

/// One reader's place among a value's readers, which its detach removes it by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LatestValueOutletId(u64);

/// The outlets of every reader of one value, each kept until its detach removes it by the id
/// attaching it answered.
pub(crate) struct LatestValueOutlets<Emission> {
    next_id: u64,
    outlets: Vec<(LatestValueOutletId, LatestValueOutlet<Emission>)>,
}

impl<Emission> Default for LatestValueOutlets<Emission> {
    fn default() -> Self {
        Self {
            next_id: 0,
            outlets: Vec::new(),
        }
    }
}

impl<Emission> LatestValueOutlets<Emission> {
    /// Keeps `outlet` and answers the id its detach removes it by.
    pub(crate) fn attach(&mut self, outlet: LatestValueOutlet<Emission>) -> LatestValueOutletId {
        let id = LatestValueOutletId(self.next_id);
        self.next_id += 1;
        self.outlets.push((id, outlet));
        id
    }

    /// Drops the outlet `id` names; an id already removed changes nothing.
    pub(crate) fn detach(&mut self, id: LatestValueOutletId) {
        self.outlets.retain(|(outlet_id, _)| *outlet_id != id);
    }

    /// Whether no reader is attached.
    pub(crate) fn is_empty(&self) -> bool {
        self.outlets.is_empty()
    }

    /// How many readers are attached.
    pub(crate) fn len(&self) -> usize {
        self.outlets.len()
    }

    /// The ids of every attached outlet.
    pub(crate) fn ids(&self) -> impl Iterator<Item = LatestValueOutletId> + '_ {
        self.outlets.iter().map(|(id, _)| *id)
    }
}

impl<Emission: Clone> LatestValueOutlets<Emission> {
    /// Sends `value` whole through every attached outlet.
    pub(crate) fn send(&self, value: &Emission) {
        for (_, outlet) in &self.outlets {
            outlet.send(value.clone());
        }
    }

    /// Sends `value` whole through the outlet `id` names; an id not attached sends nothing.
    pub(crate) fn send_to(&self, id: LatestValueOutletId, value: &Emission) {
        if let Some((_, outlet)) = self.outlets.iter().find(|(outlet_id, _)| *outlet_id == id) {
            outlet.send(value.clone());
        }
    }
}

/// A subscription's newest-value feed: it reads only once its gate lets a frame through, and then
/// the newest value sent, so the reader ends on the newest value; it finishes once the source
/// dropped its outlet and nothing waits. Dropping it runs the source's detach.
pub(crate) struct LatestValueFeed<Emission, Detach: FnOnce() + Send> {
    value: Arc<SourceValue<Emission>>,
    /// What stops the source following; `None` only while `open` waits for it.
    detach: Option<Detach>,
}

impl<Emission, Detach: FnOnce() + Send> LatestValueFeed<Emission, Detach> {
    /// Opens a feed: `follow` starts following the source, which may send at once through the
    /// outlet, and answers the detach the feed runs when it drops. The detach runs synchronously,
    /// so a source whose release must await spawns that release from it. A follow that fails opens
    /// nothing, and its failure is the subscribe call's.
    pub(crate) async fn open<Follow, Following>(follow: Follow) -> Result<Self, HandlerError>
    where
        Follow: FnOnce(LatestValueOutlet<Emission>) -> Following,
        Following: Future<Output = Result<Detach, HandlerError>>,
    {
        let value = Arc::new(SourceValue {
            waiting: Mutex::new(WaitingValue {
                newest: None,
                failure: None,
                has_source_stopped: false,
                is_feed_gone: false,
            }),
            sent: Notify::new(),
        });
        // Held before the follow, so a failed follow drops it and the outlet's calls do nothing.
        let mut feed = Self {
            value: Arc::clone(&value),
            detach: None,
        };
        feed.detach = Some(follow(LatestValueOutlet { value }).await?);
        Ok(feed)
    }
}

impl<Emission: Send, Detach: FnOnce() + Send> Feed for LatestValueFeed<Emission, Detach> {
    type Emission = Emission;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<Emission>, HandlerError>> {
        async move {
            loop {
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                {
                    let mut waiting = self.value.lock();
                    if let Some(failure) = waiting.failure.take() {
                        return Err(failure);
                    }
                    if let Some(value) = waiting.newest.take() {
                        return Ok(Some(value));
                    }
                    if waiting.has_source_stopped {
                        return Ok(None);
                    }
                }
                // A send between the check and this wait leaves a permit, so none is missed.
                self.value.sent.notified().await;
            }
        }
        .boxed()
    }
}

impl<Emission, Detach: FnOnce() + Send> Drop for LatestValueFeed<Emission, Detach> {
    fn drop(&mut self) {
        // Marked first, so a send the detach sets off is ignored.
        {
            let mut waiting = self.value.lock();
            waiting.is_feed_gone = true;
            waiting.newest = None;
        }
        if let Some(detach) = self.detach.take() {
            detach();
        }
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
}

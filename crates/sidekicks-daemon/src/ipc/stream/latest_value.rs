//! The newest-value feed: a subscription whose states are whole, each replacing the one before (a
//! list sent entire, a card's whole state), beside events that are never replaced (a removal, a
//! schedule's `fired` or `skipped`). While the subscription's gate is closed the events wait in
//! order and only the newest state waits, so a slow reader costs at most one state beyond the
//! events it has not read, and always ends on the newest state.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio::sync::Notify;

use crate::ipc::registry::HandlerError;
use crate::ipc::stream::feed::{Feed, SendGate};

/// One value waiting to be read.
enum WaitingValue<Emission> {
    /// A whole state; a later state replaces it.
    State(Emission),
    /// An event; nothing replaces it.
    Event(Emission),
}

/// What waits between a source and its feed.
struct WaitingValues<Emission> {
    /// Events in the order sent, and at most one state, after every event sent before it.
    values: VecDeque<WaitingValue<Emission>>,
    /// Why the source stopped following, answered by the feed's next read.
    failure: Option<HandlerError>,
    /// The source dropped its outlet or failed, so nothing more is sent.
    has_source_stopped: bool,
    /// The feed dropped, so nothing sent is read.
    is_feed_gone: bool,
}

/// The values a source sent, and the signal that wakes the feed on each send.
struct SourceValues<Emission> {
    waiting: Mutex<WaitingValues<Emission>>,
    sent: Notify,
}

impl<Emission> SourceValues<Emission> {
    fn lock(&self) -> MutexGuard<'_, WaitingValues<Emission>> {
        self.waiting
            .lock()
            .expect("a panic ends the daemon, so no holder leaves the values poisoned")
    }
}

/// What a source hands its feed values through. Every call does nothing once the feed dropped or
/// the source failed; dropping it ends the stream once what waits is read.
pub(crate) struct LatestValueOutlet<Emission> {
    values: Arc<SourceValues<Emission>>,
}

impl<Emission> LatestValueOutlet<Emission> {
    /// Sends a whole state, replacing the state still waiting; it waits behind every event sent
    /// before it.
    pub(crate) fn send_state(&self, state: Emission) {
        self.update(|waiting| {
            let replaced = waiting
                .values
                .iter()
                .position(|value| matches!(value, WaitingValue::State(_)));
            if let Some(index) = replaced {
                waiting.values.remove(index);
            }
            waiting.values.push_back(WaitingValue::State(state));
        });
    }

    /// Sends an event, which waits in order and is never replaced.
    pub(crate) fn send_event(&self, event: Emission) {
        self.update(|waiting| waiting.values.push_back(WaitingValue::Event(event)));
    }

    /// Stops the stream for a source that can no longer follow: the feed's next read answers
    /// `failure`, so the subscription ends refused, and what waits is dropped.
    pub(crate) fn fail(&self, failure: HandlerError) {
        self.update(|waiting| {
            waiting.values.clear();
            waiting.failure = Some(failure);
            waiting.has_source_stopped = true;
        });
    }

    fn update(&self, change: impl FnOnce(&mut WaitingValues<Emission>)) {
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

impl<Emission> Drop for LatestValueOutlet<Emission> {
    fn drop(&mut self) {
        self.update(|waiting| waiting.has_source_stopped = true);
    }
}

/// A subscription's newest-value feed: it reads only once its gate lets a frame through, events
/// first in order, and finishes once the source dropped its outlet and nothing waits. Dropping it
/// runs the source's detach.
pub(crate) struct LatestValueFeed<Emission, Detach: FnOnce() + Send> {
    values: Arc<SourceValues<Emission>>,
    /// What stops the source following; `None` only while `open` waits for it.
    detach: Option<Detach>,
}

impl<Emission, Detach: FnOnce() + Send> LatestValueFeed<Emission, Detach> {
    /// Opens a feed: `follow` starts following the source, which may send at once through the
    /// outlet, and answers the detach the feed runs when it drops. A follow that fails opens
    /// nothing, and its failure is the subscribe call's.
    pub(crate) async fn open<Follow, Following>(follow: Follow) -> Result<Self, HandlerError>
    where
        Follow: FnOnce(LatestValueOutlet<Emission>) -> Following,
        Following: Future<Output = Result<Detach, HandlerError>>,
    {
        let values = Arc::new(SourceValues {
            waiting: Mutex::new(WaitingValues {
                values: VecDeque::new(),
                failure: None,
                has_source_stopped: false,
                is_feed_gone: false,
            }),
            sent: Notify::new(),
        });
        // Held before the follow, so a failed follow drops it and the outlet's calls do nothing.
        let mut feed = Self {
            values: Arc::clone(&values),
            detach: None,
        };
        feed.detach = Some(follow(LatestValueOutlet { values }).await?);
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
                    let mut waiting = self.values.lock();
                    if let Some(failure) = waiting.failure.take() {
                        return Err(failure);
                    }
                    match waiting.values.pop_front() {
                        Some(WaitingValue::State(value) | WaitingValue::Event(value)) => {
                            return Ok(Some(value));
                        }
                        None if waiting.has_source_stopped => return Ok(None),
                        None => {}
                    }
                }
                // A send between the check and this wait leaves a permit, so none is missed.
                self.values.sent.notified().await;
            }
        }
        .boxed()
    }
}

impl<Emission, Detach: FnOnce() + Send> Drop for LatestValueFeed<Emission, Detach> {
    fn drop(&mut self) {
        // Marked first, so a send the detach sets off is ignored.
        {
            let mut waiting = self.values.lock();
            waiting.is_feed_gone = true;
            waiting.values.clear();
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
    use crate::ipc::stream::feed::CreditGate;

    #[derive(Debug, PartialEq)]
    enum Change {
        Projects(u32),
        Removed(u32),
        Fired(u32),
        Skipped(u32),
    }

    #[tokio::test]
    async fn events_survive_a_burst_of_states_sent_while_the_gate_is_closed() {
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
            let mut read = Vec::new();
            for _ in 0..4 {
                let value = feed.next(&*reader_gate).await;
                read.push(
                    value
                        .expect("the source never fails")
                        .expect("the source still follows"),
                );
            }
            (read, feed)
        });

        outlet.send_state(Change::Projects(1));
        outlet.send_event(Change::Removed(7));
        outlet.send_state(Change::Projects(2));
        outlet.send_state(Change::Projects(3));
        outlet.send_event(Change::Fired(8));
        outlet.send_state(Change::Projects(4));
        outlet.send_event(Change::Skipped(9));
        outlet.send_state(Change::Projects(5));
        gate.credit.add_permits(1);

        let (read, feed) = reader.await.expect("the reader ran");
        assert_eq!(
            read,
            vec![
                Change::Removed(7),
                Change::Fired(8),
                Change::Skipped(9),
                Change::Projects(5),
            ]
        );
        drop(feed);
        assert!(detached.load(Ordering::SeqCst), "the source was detached");
    }
}

//! What a subscription's feed is pulled through: the send gate the gateway opens before each frame,
//! the stored record a change stream reads at its cursor, and the typed feed a subscribe handler
//! answers. A feed holds a place, never a queue, so a slow reader costs no more than the one
//! message its lane has begun.

use std::error::Error;

use futures::future::BoxFuture;
use tokio::sync::watch;

use crate::ipc::registry::HandlerError;

/// A subscription that closed (canceled, or its connection gone) while a feed waited to send.
#[derive(Debug, thiserror::Error)]
#[error("the subscription closed")]
pub(crate) struct SubscriptionClosed;

/// The send gate: one per subscription, implemented by the gateway. A feed awaits it before each
/// frame. It fails only after the subscription's token is canceled, so the gateway cancels the
/// token before it closes the gate, and a closed gate never reads as a finished stream.
pub(crate) trait SendGate: Send + Sync {
    /// Resolves once the subscription's lane has credit and the connection's writer has room,
    /// spending nothing, so a feed may await it more than once before one frame; fails with
    /// `SubscriptionClosed` once the subscription closed, after its token was canceled.
    fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>>;
}

/// A stored record a change stream reads from at its cursor; implemented by each store.
pub(crate) trait ChangeRecord: Send + Sync {
    /// The position a change stream resumes after.
    type Cursor: Clone + Send + Sync;
    /// One change, carrying the cursor that resumes after it.
    type Change: Send;
    /// Why a read failed.
    type Error: Error + Send + Sync + 'static;

    /// At most `max` changes after `cursor`, oldest first; empty when none is stored yet, and the
    /// record's error when the read failed. Its implementer runs its database read through
    /// `spawn_blocking`.
    fn read_after(
        &self,
        cursor: &Self::Cursor,
        max: usize,
    ) -> BoxFuture<'_, Result<Vec<Self::Change>, Self::Error>>;

    /// The cursor that resumes after `change`.
    fn cursor_of(change: &Self::Change) -> Self::Cursor;

    /// The change signal: a count of the changes appended to the record, which grows by one per
    /// change once that change is readable, so a reader can count the changes signaled since it
    /// last looked. The signal is gone once the record's sender is dropped.
    fn change_count(&self) -> watch::Receiver<u64>;
}

/// A subscription's typed emissions: what a subscribe handler answers.
pub(crate) trait Feed: Send {
    /// One value the stream carries.
    type Emission;

    /// The next emission, read only after `gate` resolved; `Ok(None)` when the stream finished or
    /// the gate reported the subscription closed, and a `HandlerError` when the feed's read failed.
    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<Self::Emission>, HandlerError>>;
}

/// A test gate open while its lane holds credit; it spends none, so one permit keeps it open.
#[cfg(test)]
pub(crate) struct CreditGate {
    /// The lane's credit; a closed semaphore is a closed subscription.
    pub(crate) credit: tokio::sync::Semaphore,
}

#[cfg(test)]
impl CreditGate {
    /// A gate holding `permits` of credit.
    pub(crate) fn with_credit(permits: usize) -> Self {
        Self {
            credit: tokio::sync::Semaphore::new(permits),
        }
    }
}

#[cfg(test)]
impl SendGate for CreditGate {
    fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>> {
        Box::pin(async move {
            match self.credit.acquire().await {
                Ok(_permit) => Ok(()),
                Err(_closed) => Err(SubscriptionClosed),
            }
        })
    }
}

//! The run engine's inbound dispatch as a driver reaches it: where each delivery is attributed to
//! its execution and written, routed or absorbed.

use std::error::Error;

use futures::future::BoxFuture;

use crate::run::delivery::{InboundDelivery, InboundOutcome};

/// Takes each delivery a driver hands over; the daemon's start registers the dispatch as it.
pub(crate) trait InboundDispatch: Send + Sync {
    /// Dispatches one delivery. It is attributed when the call is made, before the returned future
    /// is first polled, so calls for a binding are made in its delivery order; the caller never
    /// awaits it on the task that reads its provider's frames, since a piece of a run being
    /// continued waits for a frame behind it. Fails as the delivery was neither written, routed
    /// nor absorbed; a refusal for an ended run is an absorb.
    fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'dispatch, Result<InboundOutcome, Box<dyn Error + Send + Sync>>>;
}

//! The daemon's open subscriptions: each one's connection and cancellation, the
//! `$/subscription/cancel` call that tears one down from its own connection, and the frames the
//! gateway writes for one once its acknowledgment is on the wire. A subscription owns its feed;
//! what the feed follows is released in its `Drop`, which runs on every end, after the entry leaves
//! the table. The daemon's own end sends one `$/subscription/end` frame; a client's cancel and a
//! closed connection send none. The gateway drops a subscription only once its lane's last frame
//! is written, so a cancel's answer, which waits for that drop, follows the lane's close.

use std::collections::hash_map::Entry as MapEntry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::framing::incoming::MAX_OPEN_LANES;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{
    SubscriptionCancel, SubscriptionCancelRequest, SubscriptionCancelResponse,
    SubscriptionEndParams, SubscriptionId,
};
use tokio_util::sync::{CancellationToken, DropGuard};
use tracing::Instrument as _;

use crate::domain_error::DomainError;
use crate::jsonrpc_error_mapping::{CallFailure, json_rpc_error_of};
use crate::registry::{
    DispatchError, EncodedFeed, EncodedValue, HandlerContext, MethodRegistryBuilder,
    RegistrationError, TransportId,
};
use crate::stream::feed::SendGate;
use sidekicks_std::mutex_lock::lock;

/// What a feed's failure is reported to, beside the subscription it ends.
pub trait DispatchFailureWatch: Send + Sync {
    /// Learns of `failure`, the error a feed's read ended with.
    fn report_dispatch_failure(&self, failure: &DispatchError);
}

/// The daemon's open subscriptions, by id and by connection, shared by the cancel call, the
/// gateway's connection close and each open subscription.
pub struct Subscriptions {
    table: Mutex<SubscriptionTable>,
    /// What each feed's failure is told to.
    failures: Arc<dyn DispatchFailureWatch>,
}

/// The open subscriptions by id, and each connection's ids, so a close touches only its own.
#[derive(Default)]
struct SubscriptionTable {
    by_id: HashMap<SubscriptionId, OpenSubscription>,
    by_transport: HashMap<TransportId, HashSet<SubscriptionId>>,
}

/// One open subscription's entry: the connection that owns it, what ends it from outside, whether
/// it already ended on its own, and the signal its lane closed, which fires when the gateway drops
/// the subscription.
struct OpenSubscription {
    transport: TransportId,
    cancellation: CancellationToken,
    has_ended: bool,
    lane_closed: CancellationToken,
}

impl SubscriptionTable {
    /// Takes `subscription_id` out of both maps, dropping its connection's set once empty.
    fn remove(&mut self, subscription_id: &SubscriptionId) {
        let Some(open) = self.by_id.remove(subscription_id) else {
            return;
        };
        if let MapEntry::Occupied(mut ids) = self.by_transport.entry(open.transport) {
            ids.get_mut().remove(subscription_id);
            if ids.get().is_empty() {
                ids.remove();
            }
        }
    }
}

impl Subscriptions {
    /// An empty table, shared by everything that opens, cancels or closes a subscription, telling
    /// `failures` of each feed's failure.
    pub fn new(failures: Arc<dyn DispatchFailureWatch>) -> Arc<Self> {
        Arc::new(Self {
            table: Mutex::default(),
            failures,
        })
    }

    /// Registers `$/subscription/cancel`: a read, answered `{canceled: true}` only from the
    /// connection that owns the subscription, which then ends with no end frame. An unknown id
    /// and another connection's both answer `{canceled: false}` at once, so no connection can probe
    /// for another's. The owner's cancel answers only once the subscription's lane closed: `true`
    /// after the lane's abort, `false` after the end frame of a stream that ended first. Fails the
    /// start when the method is already registered.
    pub fn register_cancel(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
    ) -> Result<(), RegistrationError> {
        let subscriptions = Arc::clone(self);
        registry.register::<SubscriptionCancel, _>(
            move |params: SubscriptionCancelRequest, context: HandlerContext| {
                let outcome = subscriptions.cancel(&params.subscription_id, context.transport_id);
                async move {
                    let canceled = match outcome {
                        None => false,
                        Some((canceled, lane_closed)) => {
                            lane_closed.cancelled().await;
                            canceled
                        }
                    };
                    Ok(SubscriptionCancelResponse { canceled })
                }
                .boxed()
            },
        )
    }

    /// Whether `transport` holds fewer than `MAX_OPEN_LANES` open subscriptions, so a subscribe
    /// call on it may run; the gateway asks before it dispatches one, and `open` checks again for
    /// a subscribe that raced it.
    pub fn has_room(&self, transport: TransportId) -> bool {
        self.lock()
            .by_transport
            .get(&transport)
            .is_none_or(|ids| ids.len() < MAX_OPEN_LANES)
    }

    /// Opens the subscription a subscribe call to `method` answered, owned by `transport`, before
    /// the gateway writes its acknowledgment. Refused `connection.subscription.limitReached` with
    /// `{limit}` when the connection already holds `MAX_OPEN_LANES` open subscriptions; the feed is
    /// then dropped and nothing opens.
    pub fn open(
        self: &Arc<Self>,
        transport: TransportId,
        method: &'static str,
        subscription_id: SubscriptionId,
        feed: Box<dyn EncodedFeed>,
    ) -> Result<Subscription, DomainError> {
        let cancellation = CancellationToken::new();
        let lane_closed = CancellationToken::new();
        {
            let mut guard = self.lock();
            let table = &mut *guard;
            let ids = table.by_transport.entry(transport).or_default();
            if ids.len() >= MAX_OPEN_LANES {
                return Err(subscription_limit_reached());
            }
            ids.insert(subscription_id);
            table.by_id.insert(
                subscription_id,
                OpenSubscription {
                    transport,
                    cancellation: cancellation.clone(),
                    has_ended: false,
                    lane_closed: lane_closed.clone(),
                },
            );
        }
        Ok(Subscription {
            subscriptions: Arc::clone(self),
            method,
            id: subscription_id,
            cancellation,
            has_ended: false,
            feed,
            _lane_closed: lane_closed.drop_guard(),
        })
    }

    /// Ends every subscription of the closed connection `transport`, with no end frame: each is
    /// canceled, so its next frame ends it, and it leaves the table when the gateway drops it.
    pub fn cleanup_transport(&self, transport: TransportId) {
        let table = self.lock();
        let Some(ids) = table.by_transport.get(&transport) else {
            return;
        };
        for open in ids.iter().filter_map(|id| table.by_id.get(id)) {
            open.cancellation.cancel();
        }
    }

    /// A client's cancel from `transport`: `None` when it owns no subscription `subscription_id`;
    /// otherwise its answer and the signal its lane closed, which the answer waits for. The answer
    /// is true when the subscription had neither ended nor been canceled, which cancels it; it
    /// leaves the table when the gateway drops it.
    fn cancel(
        &self,
        subscription_id: &SubscriptionId,
        transport: TransportId,
    ) -> Option<(bool, CancellationToken)> {
        let table = self.lock();
        let open = table
            .by_id
            .get(subscription_id)
            .filter(|open| open.transport == transport)?;
        let canceled = !open.has_ended && !open.cancellation.is_cancelled();
        if canceled {
            open.cancellation.cancel();
        }
        Some((canceled, open.lane_closed.clone()))
    }

    /// Marks `subscription_id` ended on its own, unless a cancel came first; answers whether it
    /// did, so the end frame goes out only when no cancel won.
    fn mark_ended(&self, subscription_id: &SubscriptionId) -> bool {
        let mut table = self.lock();
        let Some(open) = table.by_id.get_mut(subscription_id) else {
            return false;
        };
        if open.cancellation.is_cancelled() {
            return false;
        }
        open.has_ended = true;
        true
    }

    fn lock(&self) -> MutexGuard<'_, SubscriptionTable> {
        lock(&self.table)
    }
}

/// The refusal of a subscribe call on a connection that holds `MAX_OPEN_LANES` subscriptions,
/// which the gateway also answers when `has_room` says no.
pub fn subscription_limit_reached() -> DomainError {
    DomainError::new(
        "the connection holds as many subscriptions as it may open",
        RefusalCode::ConnectionSubscriptionLimitReached,
    )
    .with_detail(json!({ "limit": MAX_OPEN_LANES }))
}

/// One frame of a subscription's lane.
pub enum SubscriptionFrame {
    /// One value, which the gateway sends as `$/subscription/notify` under the subscription's id.
    Notify(EncodedValue),
    /// The daemon's end of the stream, sent as `$/subscription/end`; nothing follows it.
    End(SubscriptionEndParams),
}

/// One open subscription, which the gateway drives only once the acknowledgment's END chunk is
/// written. Dropping it takes it out of the table, then drops its feed, then signals its lane
/// closed to a cancel waiting on it.
pub struct Subscription {
    subscriptions: Arc<Subscriptions>,
    /// The subscribe method's wire name, which the subscription's log lines carry.
    method: &'static str,
    id: SubscriptionId,
    cancellation: CancellationToken,
    /// Set once the subscription ended, so no frame follows its end.
    has_ended: bool,
    feed: Box<dyn EncodedFeed>,
    /// Signals the lane closed when the subscription drops, after its feed.
    _lane_closed: DropGuard,
}

impl Subscription {
    /// The id the subscription's frames are routed by.
    pub fn subscription_id(&self) -> &SubscriptionId {
        &self.id
    }

    /// The next frame once `gate` lets one through: a value, or the end frame (`completed` when
    /// the feed finished, `refused` with the mapped error when its read failed or an emission broke
    /// its rule, logged once by the mapper under a span naming the subscription and its method).
    /// `None` once the subscription ended with nothing to send (canceled by its client, or its
    /// connection closed, which also closes its gate) and after its end frame; the gateway then
    /// drops it. A cancel ends a feed that is waiting.
    pub async fn next_frame(&mut self, gate: &dyn SendGate) -> Option<SubscriptionFrame> {
        if self.has_ended {
            return None;
        }
        let span = tracing::error_span!(
            "subscription",
            subscription_id = %self.id,
            method = self.method,
        );
        let frame = self.read_frame(gate).instrument(span).await;
        if !matches!(frame, Some(SubscriptionFrame::Notify(_))) {
            self.has_ended = true;
        }
        frame
    }

    async fn read_frame(&mut self, gate: &dyn SendGate) -> Option<SubscriptionFrame> {
        let read = self
            .cancellation
            .run_until_cancelled(self.feed.next(gate))
            .await;
        // A subscription canceled from outside ends with no frame: its client asked, or is gone.
        // Its gate closes only once it is canceled, so a feed stopped by its gate lands here too.
        // The end is marked under the table's lock, so a cancel either wins or answers false.
        let end = match read {
            Some(Ok(Some(value))) => return Some(SubscriptionFrame::Notify(value)),
            None => return None,
            Some(Ok(None)) => SubscriptionEndParams::Completed {
                subscription_id: self.id,
            },
            Some(Err(error)) => {
                self.subscriptions.failures.report_dispatch_failure(&error);
                SubscriptionEndParams::Refused {
                    subscription_id: self.id,
                    // Mapped even when no frame goes out, so a fault is still logged once.
                    error: json_rpc_error_of(CallFailure::Dispatch(error)),
                }
            }
        };
        self.subscriptions
            .mark_ended(&self.id)
            .then_some(SubscriptionFrame::End(end))
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // Runs before the fields drop, so the entry leaves the table before the feed is released.
        self.subscriptions.lock().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use futures::future::BoxFuture;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::streaming::{
        SUBSCRIPTION_CANCEL_METHOD, SubscribeAcknowledgmentResponse,
    };

    use super::*;
    use crate::call_fixtures::{
        Named, NamedSubscribe, SUBSCRIBE_METHOD as METHOD, channel_feed, context, request,
        subscription_id,
    };
    use crate::registry::{Dispatch as _, HandlerError, MethodRegistry, Reply};
    use crate::stream::feed::{CreditGate, Feed};

    /// A watch that keeps the text of each failure it is told of.
    #[derive(Default)]
    struct ToldFailures(Mutex<Vec<String>>);

    impl DispatchFailureWatch for ToldFailures {
        fn report_dispatch_failure(&self, failure: &DispatchError) {
            lock(&self.0).push(failure.to_string());
        }
    }

    /// A typed feed whose emission breaks its length rule.
    struct OverlongName;

    impl Feed for OverlongName {
        type Emission = Named;

        fn next<'a>(
            &'a mut self,
            _gate: &'a dyn SendGate,
        ) -> BoxFuture<'a, Result<Option<Named>, HandlerError>> {
            futures::future::ready(Ok(Some(Named {
                name: "far too long".to_owned(),
            })))
            .boxed()
        }
    }

    /// A table and a frozen registry serving its cancel call and `test.subscribe`, whose feed's
    /// one emission breaks its rule.
    fn served() -> (Arc<Subscriptions>, MethodRegistry) {
        let subscriptions = Subscriptions::new(Arc::new(ToldFailures::default()));
        let mut builder = MethodRegistryBuilder::new();
        subscriptions
            .register_cancel(&mut builder)
            .expect("the cancel call registers");
        builder
            .register_subscription::<NamedSubscribe, _>(
                |_named: Named, _context: HandlerContext, subscription_id: SubscriptionId| {
                    let feed: Box<dyn Feed<Emission = Named>> = Box::new(OverlongName);
                    futures::future::ready(Ok((
                        SubscribeAcknowledgmentResponse { subscription_id },
                        feed,
                    )))
                    .boxed()
                },
            )
            .expect("the subscribe call registers");
        (subscriptions, builder.freeze())
    }

    /// Dispatches `$/subscription/cancel` for `subscription_id` from `transport`, as the gateway
    /// will, and answers its `canceled`.
    async fn cancel_from(
        registry: &MethodRegistry,
        transport: u64,
        subscription_id: &SubscriptionId,
    ) -> bool {
        let params = json!({ "subscriptionId": subscription_id });
        let reply = registry
            .dispatch(
                request(SUBSCRIPTION_CANCEL_METHOD, Some(&params)),
                context(transport),
            )
            .await;
        let Ok(Reply::Result(result)) = reply else {
            panic!("a cancel answers a result");
        };
        serde_json::from_slice::<SubscriptionCancelResponse>(&result.json)
            .expect("the result reads as its type")
            .canceled
    }

    #[tokio::test]
    async fn only_the_owning_connection_cancels_and_its_cancel_sends_no_frame() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, registry) = served();
        let (values, _taken, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), METHOD, subscription_id(1), feed)
            .expect("the connection is under its limit");

        assert!(!cancel_from(&registry, 2, &subscription_id(1)).await);
        values.send(json!(1)).expect("the feed is still held");
        assert!(matches!(
            subscription.next_frame(&gate).await,
            Some(SubscriptionFrame::Notify(_))
        ));

        // The feed waits on a source that is still open; the owner's cancel ends it, and answers
        // once the gateway drops the subscription after closing its lane.
        let owned = subscription_id(1);
        let (canceled, ()) = tokio::join!(cancel_from(&registry, 1, &owned), async {
            assert!(subscription.next_frame(&gate).await.is_none());
            drop(subscription);
        });
        assert!(canceled);
        assert!(values.is_closed(), "the feed was released");
        assert!(
            !cancel_from(&registry, 1, &owned).await,
            "a second cancel finds it gone"
        );
    }

    #[tokio::test]
    async fn a_finished_feed_sends_one_completed_end_frame() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, _registry) = served();
        let (values, _taken, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), METHOD, subscription_id(1), feed)
            .expect("the connection is under its limit");
        drop(values);

        assert!(matches!(
            subscription.next_frame(&gate).await,
            Some(SubscriptionFrame::End(SubscriptionEndParams::Completed { subscription_id: id }))
                if id == subscription_id(1)
        ));
        assert!(subscription.next_frame(&gate).await.is_none());
    }

    #[tokio::test]
    async fn a_closed_connection_ends_its_subscriptions_with_no_frame_and_releases_their_feeds() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, _registry) = served();
        let (values, _taken, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), METHOD, subscription_id(1), feed)
            .expect("the connection is under its limit");

        let (frame, ()) = tokio::join!(subscription.next_frame(&gate), async {
            subscriptions.cleanup_transport(TransportId(1));
        });
        assert!(frame.is_none());
        assert!(subscription.next_frame(&gate).await.is_none());
        drop(subscription);
        assert!(values.is_closed(), "the feed was released");
        assert!(
            subscriptions.lock().by_id.is_empty(),
            "the entry left the table"
        );
    }

    #[tokio::test]
    async fn an_emission_breaking_its_rule_ends_the_subscription_refused_result_invalid() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, registry) = served();
        let reply = registry
            .dispatch(
                request("test.subscribe", Some(&json!({ "name": "ok" }))),
                context(1),
            )
            .await;
        let Ok(Reply::Subscription {
            subscription_id,
            feed,
            ..
        }) = reply
        else {
            panic!("a subscribe call answers a subscription");
        };
        let mut subscription = subscriptions
            .open(TransportId(1), METHOD, subscription_id, feed)
            .expect("the connection is under its limit");

        let frame = subscription.next_frame(&gate).await;
        let Some(SubscriptionFrame::End(SubscriptionEndParams::Refused { error, .. })) = frame
        else {
            panic!("the subscription ends refused");
        };
        assert_eq!(error.code.get(), -32603);
        assert_eq!(
            error.data.map(|data| data.refusal).as_deref(),
            Some("request.resultInvalid")
        );
        assert!(subscription.next_frame(&gate).await.is_none());
    }

    // Killed by dropping the report where the read's failure is mapped: the repair then never
    // hears of damage only a subscription met.
    #[tokio::test]
    async fn a_damaged_read_ends_the_subscription_and_reaches_the_damage_watch() {
        /// A feed whose read meets a damaged database file.
        struct DamagedRead;

        fn damaged() -> rusqlite::Error {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                None,
            )
        }

        impl EncodedFeed for DamagedRead {
            fn next<'a>(
                &'a mut self,
                _gate: &'a dyn SendGate,
            ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>> {
                futures::future::ready(Err(DispatchError::Internal(Box::new(damaged())))).boxed()
            }
        }

        let gate = CreditGate::with_credit(1);
        let told = Arc::new(ToldFailures::default());
        let subscriptions = Subscriptions::new(Arc::clone(&told) as Arc<dyn DispatchFailureWatch>);
        let mut subscription = subscriptions
            .open(
                TransportId(1),
                METHOD,
                subscription_id(1),
                Box::new(DamagedRead),
            )
            .expect("the connection is under its limit");

        assert!(matches!(
            subscription.next_frame(&gate).await,
            Some(SubscriptionFrame::End(
                SubscriptionEndParams::Refused { .. }
            ))
        ));
        assert_eq!(
            *lock(&told.0),
            [damaged().to_string()],
            "the damage reached the watch"
        );
    }

    #[tokio::test]
    async fn a_connection_holds_at_most_ten_thousand_open_subscriptions() {
        /// A feed that never sends.
        struct IdleFeed;

        impl EncodedFeed for IdleFeed {
            fn next<'a>(
                &'a mut self,
                _gate: &'a dyn SendGate,
            ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>> {
                futures::future::pending().boxed()
            }
        }

        let (subscriptions, registry) = served();
        let limit = MAX_OPEN_LANES as u128;
        let mut open: Vec<Subscription> = (0..limit)
            .map(|number| {
                subscriptions
                    .open(
                        TransportId(1),
                        METHOD,
                        subscription_id(number),
                        Box::new(IdleFeed),
                    )
                    .expect("the connection is under its limit")
            })
            .collect();

        let refusal = subscriptions
            .open(
                TransportId(1),
                METHOD,
                subscription_id(limit),
                Box::new(IdleFeed),
            )
            .err()
            .expect("the connection is at its limit");
        assert_eq!(
            refusal.code,
            RefusalCode::ConnectionSubscriptionLimitReached
        );
        assert_eq!(
            refusal.detail.map(Value::Object),
            Some(json!({ "limit": 10_000 }))
        );

        open.push(
            subscriptions
                .open(
                    TransportId(2),
                    METHOD,
                    subscription_id(limit),
                    Box::new(IdleFeed),
                )
                .expect("another connection has its own limit"),
        );
        assert!(!subscriptions.has_room(TransportId(1)));
        let first = open.remove(0);
        let first_id = subscription_id(0);
        let (canceled, ()) = tokio::join!(cancel_from(&registry, 1, &first_id), async {
            drop(first);
        });
        assert!(canceled);
        assert!(subscriptions.has_room(TransportId(1)));
        open.push(
            subscriptions
                .open(
                    TransportId(1),
                    METHOD,
                    subscription_id(limit + 1),
                    Box::new(IdleFeed),
                )
                .expect("the cancel freed a slot"),
        );
    }
}

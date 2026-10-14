//! The daemon's open subscriptions: each one's connection and cancellation, the
//! `$/subscription/cancel` call that tears one down from its own connection, and the frames the
//! gateway writes for one once its acknowledgement is on the wire. A subscription owns its feed,
//! and whatever the feed follows is released when the feed drops, on every end. The daemon's own
//! end sends one `$/subscription/end` frame; a client's cancel and a closed connection send none.

use std::collections::hash_map::Entry as MapEntry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::framing::incoming::MAX_OPEN_LANES;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{
    SubscriptionCancel, SubscriptionCancelParams, SubscriptionCancelResult, SubscriptionEndParams,
    SubscriptionId,
};
use tokio_util::sync::CancellationToken;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
use crate::ipc::jsonrpc_error_mapping::{CallFailure, json_rpc_error_of};
use crate::ipc::registry::{
    EncodedFeed, EncodedValue, HandlerContext, MethodRegistryBuilder, RegistrationError,
    TransportId,
};
use crate::ipc::stream::feed::SendGate;

/// The daemon's open subscriptions, by id and by connection, shared by the cancel call, the
/// gateway's connection close and each open subscription.
#[derive(Default)]
pub(crate) struct Subscriptions {
    table: Mutex<SubscriptionTable>,
}

/// The open subscriptions by id, and each connection's ids, so a close touches only its own.
#[derive(Default)]
struct SubscriptionTable {
    by_id: HashMap<SubscriptionId, OpenSubscription>,
    by_transport: HashMap<TransportId, HashSet<SubscriptionId>>,
}

/// One open subscription's entry: the connection that owns it and what ends it from outside.
struct OpenSubscription {
    transport: TransportId,
    cancellation: CancellationToken,
}

impl SubscriptionTable {
    /// Takes `subscription_id` out of both maps, dropping its connection's set once empty.
    fn remove(&mut self, subscription_id: &SubscriptionId) -> Option<OpenSubscription> {
        let open = self.by_id.remove(subscription_id)?;
        if let MapEntry::Occupied(mut ids) = self.by_transport.entry(open.transport) {
            ids.get_mut().remove(subscription_id);
            if ids.get().is_empty() {
                ids.remove();
            }
        }
        Some(open)
    }
}

impl Subscriptions {
    /// An empty table, shared by everything that opens, cancels or closes a subscription.
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Registers `$/subscription/cancel`: a read, answered `{canceled: true}` only from the
    /// connection that owns the subscription, which then ends with no end frame. An unknown id
    /// and another connection's both answer `{canceled: false}`, so no connection can probe for
    /// another's. Fails the start when the method is already registered.
    pub(crate) fn register_cancel(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
    ) -> Result<(), RegistrationError> {
        let subscriptions = Arc::clone(self);
        registry.register::<SubscriptionCancel, _>(
            move |params: SubscriptionCancelParams, context: HandlerContext| {
                let canceled = subscriptions.cancel(&params.subscription_id, context.transport_id);
                futures::future::ready(Ok(SubscriptionCancelResult { canceled })).boxed()
            },
        )
    }

    /// Opens the subscription a subscribe call answered, owned by `transport`, before the gateway
    /// writes its acknowledgement. Refused `transport.subscription_limit_reached` with `{limit}`
    /// when the connection already holds `MAX_OPEN_LANES` open subscriptions; the feed is then
    /// dropped and nothing opens.
    pub(crate) fn open(
        self: &Arc<Self>,
        transport: TransportId,
        subscription_id: SubscriptionId,
        feed: Box<dyn EncodedFeed>,
    ) -> Result<Subscription, DomainError> {
        let cancellation = CancellationToken::new();
        {
            let mut guard = self.lock();
            let table = &mut *guard;
            let ids = table.by_transport.entry(transport).or_default();
            if ids.len() >= MAX_OPEN_LANES {
                return Err(subscription_limit_reached());
            }
            ids.insert(subscription_id.clone());
            table.by_id.insert(
                subscription_id.clone(),
                OpenSubscription {
                    transport,
                    cancellation: cancellation.clone(),
                },
            );
        }
        Ok(Subscription {
            subscriptions: Arc::clone(self),
            id: subscription_id,
            cancellation,
            feed: Some(feed),
        })
    }

    /// Ends every subscription of the closed connection `transport`, with no end frame: each is
    /// taken out of the table, then canceled, which releases its feed.
    pub(crate) fn cleanup_transport(&self, transport: TransportId) {
        let closed: Vec<CancellationToken> = {
            let mut guard = self.lock();
            let table = &mut *guard;
            let Some(ids) = table.by_transport.remove(&transport) else {
                return;
            };
            ids.iter()
                .filter_map(|subscription_id| table.by_id.remove(subscription_id))
                .map(|open| open.cancellation)
                .collect()
        };
        for cancellation in closed {
            cancellation.cancel();
        }
    }

    /// A client's cancel from `transport`: true when it owns `subscription_id`, which is taken out
    /// of the table, then canceled.
    fn cancel(&self, subscription_id: &SubscriptionId, transport: TransportId) -> bool {
        let removed = {
            let mut table = self.lock();
            let is_owner = table
                .by_id
                .get(subscription_id)
                .is_some_and(|open| open.transport == transport);
            if is_owner {
                table.remove(subscription_id)
            } else {
                None
            }
        };
        let Some(open) = removed else {
            return false;
        };
        open.cancellation.cancel();
        true
    }

    /// Takes `subscription_id` out of the table, if it is still there.
    fn remove(&self, subscription_id: &SubscriptionId) {
        self.lock().remove(subscription_id);
    }

    fn lock(&self) -> MutexGuard<'_, SubscriptionTable> {
        self.table
            .lock()
            .expect("a panic ends the daemon, so no holder leaves the table poisoned")
    }
}

/// The refusal of a subscribe call on a connection that holds `MAX_OPEN_LANES` subscriptions.
fn subscription_limit_reached() -> DomainError {
    let detail: Map<String, Value> = [("limit".to_owned(), Value::from(MAX_OPEN_LANES))]
        .into_iter()
        .collect();
    DomainError::new(
        "the connection holds as many subscriptions as it may open",
        RefusalCode::TransportSubscriptionLimitReached,
        DomainErrorJsonRpcCode::InternalError,
    )
    .with_detail(detail)
}

/// One frame of a subscription's lane.
pub(crate) enum SubscriptionFrame {
    /// One value, which the gateway sends as `$/subscription/notify` under the subscription's id.
    Notify(EncodedValue),
    /// The daemon's end of the stream, sent as `$/subscription/end`; nothing follows it.
    End(SubscriptionEndParams),
}

/// One open subscription, which the gateway drives only once the acknowledgement's END chunk is
/// written. Dropping it takes it out of the table, then drops its feed.
pub(crate) struct Subscription {
    subscriptions: Arc<Subscriptions>,
    id: SubscriptionId,
    cancellation: CancellationToken,
    /// `None` once the subscription ended, so what the feed followed is released at the end.
    feed: Option<Box<dyn EncodedFeed>>,
}

impl Subscription {
    /// The id the subscription's frames are routed by.
    pub(crate) fn subscription_id(&self) -> &SubscriptionId {
        &self.id
    }

    /// The next frame once `gate` lets one through: a value, or the end frame (`completed` when
    /// the feed finished, `refused` with the mapped error when its read failed or an emission broke
    /// its rule, logged once by the mapper). `None` once the subscription ended with nothing to
    /// send (canceled by its client, or its connection closed, which also closes its gate) and
    /// after its end frame. A cancel ends a feed that is waiting.
    pub(crate) async fn next_frame(&mut self, gate: &dyn SendGate) -> Option<SubscriptionFrame> {
        let feed = self.feed.as_mut()?;
        let read = self.cancellation.run_until_cancelled(feed.next(gate)).await;
        // A subscription canceled from outside ends with no frame: its client asked, or is gone.
        // Its gate closes only once it is canceled, so a feed stopped by its gate lands here too.
        let is_canceled = self.cancellation.is_cancelled();
        let end = match read {
            Some(Ok(Some(value))) => return Some(SubscriptionFrame::Notify(value)),
            None => None,
            Some(Ok(None)) => (!is_canceled).then(|| SubscriptionEndParams::Completed {
                subscription_id: self.id.clone(),
            }),
            Some(Err(error)) => {
                // Mapped even when no frame goes out, so a fault is still logged once.
                let error = json_rpc_error_of(CallFailure::Dispatch(error));
                (!is_canceled).then(|| SubscriptionEndParams::Refused {
                    subscription_id: self.id.clone(),
                    error,
                })
            }
        };
        self.subscriptions.remove(&self.id);
        self.feed = None;
        end.map(SubscriptionFrame::End)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // Runs before the fields drop, so the entry leaves the table before the feed is released.
        self.subscriptions.remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use futures::future::BoxFuture;
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::jsonrpc::streaming::{
        SUBSCRIPTION_CANCEL_METHOD, SubscribeAckResponse,
    };
    use sidekicks_contracts::method::{
        Method, MethodDescriptor, ProcedureType, SubscriptionMethod,
    };
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_contracts::typescript::TypeName;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::*;
    use crate::ipc::registry::{
        Dispatch as _, DispatchError, HandlerError, MethodRegistry, Reply, Request,
    };
    use crate::ipc::stream::feed::{CreditGate, Feed};

    /// A feed sending each JSON its channel carries, finished once the sender is dropped.
    struct ChannelFeed {
        values: mpsc::UnboundedReceiver<Vec<u8>>,
    }

    impl EncodedFeed for ChannelFeed {
        fn next<'a>(
            &'a mut self,
            gate: &'a dyn SendGate,
        ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>> {
            async move {
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                Ok(self.values.recv().await.map(|json| EncodedValue {
                    json,
                    attachments: Vec::new(),
                }))
            }
            .boxed()
        }
    }

    /// A channel feed and its sender, which reads closed once the feed is released.
    fn channel_feed() -> (mpsc::UnboundedSender<Vec<u8>>, Box<dyn EncodedFeed>) {
        let (sender, values) = mpsc::unbounded_channel();
        (sender, Box::new(ChannelFeed { values }))
    }

    #[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Named {
        #[garde(length(max = 4))]
        name: String,
    }

    /// A subscribe method whose emissions are `Named`.
    struct NamedSubscribe;

    impl Method for NamedSubscribe {
        type Params = Named;
        type Result = SubscribeAckResponse;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: "test.subscribe",
            procedure_type: ProcedureType::Subscription,
            is_mutating: false,
            params: TypeName::of::<Named>(),
            result: TypeName::of::<SubscribeAckResponse>(),
            emission: Some(TypeName::of::<Named>()),
            refusals: &[],
            received_check: received_check::<Named>,
        };
    }

    impl SubscriptionMethod for NamedSubscribe {
        type Emission = Named;
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

    fn subscription_id(number: u128) -> SubscriptionId {
        // A version-7 layout, so the id reads as the UUID text form.
        let uuid = Uuid::from_u128(0x7000_8000_0000_0000_0000 | number);
        SubscriptionId::new(uuid.to_string()).expect("the layout is a UUID's")
    }

    fn context(transport: u64) -> HandlerContext {
        HandlerContext {
            transport_id: TransportId(transport),
            device_id: DeviceId::new("device".to_owned()).expect("the id is well formed"),
            caller_process_id: None,
            cancellation: CancellationToken::new(),
        }
    }

    fn request(method: &str, params: &Value) -> Request {
        Request {
            method: method.to_owned(),
            params: Some(RawValue::from_string(params.to_string()).expect("the params are JSON")),
            attachments: Vec::new(),
        }
    }

    /// A table and a frozen registry serving its cancel call and `test.subscribe`, whose feed's
    /// one emission breaks its rule.
    fn served() -> (Arc<Subscriptions>, MethodRegistry) {
        let subscriptions = Subscriptions::new();
        let mut builder = MethodRegistryBuilder::new();
        subscriptions
            .register_cancel(&mut builder)
            .expect("the cancel call registers");
        builder
            .register_subscription::<NamedSubscribe, _>(
                |_named: Named, _context: HandlerContext, subscription_id: SubscriptionId| {
                    let feed: Box<dyn Feed<Emission = Named>> = Box::new(OverlongName);
                    futures::future::ready(Ok((SubscribeAckResponse { subscription_id }, feed)))
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
        let params = json!({ "subscriptionId": subscription_id.as_str() });
        let reply = registry
            .dispatch(
                request(SUBSCRIPTION_CANCEL_METHOD, &params),
                context(transport),
            )
            .await;
        let Ok(Reply::Result(result)) = reply else {
            panic!("a cancel answers a result");
        };
        serde_json::from_slice::<SubscriptionCancelResult>(&result.json)
            .expect("the result reads as its type")
            .canceled
    }

    #[tokio::test]
    async fn only_the_owning_connection_cancels_and_its_cancel_sends_no_frame() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, registry) = served();
        let (values, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), subscription_id(1), feed)
            .expect("the connection is under its limit");

        assert!(!cancel_from(&registry, 2, &subscription_id(1)).await);
        values.send(b"1".to_vec()).expect("the feed is still held");
        assert!(matches!(
            subscription.next_frame(&gate).await,
            Some(SubscriptionFrame::Notify(_))
        ));

        // The feed waits on a source that is still open; the owner's cancel ends it.
        let owned = subscription_id(1);
        let (frame, canceled) = tokio::join!(
            subscription.next_frame(&gate),
            cancel_from(&registry, 1, &owned)
        );
        assert!(canceled);
        assert!(frame.is_none());
        assert!(values.is_closed(), "the feed was released");
    }

    #[tokio::test]
    async fn a_finished_feed_sends_one_completed_end_frame() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, _registry) = served();
        let (values, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), subscription_id(1), feed)
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
        let (values, feed) = channel_feed();
        let mut subscription = subscriptions
            .open(TransportId(1), subscription_id(1), feed)
            .expect("the connection is under its limit");

        let (frame, ()) = tokio::join!(subscription.next_frame(&gate), async {
            subscriptions.cleanup_transport(TransportId(1));
        });
        assert!(frame.is_none());
        assert!(values.is_closed(), "the feed was released");
    }

    #[tokio::test]
    async fn an_emission_breaking_its_rule_ends_the_subscription_refused_invalid_result() {
        let gate = CreditGate::with_credit(1);
        let (subscriptions, registry) = served();
        let reply = registry
            .dispatch(
                request("test.subscribe", &json!({ "name": "ok" })),
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
            .open(TransportId(1), subscription_id, feed)
            .expect("the connection is under its limit");

        let frame = subscription.next_frame(&gate).await;
        let Some(SubscriptionFrame::End(SubscriptionEndParams::Refused { error, .. })) = frame
        else {
            panic!("the subscription ends refused");
        };
        assert_eq!(error.code.get(), -32603);
        assert_eq!(
            error.data.map(|data| data.refusal).as_deref(),
            Some("invalid_result")
        );
        assert!(subscription.next_frame(&gate).await.is_none());
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
                    .open(TransportId(1), subscription_id(number), Box::new(IdleFeed))
                    .expect("the connection is under its limit")
            })
            .collect();

        let refusal = subscriptions
            .open(TransportId(1), subscription_id(limit), Box::new(IdleFeed))
            .err()
            .expect("the connection is at its limit");
        assert_eq!(refusal.code, RefusalCode::TransportSubscriptionLimitReached);
        assert_eq!(
            refusal.detail.map(Value::Object),
            Some(json!({ "limit": 10_000 }))
        );

        open.push(
            subscriptions
                .open(TransportId(2), subscription_id(limit), Box::new(IdleFeed))
                .expect("another connection has its own limit"),
        );
        assert!(cancel_from(&registry, 1, &subscription_id(0)).await);
        open.push(
            subscriptions
                .open(
                    TransportId(1),
                    subscription_id(limit + 1),
                    Box::new(IdleFeed),
                )
                .expect("the cancel freed a slot"),
        );
    }
}

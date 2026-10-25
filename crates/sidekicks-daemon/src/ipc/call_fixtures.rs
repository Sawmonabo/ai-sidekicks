//! What the socket's tests share: a call's params with one rule, a call's empty params, a
//! subscribe method and a feed a test drives, a subscription id, the context the gateway stamps on
//! a call, and a call as the gateway hands it over.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType, SubscriptionMethod};
use sidekicks_contracts::schema::received_check;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::typescript::TypeName;
use sidekicks_contracts::wire::attachment::check_received;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ipc::registry::{
    AfterReply, DispatchError, EncodedFeed, EncodedValue, HandlerContext, Request, TransportId,
};
use crate::ipc::stream::feed::SendGate;

/// The wire name of [`NamedSubscribe`].
pub(crate) const SUBSCRIBE_METHOD: &str = "test.subscribe";

/// Params, a result or an emission whose one member holds at most four characters.
#[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Named {
    /// The member the rule holds.
    #[garde(length(max = 4))]
    pub(crate) name: String,
}

/// Params or a result with no member.
#[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
pub(crate) struct Nothing {}

/// The context of a call on connection `transport`, from a caller the system could not name,
/// recorded as no mutating call.
pub(crate) fn context(transport: u64) -> HandlerContext {
    HandlerContext {
        transport_id: TransportId(transport),
        device_id: Some(DeviceId::new("device".to_owned()).expect("the id is well formed")),
        caller_process: None,
        cancellation: CancellationToken::new(),
        recorded_call: None,
        after_reply: AfterReply::default(),
    }
}

/// A subscribe method taking and emitting `Named`.
pub(crate) struct NamedSubscribe;

impl Method for NamedSubscribe {
    type Params = Named;
    type Result = SubscribeAcknowledgmentResponse;
    const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
        method: SUBSCRIBE_METHOD,
        procedure_type: ProcedureType::Subscription,
        is_mutating: false,
        params: TypeName::of::<Named>(),
        result: TypeName::of::<SubscribeAcknowledgmentResponse>(),
        emission: Some(TypeName::of::<Named>()),
        refusals: &[],
        received_check: received_check::<Named>,
        check_params: check_received::<Named>,
        keyed: false,
        takes_call_slot: true,
    };
}

impl SubscriptionMethod for NamedSubscribe {
    type Emission = Named;
}

/// A feed sending each value its channel carries once its gate opens, finished once the sender is
/// dropped, counting the values it took.
struct ChannelFeed {
    values: mpsc::UnboundedReceiver<Value>,
    taken: Arc<AtomicUsize>,
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
            let value = self.values.recv().await;
            Ok(value.map(|value| {
                self.taken.fetch_add(1, Ordering::SeqCst);
                EncodedValue {
                    json: serde_json::to_vec(&value).expect("a test value writes"),
                    attachments: Vec::new(),
                }
            }))
        }
        .boxed()
    }
}

/// A channel feed, its sender, which reads closed once the feed is released, and its count of
/// values taken.
pub(crate) fn channel_feed() -> (
    mpsc::UnboundedSender<Value>,
    Arc<AtomicUsize>,
    Box<dyn EncodedFeed>,
) {
    let (sender, values) = mpsc::unbounded_channel();
    let taken = Arc::new(AtomicUsize::new(0));
    let feed = ChannelFeed {
        values,
        taken: Arc::clone(&taken),
    };
    (sender, taken, Box::new(feed))
}

/// Subscription id `number`, in a version-7 layout so it reads as the UUID text form.
pub(crate) fn subscription_id(number: u128) -> SubscriptionId {
    let uuid = Uuid::from_u128(0x7000_8000_0000_0000_0000 | number);
    SubscriptionId::try_from(uuid).expect("the layout is a UUID's")
}

/// A call to `method` with `params`, or with none, as the gateway hands it over.
pub(crate) fn request(method: &str, params: Option<&Value>) -> Request {
    Request {
        method: method.to_owned(),
        params: params
            .map(|params| RawValue::from_string(params.to_string()).expect("the params are JSON")),
        attachments: Vec::new(),
    }
}

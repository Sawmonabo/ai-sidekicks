//! The method registry: each method's handler, registered once at start under its wire name and
//! frozen before the socket listens, and the one dispatch path every gate in front of it shares. A
//! call's params are checked and read once before its handler runs, and its result is held to its
//! rules before it is written. The daemon serves every method table but the page host's
//! (`PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS`), which a preview page answers itself.

use std::collections::HashMap;
use std::collections::hash_map::Entry as MapEntry;
use std::error::Error;
use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use regex::Regex;
use serde::Serialize;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType, SubscriptionMethod};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::attachment::{ReceivedError, parse_received, write};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ipc::domain_error::DomainError;
use crate::ipc::in_flight_mutations::RecordedCallId;
use crate::ipc::stream::feed::{Feed, SendGate};

/// A dotted method name: lowercase-led camelCase segments, at least two (`session.create`).
static DOTTED_METHOD_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$").expect("the pattern is a valid regex")
});

/// A protocol method name: `$/`, then lowercase-led camelCase segments joined by `/`
/// (`$/subscription/cancel`).
static PROTOCOL_METHOD_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\$/[a-z][a-zA-Z0-9]*(/[a-z][a-zA-Z0-9]*)*$")
        .expect("the pattern is a valid regex")
});

/// The gateway's id for one connection, unique for the daemon's life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TransportId(pub(crate) u64);

/// What the gateway stamps on every call: never read from the request.
#[derive(Clone, Debug)]
pub(crate) struct HandlerContext {
    /// The connection the call arrived on.
    pub(crate) transport_id: TransportId,
    /// The device that connection comes from, which a handler records as the call's author.
    pub(crate) device_id: DeviceId,
    /// The process the system names at the client's end of the connection; `None` where the
    /// system could not name it.
    pub(crate) caller_process_id: Option<u32>,
    /// Canceled when the client sends `$/cancelRequest` for this call.
    pub(crate) cancellation: CancellationToken,
    /// The call's place among the mutating calls the daemon is running, which a flush or a stop
    /// waits behind; `None` for a call that is not recorded.
    pub(crate) recorded_call: Option<RecordedCallId>,
}

/// A handler's failure: a classified refusal, or a fault the client is told nothing of.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HandlerError {
    /// A refusal with its code, answered as the error mapper writes it.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A fault inside the daemon, answered `-32603` with no detail.
    #[error(transparent)]
    Internal(Box<dyn Error + Send + Sync>),
    /// The call ended unanswered: its client canceled it or its connection closed (`-32800`).
    #[error("the call was canceled")]
    Canceled,
}

/// Why a dispatch produced no reply. No arm's message names the method or quotes the call.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DispatchError {
    /// No method is registered under the call's name.
    #[error("the method is not served")]
    MethodNotFound,
    /// The params broke the method's contract, so the handler never ran; never logged, since the
    /// sources can quote the received value.
    #[error("the params break the method's contract")]
    InvalidParams(#[source] ReceivedError),
    /// The handler refused the call.
    #[error(transparent)]
    Refused(DomainError),
    /// The call was canceled before its handler answered (`-32800`).
    #[error("the call was canceled")]
    Canceled,
    /// A fault inside the daemon.
    #[error(transparent)]
    Internal(Box<dyn Error + Send + Sync>),
    /// The handler's answer broke its contract's rules: `report` holds each broken rule at its path
    /// in the type's names, `value` the answer's JSON those paths resolve against.
    #[error("the daemon's answer breaks its contract")]
    InvalidResult {
        /// Each broken rule.
        #[source]
        report: garde::Report,
        /// The answer as it would have been written.
        value: serde_json::Value,
    },
}

impl From<HandlerError> for DispatchError {
    fn from(error: HandlerError) -> Self {
        match error {
            HandlerError::Refused(error) => Self::Refused(error),
            HandlerError::Internal(error) => Self::Internal(error),
            HandlerError::Canceled => Self::Canceled,
        }
    }
}

/// One call as the gateway hands it over: the method's wire name, its params as received (absent
/// when the request carried none) and the attachments that came with the message.
pub(crate) struct Request {
    /// The method's wire name.
    pub(crate) method: String,
    /// The params as received; `None` when the request carried none.
    pub(crate) params: Option<Box<RawValue>>,
    /// The attachments the params' byte placeholders name.
    pub(crate) attachments: Vec<Bytes>,
}

/// A value written for the wire: its JSON and its attachments, as `wire::attachment::write` makes.
pub(crate) struct EncodedValue {
    /// The JSON, a placeholder for each byte member.
    pub(crate) json: Vec<u8>,
    /// The attachments, in placeholder order.
    pub(crate) attachments: Vec<Bytes>,
}

/// What a dispatch answers.
pub(crate) enum Reply {
    /// A query's or mutation's result, checked and encoded.
    Result(EncodedValue),
    /// A subscribe call's acknowledgement, checked and encoded, its subscription's id, and the
    /// feed the gateway starts only once it has written the acknowledgement's END chunk.
    Subscription {
        /// The acknowledgement, which carries `subscription_id`.
        acknowledgement: EncodedValue,
        /// The subscribe method's wire name, which the subscription's log lines carry.
        method: &'static str,
        /// The subscription's id, minted by the registry.
        subscription_id: SubscriptionId,
        /// The subscription's emissions.
        feed: Box<dyn EncodedFeed>,
    },
}

/// A subscription's emissions, each checked and encoded, read only when its gate allows.
pub(crate) trait EncodedFeed: Send {
    /// The next emission once `gate` lets a frame through; `Ok(None)` when the stream ended
    /// (finished, or its gate closed). An emission that fails its check is
    /// `DispatchError::InvalidResult`; the feed's own failure is `Refused` or `Internal`.
    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>>;
}

/// The one dispatch path: the registry and every gate implement it; a gate holds the next one as
/// `Arc<dyn Dispatch>` and the frozen registry for `descriptor`.
pub(crate) trait Dispatch: Send + Sync {
    /// Answers `request` under `context`; every way it produces no reply is a `DispatchError`.
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>>;
}

/// Why a method could not be registered; the daemon's start ends with it.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RegistrationError {
    /// A second handler for a name already registered.
    #[error("method {method} is registered twice")]
    Duplicate {
        /// The method's wire name.
        method: &'static str,
    },
    /// A name that is neither a dotted name (`session.create`) nor a protocol name
    /// (`$/subscription/cancel`).
    #[error("method name {method} is neither a dotted nor a protocol method name")]
    InvalidName {
        /// The method's wire name.
        method: &'static str,
    },
    /// A subscribe method registered through `register`, or a query or mutation through
    /// `register_subscription`.
    #[error("method {method} is registered through the form of another kind of method")]
    WrongForm {
        /// The method's wire name.
        method: &'static str,
    },
}

/// What a query's or a mutation's handler returns: its result, or why it gave none.
type HandlerAnswer<T> = BoxFuture<'static, Result<T, HandlerError>>;

/// One registered method's call with its types erased: params and attachments in, reply out.
type Call = Box<
    dyn Fn(
            Option<Box<RawValue>>,
            Vec<Bytes>,
            HandlerContext,
        ) -> BoxFuture<'static, Result<Reply, DispatchError>>
        + Send
        + Sync,
>;

/// One registered method: its table entry and its call.
struct RegisteredMethod {
    descriptor: &'static MethodDescriptor,
    call: Call,
}

/// The registry while the daemon starts: each method's handler registered once, then frozen.
#[derive(Default)]
pub(crate) struct MethodRegistryBuilder {
    methods: HashMap<&'static str, RegisteredMethod>,
}

impl MethodRegistryBuilder {
    /// An empty registry.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Registers a query's or a mutation's `handler`; fails on a subscribe method, a malformed name
    /// and a name already registered. A query's handler is dropped when its call is canceled; a
    /// mutation's runs to its own answer and checks `cancellation` at its commit point itself.
    pub(crate) fn register<M, Handler>(&mut self, handler: Handler) -> Result<(), RegistrationError>
    where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
        Handler: Fn(M::Params, HandlerContext) -> HandlerAnswer<M::Result> + Send + Sync + 'static,
    {
        if M::DESCRIPTOR.procedure_type == ProcedureType::Subscription {
            return Err(RegistrationError::WrongForm {
                method: M::DESCRIPTOR.method,
            });
        }
        let handler = Arc::new(handler);
        let call: Call = Box::new(
            move |params: Option<Box<RawValue>>,
                  attachments: Vec<Bytes>,
                  context: HandlerContext| {
                answer_call::<M, Handler>(Arc::clone(&handler), params, attachments, context)
                    .boxed()
            },
        );
        self.insert(const { &M::DESCRIPTOR }, call)
    }

    /// Registers a subscribe call's `handler`, which gets the subscription's id the registry mints
    /// and answers the acknowledgement carrying it and the typed feed; fails as `register` does.
    /// The handler is dropped when its call is canceled before it answers.
    pub(crate) fn register_subscription<M, Handler>(
        &mut self,
        handler: Handler,
    ) -> Result<(), RegistrationError>
    where
        M: SubscriptionMethod + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
        M::Emission: Send + 'static,
        Handler: Fn(
                M::Params,
                HandlerContext,
                SubscriptionId,
            ) -> BoxFuture<
                'static,
                Result<(M::Result, Box<dyn Feed<Emission = M::Emission>>), HandlerError>,
            > + Send
            + Sync
            + 'static,
    {
        if M::DESCRIPTOR.procedure_type != ProcedureType::Subscription {
            return Err(RegistrationError::WrongForm {
                method: M::DESCRIPTOR.method,
            });
        }
        let handler = Arc::new(handler);
        let call: Call = Box::new(
            move |params: Option<Box<RawValue>>,
                  attachments: Vec<Bytes>,
                  context: HandlerContext| {
                answer_subscribe_call::<M, Handler>(
                    Arc::clone(&handler),
                    params,
                    attachments,
                    context,
                )
                .boxed()
            },
        );
        self.insert(const { &M::DESCRIPTOR }, call)
    }

    /// Freezes the registry for dispatch; nothing registers after.
    pub(crate) fn freeze(self) -> MethodRegistry {
        MethodRegistry {
            methods: self.methods,
        }
    }

    fn insert(
        &mut self,
        descriptor: &'static MethodDescriptor,
        call: Call,
    ) -> Result<(), RegistrationError> {
        let method = descriptor.method;
        if !DOTTED_METHOD_NAME.is_match(method) && !PROTOCOL_METHOD_NAME.is_match(method) {
            return Err(RegistrationError::InvalidName { method });
        }
        match self.methods.entry(method) {
            MapEntry::Occupied(_) => Err(RegistrationError::Duplicate { method }),
            MapEntry::Vacant(slot) => {
                slot.insert(RegisteredMethod { descriptor, call });
                Ok(())
            }
        }
    }
}

/// The registry frozen at start: no lock, read by every gate.
pub(crate) struct MethodRegistry {
    methods: HashMap<&'static str, RegisteredMethod>,
}

impl MethodRegistry {
    /// The table entry of `method`, or `None` when no handler is registered under it.
    pub(crate) fn descriptor(&self, method: &str) -> Option<&'static MethodDescriptor> {
        self.methods
            .get(method)
            .map(|registered| registered.descriptor)
    }
}

impl Dispatch for MethodRegistry {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        match self.methods.get(request.method.as_str()) {
            Some(registered) => (registered.call)(request.params, request.attachments, context),
            None => futures::future::ready(Err(DispatchError::MethodNotFound)).boxed(),
        }
    }
}

/// One query or mutation call: refused if already canceled, params read, the handler run (a
/// query's dropped on cancel), and the result checked and encoded.
async fn answer_call<M, Handler>(
    handler: Arc<Handler>,
    params: Option<Box<RawValue>>,
    attachments: Vec<Bytes>,
    context: HandlerContext,
) -> Result<Reply, DispatchError>
where
    M: Method + 'static,
    M::Params: 'static,
    Handler: Fn(M::Params, HandlerContext) -> HandlerAnswer<M::Result>,
{
    if context.cancellation.is_cancelled() {
        return Err(DispatchError::Canceled);
    }
    let params = read_params::<M>(params.as_deref(), attachments)?;
    let cancellation = context.cancellation.clone();
    let answer = (*handler)(params, context);
    let result = match M::DESCRIPTOR.procedure_type {
        ProcedureType::Mutation => answer.await?,
        ProcedureType::Query | ProcedureType::Subscription => cancellation
            .run_until_cancelled(answer)
            .await
            .ok_or(DispatchError::Canceled)??,
    };
    Ok(Reply::Result(encode_checked(&result)?))
}

/// One subscribe call: refused if already canceled, params read, a subscription id minted, the
/// handler run (dropped on cancel), and the acknowledgement checked and encoded beside the feed.
async fn answer_subscribe_call<M, Handler>(
    handler: Arc<Handler>,
    params: Option<Box<RawValue>>,
    attachments: Vec<Bytes>,
    context: HandlerContext,
) -> Result<Reply, DispatchError>
where
    M: SubscriptionMethod + 'static,
    M::Params: 'static,
    M::Emission: Send + 'static,
    Handler: Fn(
        M::Params,
        HandlerContext,
        SubscriptionId,
    ) -> BoxFuture<
        'static,
        Result<(M::Result, Box<dyn Feed<Emission = M::Emission>>), HandlerError>,
    >,
{
    if context.cancellation.is_cancelled() {
        return Err(DispatchError::Canceled);
    }
    let params = read_params::<M>(params.as_deref(), attachments)?;
    let cancellation = context.cancellation.clone();
    let subscription_id = mint_subscription_id();
    let answer = (*handler)(params, context, subscription_id.clone());
    let (acknowledgement, feed) = cancellation
        .run_until_cancelled(answer)
        .await
        .ok_or(DispatchError::Canceled)??;
    Ok(Reply::Subscription {
        acknowledgement: encode_checked(&acknowledgement)?,
        method: M::DESCRIPTOR.method,
        subscription_id,
        feed: Box::new(CheckedFeed { feed }),
    })
}

/// A call's params read once against their contract; absent params read as the JSON `null`, which
/// every params schema refuses.
fn read_params<M>(
    params: Option<&RawValue>,
    attachments: Vec<Bytes>,
) -> Result<M::Params, DispatchError>
where
    M: Method + 'static,
    M::Params: 'static,
{
    let json = params.map_or("null", RawValue::get);
    parse_received::<M::Params>(json.as_bytes(), attachments).map_err(DispatchError::InvalidParams)
}

/// `value` held to its rules, then written for the wire; a broken rule is `InvalidResult` with
/// the JSON it would have been written as, and a failed write is `Internal`.
fn encode_checked<T>(value: &T) -> Result<EncodedValue, DispatchError>
where
    T: Serialize + garde::Validate<Context = ()>,
{
    let checked = value.validate();
    let (json, attachments) =
        write(value).map_err(|error| DispatchError::Internal(Box::new(error)))?;
    match checked {
        Ok(()) => Ok(EncodedValue { json, attachments }),
        Err(report) => {
            let value = serde_json::from_slice(&json)
                .map_err(|error| DispatchError::Internal(Box::new(error)))?;
            Err(DispatchError::InvalidResult { report, value })
        }
    }
}

fn mint_subscription_id() -> SubscriptionId {
    #[expect(
        clippy::disallowed_methods,
        reason = "a subscription id is an ephemeral token no row or event stores"
    )]
    let uuid = Uuid::now_v7();
    SubscriptionId::new(uuid.to_string()).expect("a UUID's text is the UUID text form")
}

/// A subscribe handler's typed feed, each emission held to its rules and written for the wire.
struct CheckedFeed<Emission> {
    feed: Box<dyn Feed<Emission = Emission>>,
}

impl<Emission> EncodedFeed for CheckedFeed<Emission>
where
    Emission: Serialize + garde::Validate<Context = ()> + Send + 'static,
{
    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>> {
        async move {
            match self.feed.next(gate).await {
                Ok(Some(emission)) => encode_checked(&emission).map(Some),
                Ok(None) => Ok(None),
                Err(error) => Err(DispatchError::from(error)),
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::typescript::TypeName;
    use sidekicks_contracts::wire::attachment::ReceivedError;

    use super::{
        Dispatch as _, DispatchError, HandlerContext, MethodRegistryBuilder, RegistrationError,
        Request,
    };
    use crate::ipc::call_fixtures::{Named, context};

    /// The wire names the markers register under, by index.
    const NAMES: [&str; 6] = [
        "test.echo",
        "Test.echo",
        "test",
        "test.echo_one",
        "$/Subscription/notify",
        "$/subscription/cancel",
    ];

    struct Marker<const NAME: usize>;

    impl<const NAME: usize> Method for Marker<NAME> {
        type Params = Named;
        type Result = Named;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: NAMES[NAME],
            procedure_type: ProcedureType::Query,
            is_mutating: false,
            params: TypeName::of::<Named>(),
            result: TypeName::of::<Named>(),
            emission: None,
            refusals: &[],
            received_check: received_check::<Named>,
        };
    }

    type Registration = fn(&mut MethodRegistryBuilder) -> Result<(), RegistrationError>;

    fn register_echo<const NAME: usize>(
        builder: &mut MethodRegistryBuilder,
    ) -> Result<(), RegistrationError> {
        builder.register::<Marker<NAME>, _>(|named: Named, _context: HandlerContext| {
            async move { Ok(named) }.boxed()
        })
    }

    fn request(params: Option<&str>) -> Request {
        Request {
            method: NAMES[0].to_owned(),
            params: params
                .map(|text| RawValue::from_string(text.to_owned()).expect("the params are JSON")),
            attachments: Vec::new(),
        }
    }

    #[rstest]
    #[case::repeated(register_echo::<0>, Err(RegistrationError::Duplicate { method: "test.echo" }))]
    #[case::capital_head(
        register_echo::<1>,
        Err(RegistrationError::InvalidName { method: "Test.echo" })
    )]
    #[case::one_segment(register_echo::<2>, Err(RegistrationError::InvalidName { method: "test" }))]
    #[case::underscore(
        register_echo::<3>,
        Err(RegistrationError::InvalidName { method: "test.echo_one" })
    )]
    #[case::capital_protocol_segment(
        register_echo::<4>,
        Err(RegistrationError::InvalidName { method: "$/Subscription/notify" })
    )]
    #[case::protocol_name(register_echo::<5>, Ok(()))]
    fn a_repeated_or_malformed_name_fails_the_start(
        #[case] register_second: Registration,
        #[case] expected: Result<(), RegistrationError>,
    ) {
        let mut builder = MethodRegistryBuilder::new();
        register_echo::<0>(&mut builder).expect("a first well-formed name registers");
        assert_eq!(register_second(&mut builder), expected);
    }

    #[rstest]
    #[case::absent(None, false)]
    #[case::wrong_type(Some(r#"{"name": 7}"#), false)]
    #[case::broken_rule(Some(r#"{"name": "too long"}"#), true)]
    #[tokio::test]
    async fn params_breaking_their_check_never_run_the_handler(
        #[case] params: Option<&str>,
        #[case] breaks_a_rule: bool,
    ) {
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&runs);
        let mut builder = MethodRegistryBuilder::new();
        builder
            .register::<Marker<0>, _>(move |named: Named, _context: HandlerContext| {
                counted.fetch_add(1, Ordering::SeqCst);
                async move { Ok(named) }.boxed()
            })
            .expect("the name registers");
        let answer = builder.freeze().dispatch(request(params), context(1)).await;
        let refusal = match answer {
            Err(DispatchError::InvalidParams(refusal)) => refusal,
            Err(error) => panic!("expected invalid params, got {error:?}"),
            Ok(_) => panic!("expected invalid params, got a reply"),
        };
        // The shape refuses what does not read as the type; garde refuses what reads but breaks a
        // rule.
        assert_eq!(
            matches!(refusal, ReceivedError::Shape { .. }),
            !breaks_a_rule
        );
        assert_eq!(matches!(refusal, ReceivedError::Rule { .. }), breaks_a_rule);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_result_breaking_its_rule_answers_invalid_result() {
        let mut builder = MethodRegistryBuilder::new();
        builder
            .register::<Marker<0>, _>(|_named: Named, _context: HandlerContext| {
                async move {
                    Ok(Named {
                        name: "far too long".to_owned(),
                    })
                }
                .boxed()
            })
            .expect("the name registers");
        let answer = builder
            .freeze()
            .dispatch(request(Some(r#"{"name": "ok"}"#)), context(1))
            .await;
        match answer {
            Err(DispatchError::InvalidResult { value, .. }) => {
                assert_eq!(value, json!({ "name": "far too long" }));
            }
            Err(error) => panic!("expected an invalid result, got {error:?}"),
            Ok(_) => panic!("expected an invalid result, got a reply"),
        }
    }
}

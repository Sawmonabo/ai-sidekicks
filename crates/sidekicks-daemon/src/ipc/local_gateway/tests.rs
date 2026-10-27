//! The gateway's tests over an in-memory stream: a scripted dispatch, test feeds, recorded hooks
//! and a client that speaks the frame codec. The tests are split by behavior below.

use std::collections::VecDeque;
use std::error::Error;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use futures::future::BoxFuture;
use futures::{FutureExt as _, SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::incoming::{IncomingLanes, LaneCredit};
use sidekicks_contracts::jsonrpc::framing::outgoing::OutgoingLanes;
use sidekicks_contracts::jsonrpc::framing::{MAX_CHUNK_BYTES, MessageBody};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
use sidekicks_contracts::schema::received_check;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::typescript::TypeName;
use sidekicks_contracts::wire::attachment::check_received;
use sidekicks_platforms::PinnedProcess;
use tokio::io::{AsyncRead, AsyncWriteExt as _, DuplexStream, ReadBuf, ReadHalf};
use tokio::task::JoinHandle;
use tokio_util::codec::{Encoder as _, Framed};
use tokio_util::sync::CancellationToken;

use super::connection::serve_connection;
use super::writer::Outbox;
use super::{GatewayServices, SupervisionDisconnectReason, SupervisionHooks, next_transport_id};
use crate::daemon::process::damage_gate::DispatchDamageWatch;
use sidekicks_ipc::call_fixtures::{
    NamedSubscribe, Nothing, SUBSCRIBE_METHOD, channel_feed, subscription_id,
};
use sidekicks_ipc::protocol_negotiation::{
    CallerAdmission, CallerAdmissionCheck, ProtocolNegotiator,
};
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, EncodedFeed, EncodedValue, HandlerContext, MethodRegistry,
    MethodRegistryBuilder, Reply, Request, TransportId,
};
use sidekicks_ipc::stream::feed::SendGate;
use sidekicks_ipc::stream::subscriptions::Subscriptions;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::damage::DatabaseDamageWatch;

mod call_cap;
mod close;
mod requests;
mod subscription_lanes;

/// The session token the tests' negotiator was started with.
const SESSION_TOKEN: &str = "the-session-token";

/// A mutation admitted in arrival order, its admit step logged.
struct OrderedWrite;

impl Method for OrderedWrite {
    type Params = Nothing;
    type Result = Nothing;
    const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
        method: "test.write",
        procedure_type: ProcedureType::Mutation,
        is_mutating: true,
        params: TypeName::of::<Nothing>(),
        result: TypeName::of::<Nothing>(),
        emission: None,
        refusals: &[],
        received_check: received_check::<Nothing>,
        check_params: check_received::<Nothing>,
        keyed: false,
        takes_call_slot: true,
    };
}

/// The dispatch every test connection runs: `test.wait` and the slotless `terminal.write` hold
/// their call until canceled, `test.big`, `test.large` and `test.huge` answer past one chunk, past
/// a lane's first credit and past the message cap, `test.subscribe`
/// answers the next prepared feed, a registered method goes to the registry, and any other method
/// answers its own name.
struct Script {
    registry: Arc<MethodRegistry>,
    feeds: Mutex<VecDeque<Box<dyn EncodedFeed>>>,
    /// Each dispatched call's method and cancellation, in dispatch order.
    dispatched: Mutex<Vec<(String, CancellationToken)>>,
    next_subscription: AtomicU64,
}

impl Script {
    fn prepare(&self, feed: Box<dyn EncodedFeed>) {
        lock(&self.feeds).push_back(feed);
    }

    fn dispatched(&self, method: &str) -> Vec<CancellationToken> {
        lock(&self.dispatched)
            .iter()
            .filter(|(dispatched, _token)| dispatched == method)
            .map(|(_method, token)| token.clone())
            .collect()
    }
}

impl Dispatch for Script {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        let method = request.method.clone();
        lock(&self.dispatched).push((method.clone(), context.cancellation.clone()));
        match method.as_str() {
            "test.wait" | "terminal.write" => async move {
                context.cancellation.cancelled().await;
                Err::<Reply, _>(DispatchError::Canceled)
            }
            .boxed(),
            "test.big" => ready_result(&json!({ "text": "b".repeat(70_000) })),
            "test.large" => ready_result(&json!({ "text": "l".repeat(300_000) })),
            "test.huge" => ready_result(&json!({ "text": "h".repeat(8 * 1024 * 1024) })),
            SUBSCRIBE_METHOD => {
                let number = self.next_subscription.fetch_add(1, Ordering::SeqCst);
                let subscription_id = subscription_id(u128::from(number));
                let feed = lock(&self.feeds)
                    .pop_front()
                    .expect("the test prepared a feed for each subscription");
                futures::future::ready(Ok(Reply::Subscription {
                    acknowledgment: encoded(&json!({ "subscriptionId": subscription_id })),
                    method: SUBSCRIBE_METHOD,
                    subscription_id,
                    feed,
                }))
                .boxed()
            }
            _ if self.registry.descriptor(&method).is_some() => {
                self.registry.dispatch(request, context)
            }
            _ => ready_result(&json!({ "method": method })),
        }
    }
}

fn ready_result(value: &Value) -> BoxFuture<'static, Result<Reply, DispatchError>> {
    futures::future::ready(Ok(Reply::Result(encoded(value)))).boxed()
}

fn encoded(value: &Value) -> EncodedValue {
    EncodedValue {
        json: serde_json::to_vec(value).expect("a test value writes"),
        attachments: Vec::new(),
    }
}

/// A feed with a value of `bytes` characters ready each time its gate opens.
struct RepeatingFeed {
    bytes: usize,
    taken: Arc<AtomicUsize>,
}

impl EncodedFeed for RepeatingFeed {
    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<EncodedValue>, DispatchError>> {
        async move {
            if gate.ready().await.is_err() {
                return Ok(None);
            }
            self.taken.fetch_add(1, Ordering::SeqCst);
            Ok(Some(encoded(&json!("r".repeat(self.bytes)))))
        }
        .boxed()
    }
}

/// One hook call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HookCall {
    Error(TransportId),
    Disconnect(TransportId, SupervisionDisconnectReason),
}

/// Hooks that record each call.
#[derive(Default)]
struct RecordedHooks {
    calls: Mutex<Vec<HookCall>>,
}

impl RecordedHooks {
    fn of(&self, transport: TransportId) -> Vec<HookCall> {
        lock(&self.calls)
            .iter()
            .filter(|call| match call {
                HookCall::Error(of) | HookCall::Disconnect(of, _) => *of == transport,
            })
            .copied()
            .collect()
    }
}

impl SupervisionHooks for RecordedHooks {
    fn on_disconnect(&self, transport: TransportId, reason: SupervisionDisconnectReason) {
        lock(&self.calls).push(HookCall::Disconnect(transport, reason));
    }

    fn on_error(&self, transport: TransportId, _error: &(dyn Error + 'static)) {
        lock(&self.calls).push(HookCall::Error(transport));
    }

    fn on_listener_error(&self, _error: &(dyn Error + 'static)) {}
}

/// What one test's connections share: the services, the script behind them, and the admit steps
/// `test.write` logged.
struct Harness {
    services: Arc<GatewayServices>,
    script: Arc<Script>,
    negotiator: Arc<ProtocolNegotiator>,
    hooks: Arc<RecordedHooks>,
    admitted: Arc<Mutex<Vec<String>>>,
}

fn harness() -> Harness {
    let admit_caller: CallerAdmissionCheck =
        Arc::new(|_process: PinnedProcess, _is_tokenless: bool| {
            futures::future::ready(Ok::<_, Arc<dyn Error + Send + Sync>>(
                CallerAdmission::TokenRequired,
            ))
            .boxed()
        });
    let negotiator = ProtocolNegotiator::new(SESSION_TOKEN.to_owned(), admit_caller);
    let subscriptions = Subscriptions::new(Arc::new(DispatchDamageWatch(Arc::new(
        DatabaseDamageWatch::new(),
    ))));
    let admitted = Arc::new(Mutex::new(Vec::new()));
    let mut builder = MethodRegistryBuilder::new();
    negotiator
        .register_handshake(&mut builder)
        .expect("the handshake registers");
    subscriptions
        .register_cancel(&mut builder)
        .expect("the cancel call registers");
    // The gateway reads only the method's kind; the script answers its calls.
    builder
        .register_subscription::<NamedSubscribe, _>(|_named, _context, _subscription_id| {
            futures::future::pending().boxed()
        })
        .expect("the subscribe method registers");
    let log = Arc::clone(&admitted);
    builder
        .register_ordered::<OrderedWrite, _, _, _>(
            move |_context: &HandlerContext, _params: &Nothing| {
                lock(&log).push("test.write".to_owned());
                Ok(())
            },
            |()| async { Ok(Nothing {}) }.boxed(),
        )
        .expect("the ordered write registers");
    let registry = Arc::new(builder.freeze());
    let script = Arc::new(Script {
        registry: Arc::clone(&registry),
        feeds: Mutex::new(VecDeque::new()),
        dispatched: Mutex::new(Vec::new()),
        next_subscription: AtomicU64::new(0),
    });
    let hooks = Arc::new(RecordedHooks::default());
    let dispatch: Arc<dyn Dispatch> = Arc::clone(&script) as Arc<dyn Dispatch>;
    let services = Arc::new(GatewayServices {
        device_id: Some(DeviceId::new("device".to_owned()).expect("the id is well formed")),
        dispatch,
        registry,
        negotiator: Arc::clone(&negotiator),
        subscriptions,
        hooks: Arc::clone(&hooks) as Arc<dyn SupervisionHooks>,
    });
    Harness {
        services,
        script,
        negotiator,
        hooks,
        admitted,
    }
}

/// The daemon's reading side, whose end of stream reads as a failed read when `fails_at_end`.
struct DaemonReader {
    inner: ReadHalf<DuplexStream>,
    fails_at_end: bool,
}

impl AsyncRead for DaemonReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let filled = buffer.filled().len();
        ready!(Pin::new(&mut self.inner).poll_read(context, buffer))?;
        if self.fails_at_end && buffer.filled().len() == filled {
            return Poll::Ready(Err(io::Error::from(io::ErrorKind::ConnectionReset)));
        }
        Poll::Ready(Ok(()))
    }
}

/// One served connection and the client at its other end.
struct Connection {
    client: TestClient,
    transport: TransportId,
    outbox: Arc<Outbox>,
    stop: CancellationToken,
    serving: JoinHandle<()>,
}

impl Harness {
    /// A connection whose stream holds `buffer` bytes each way.
    fn connect(&self, buffer: usize) -> Connection {
        self.connect_with(buffer, false)
    }

    fn connect_with(&self, buffer: usize, read_fails_at_end: bool) -> Connection {
        let (client_side, daemon_side) = tokio::io::duplex(buffer);
        let (read_half, write_half) = tokio::io::split(daemon_side);
        let reader = DaemonReader {
            inner: read_half,
            fails_at_end: read_fails_at_end,
        };
        let transport = next_transport_id();
        let outbox = Outbox::new();
        let stop = CancellationToken::new();
        let serving = tokio::spawn(serve_connection(
            tokio::io::join(reader, write_half),
            Arc::clone(&outbox),
            transport,
            None,
            Arc::clone(&self.services),
            stop.clone(),
        ));
        Connection {
            client: TestClient::new(client_side),
            transport,
            outbox,
            stop,
            serving,
        }
    }
}

/// What the client read.
#[derive(Debug)]
enum Event {
    Message {
        lane: LaneId,
        json: Value,
        closes_lane: bool,
    },
    Abort(LaneId),
}

/// One frame the client read: its lane, its body's bytes and whether it ended a message; an ABORT
/// is `None` bytes.
#[derive(Clone, Copy, Debug)]
struct Seen {
    lane: LaneId,
    bytes: Option<usize>,
    is_end: bool,
}

/// A client of the frame codec: it reassembles the daemon's messages and, when it grants credit,
/// returns each message's credit as it takes it.
struct TestClient {
    frames: Framed<DuplexStream, FrameCodec>,
    incoming: IncomingLanes,
    outgoing: OutgoingLanes,
    grants_credit: bool,
    seen: Vec<Seen>,
}

impl TestClient {
    fn new(stream: DuplexStream) -> Self {
        Self {
            frames: Framed::new(stream, FrameCodec),
            incoming: IncomingLanes::default(),
            outgoing: OutgoingLanes::default(),
            grants_credit: true,
            seen: Vec::new(),
        }
    }

    /// Sends `messages` on lane 0 in one write, within the credit the daemon granted, so the
    /// daemon finds them all at its next read; answers the credit they spent. Fails the test past
    /// the credit.
    async fn send_all(&mut self, messages: &[Value]) -> usize {
        let mut bytes = BytesMut::new();
        let mut spent = 0;
        for json in messages {
            let message = MessageBody {
                json: Bytes::from(serde_json::to_vec(json).expect("a test message writes")),
                attachments: Vec::new(),
            }
            .encode()
            .expect("a test message is within its caps");
            for frame in Frame::data_chunks(LaneId::CONTROL, message, MAX_CHUNK_BYTES, false) {
                if let Frame::Data { body, .. } = &frame {
                    let length = u32::try_from(body.len()).expect("a chunk fits a u32");
                    assert!(
                        self.outgoing.spend(LaneId::CONTROL, length),
                        "the daemon returned the credit this message needs"
                    );
                    spent += body.len();
                }
                FrameCodec
                    .encode(frame, &mut bytes)
                    .expect("a test frame encodes");
            }
        }
        self.write_raw(&bytes).await;
        spent
    }

    /// Sends one message on lane 0; answers the credit it spent.
    async fn send(&mut self, json: &Value) -> usize {
        self.send_all(std::slice::from_ref(json)).await
    }

    async fn send_frame(&mut self, frame: Frame) {
        within(self.frames.send(frame))
            .await
            .expect("the frame is written");
    }

    async fn write_raw(&mut self, bytes: &[u8]) {
        within(self.frames.get_mut().write_all(bytes))
            .await
            .expect("the bytes are written");
    }

    /// The next whole message or ABORT; CREDIT frames grant this client's lanes on the way.
    async fn next_event(&mut self) -> Event {
        loop {
            if let Some(event) = within(self.read_frame()).await {
                return event;
            }
        }
    }

    /// Reads one frame: a CREDIT grants this client's lane, a DATA frame that ends a message
    /// answers it, an ABORT answers itself.
    async fn read_frame(&mut self) -> Option<Event> {
        let frame = self
            .frames
            .next()
            .await
            .expect("the connection is open")
            .expect("the daemon's frames decode");
        let (lane, closes_lane) = match &frame {
            Frame::Credit { lane, granted } => {
                self.outgoing.grant(*lane, *granted);
                return None;
            }
            Frame::Abort { lane, .. } => {
                self.seen.push(Seen {
                    lane: *lane,
                    bytes: None,
                    is_end: false,
                });
                self.incoming
                    .receive(frame.clone())
                    .expect("the daemon's ABORT is well formed");
                self.release_owed().await;
                return Some(Event::Abort(*lane));
            }
            Frame::Data {
                lane,
                is_end,
                closes_lane,
                body,
            } => {
                self.seen.push(Seen {
                    lane: *lane,
                    bytes: Some(body.len()),
                    is_end: *is_end,
                });
                (*lane, *closes_lane)
            }
        };
        let received = self
            .incoming
            .receive(frame)
            .expect("the daemon keeps to its credit and lane order");
        self.release_owed().await;
        let message = received?;
        if let Some(credit) = self.incoming.take(message.lane, message.credit_due) {
            self.grant(credit).await;
        }
        let json: Value = serde_json::from_slice(&message.body.json).expect("a message is JSON");
        // A subscription's acknowledgment admits the lane its stream opens next.
        if lane.is_control() && json["result"]["subscriptionId"].is_string() {
            self.incoming.admit_lane();
        }
        Some(Event::Message {
            lane,
            json,
            closes_lane,
        })
    }

    /// Releases owed credit into this client's own count, whether or not it is sent.
    async fn release_owed(&mut self) {
        for credit in self.incoming.release_owed() {
            self.grant(credit).await;
        }
    }

    async fn grant(&mut self, credit: LaneCredit) {
        if self.grants_credit {
            self.send_frame(credit.into()).await;
        }
    }

    /// The next message, which must be on lane 0.
    async fn answer(&mut self) -> Value {
        match self.next_event().await {
            Event::Message { lane, json, .. } if lane.is_control() => json,
            other @ (Event::Message { .. } | Event::Abort(_)) => {
                panic!("expected a message on lane 0, got {other:?}")
            }
        }
    }

    /// The next notification on a subscription's lane, and that lane.
    async fn notification(&mut self) -> (LaneId, Value) {
        match self.next_event().await {
            Event::Message { lane, json, .. } if !lane.is_control() => (lane, json),
            other @ (Event::Message { .. } | Event::Abort(_)) => {
                panic!("expected a message on a subscription's lane, got {other:?}")
            }
        }
    }

    /// Reads every frame the daemon writes until it writes no more.
    async fn read_until_quiet(&mut self) {
        while tokio::time::timeout(Duration::from_secs(1), self.read_frame())
            .await
            .is_ok()
        {}
    }
}

/// `future`, failing the test when it does not finish once the runtime is idle.
async fn within<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("the step finishes")
}

/// Lets every task run until all of them wait.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// A request to `method` under `id`, with the envelope's protocol version.
fn call(id: impl Into<Value>, method: &str, params: &Value) -> Value {
    let id = id.into();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
    })
}

/// `$/cancelRequest` for the call `id`.
fn cancel_request(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": id } })
}

/// A subscribe call under `id`.
fn subscribe(id: u64) -> Value {
    call(id, SUBSCRIBE_METHOD, &json!({ "name": "a" }))
}

/// Asserts `answer` is the whole refusal envelope: its id, numeric code, refusal code, category
/// and fields.
fn assert_refusal(
    answer: &Value,
    id: &Value,
    code: i64,
    refusal: &str,
    category: &str,
    fields: Option<&Value>,
) {
    assert_eq!(&answer["id"], id, "{answer}");
    assert_eq!(answer["error"]["code"], json!(code), "{answer}");
    assert_eq!(answer["error"]["data"]["type"], json!(refusal), "{answer}");
    assert_eq!(
        answer["error"]["data"]["category"],
        json!(category),
        "{answer}"
    );
    assert_eq!(answer["error"]["data"].get("fields"), fields, "{answer}");
}

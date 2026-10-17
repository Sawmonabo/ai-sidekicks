//! Protocol negotiation: the `connection.initialize` exchange and the gate in front of every other
//! call. A connection is served nothing until a hello carrying this start's session token has
//! completed, and no mutating call after an incompatible one.
//!
//! A hello without the token, or with a wrong one, latches the connection refused, so nothing more
//! is served on it, a second guess included. A hello with the token latches it refused too when
//! its caller is an agent's: a process the daemon started outside the person's terminals, one a
//! provider service the daemon holds a connection to started, or one the system could not name or
//! trace. Reading the token file is not enough to be the machine's own client. Each connection's
//! first outcome is latched, so a repeated or hostile hello cannot flip the gate.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sidekicks_contracts::daemon::recovery::{DaemonRepairProgress, DaemonRepairingDetails};
use sidekicks_contracts::jsonrpc::negotiation::{
    DAEMON_HELLO_METHOD, DaemonHandshake, DaemonHello, DaemonHelloAck,
    NegotiationIncompatibleReason, NegotiationText, ProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS,
    SUPPORTED_PROTOCOLS_MAX_LEN,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::list::BoundedVec;
use subtle::ConstantTimeEq as _;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode};
use crate::ipc::registry::{
    Dispatch, DispatchError, HandlerContext, HandlerError, MethodRegistry, MethodRegistryBuilder,
    RegistrationError, Reply, Request, TransportId,
};

/// Answers whether a hello carrying the session token from the process with this id is still
/// refused because the process is an agent's; a failed read answers the hello `-32603`.
pub(crate) type RefusedCallerCheck = Arc<
    dyn Fn(u32) -> BoxFuture<'static, Result<bool, Arc<dyn Error + Send + Sync>>> + Send + Sync,
>;

/// Reads how far a database file's repair has come; `None` while the step it is on gives no count.
pub(crate) type RepairProgressReader = Arc<dyn Fn() -> Option<DaemonRepairProgress> + Send + Sync>;

/// A connection's caller read, shared by every hello on it.
type CallerRead = Shared<BoxFuture<'static, Result<bool, Arc<dyn Error + Send + Sync>>>>;

/// The daemon's own versions, read once from the contract's list, as the incompatible ack lists
/// them.
static DAEMON_VERSIONS: LazyLock<BoundedVec<ProtocolVersion, 0, SUPPORTED_PROTOCOLS_MAX_LEN>> =
    LazyLock::new(|| {
        let versions = SUPPORTED_PROTOCOL_VERSIONS
            .iter()
            .map(|version| {
                ProtocolVersion::new((*version).to_owned())
                    .expect("the daemon's own protocol versions are dates")
            })
            .collect();
        BoundedVec::new(versions).expect("the daemon speaks no more versions than a list may carry")
    });

/// The message every refusal of a connection without the session token carries, so a refusal says
/// nothing about the token.
const TOKEN_INVALID_MESSAGE: &str = "The connection's connection.initialize lacked this daemon's session token, so nothing is served on it";

/// The message of a refusal of an agent's connection, or one the system could not name.
const CALLER_REFUSED_MESSAGE: &str = "The connection was opened by a process this daemon or a \
     provider service it reaches started, such as a command an agent ran, or by one the system \
     could not name or trace, so nothing is served on it";

/// The message of a call before the connection's hello; it never names the call.
const HANDSHAKE_REQUIRED_MESSAGE: &str =
    "The call was refused because the connection has not completed connection.initialize";

/// The message of a mutating call after an incompatible hello; it never names the call.
const VERSION_MISMATCH_MESSAGE: &str =
    "The mutating call was refused because the connection's connection.initialize was incompatible";

/// The message of a hello answered while the service repairs its database file.
const REPAIRING_MESSAGE: &str =
    "The service is repairing its database file and answers once the repair has ended";

/// Why a connection is latched refused.
#[derive(Clone, Copy)]
enum ConnectionRefusal {
    /// Its hello carried no session token or a wrong one.
    TokenInvalid,
    /// Its hello came from an agent's process, or one the system could not name.
    CallerRefused,
}

impl ConnectionRefusal {
    fn error(self) -> DomainError {
        match self {
            Self::TokenInvalid => DomainError::new(
                TOKEN_INVALID_MESSAGE,
                RefusalCode::AuthTokenInvalid,
                DomainErrorJsonRpcCode::InvalidRequest,
            ),
            Self::CallerRefused => DomainError::new(
                CALLER_REFUSED_MESSAGE,
                RefusalCode::AuthCallerRefused,
                DomainErrorJsonRpcCode::InvalidRequest,
            ),
        }
    }
}

/// A connection's latched handshake.
#[derive(Clone)]
enum LatchedHandshake {
    /// The client and the daemon share `version`, the newest both speak.
    Compatible { version: ProtocolVersion },
    /// They share none: `daemon_newest` is the version the client may retry against.
    Incompatible {
        daemon_newest: ProtocolVersion,
        reason: NegotiationIncompatibleReason,
    },
}

/// One connection's negotiation; a connection with no entry is before its hello.
enum ConnectionNegotiation {
    /// A hello with the token is reading its caller; nothing is latched yet.
    ReadingCaller(CallerRead),
    /// Nothing is served on the connection.
    Refused(ConnectionRefusal),
    /// The first hello's outcome.
    Latched(LatchedHandshake),
}

/// Which hello on its connection a handshake answers.
enum HelloTurn {
    /// The hello that latched it.
    First(LatchedHandshake),
    /// A later hello, which finds the first latched.
    Repeat(LatchedHandshake),
}

/// A hello the daemon could not answer: a fault, never the client's.
#[derive(Debug, thiserror::Error)]
#[error("the connection's caller process could not be read")]
struct CallerReadFault(#[source] Arc<dyn Error + Send + Sync>);

/// Keeps each connection's negotiation and answers `connection.initialize`. The gateway calls
/// `cleanup_transport` as each connection closes, or the state keeps one entry per connection.
pub(crate) struct ProtocolNegotiator {
    /// The token this start wrote to its token file.
    session_token: String,
    /// Whether a hello with the token from a process is still refused.
    is_refused_caller: RefusedCallerCheck,
    /// Each connection's negotiation.
    connections: Mutex<HashMap<TransportId, ConnectionNegotiation>>,
}

impl ProtocolNegotiator {
    /// A negotiator for this start: `session_token` is the token it wrote to its token file, and
    /// `is_refused_caller` answers whether a hello carrying it from a process is still refused.
    pub(crate) fn new(session_token: String, is_refused_caller: RefusedCallerCheck) -> Arc<Self> {
        Arc::new(Self {
            session_token,
            is_refused_caller,
            connections: Mutex::new(HashMap::new()),
        })
    }

    /// Registers `connection.initialize` on `registry`; fails as any second registration of it
    /// does. The hello is a read, so a client whose handshake was incompatible can repeat it and
    /// read the latched answer.
    pub(crate) fn register_handshake(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
    ) -> Result<(), RegistrationError> {
        let negotiator = Arc::clone(self);
        registry.register::<DaemonHandshake, _>(move |hello, context| {
            Arc::clone(&negotiator).answer_hello(hello, context).boxed()
        })
    }

    /// Registers the `connection.initialize` of a service still repairing its database file: a
    /// hello with the token is refused `daemon.repairing` with the progress `read_progress` reads,
    /// every time, and latches the handshake as any hello does, so the gate lets that connection's
    /// lifecycle calls through; one without the token is refused as any wrong token is.
    pub(crate) fn register_repairing_handshake(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
        read_progress: RepairProgressReader,
    ) -> Result<(), RegistrationError> {
        let negotiator = Arc::clone(self);
        registry.register::<DaemonHandshake, _>(move |hello, context| {
            Arc::clone(&negotiator)
                .answer_repairing_hello(hello, context, Arc::clone(&read_progress))
                .boxed()
        })
    }

    /// The gate over `next`, refusing each call this negotiator's state refuses; `registry` is the
    /// frozen registry whose entries say which method mutates.
    pub(crate) fn gate(
        self: &Arc<Self>,
        next: Arc<dyn Dispatch>,
        registry: Arc<MethodRegistry>,
    ) -> NegotiationGate {
        NegotiationGate {
            negotiator: Arc::clone(self),
            next,
            registry,
        }
    }

    /// Drops the closed connection's state, so a caller read that ends after the close latches
    /// nothing; a no-op for a connection with none.
    pub(crate) fn cleanup_transport(&self, transport: TransportId) {
        self.connections().remove(&transport);
    }

    /// The refusal the gate answers `method` with on `transport`, or `None` when it passes.
    fn refusal_of(
        &self,
        method: &str,
        transport: TransportId,
        registry: &MethodRegistry,
    ) -> Option<DomainError> {
        match self.connections().get(&transport) {
            Some(ConnectionNegotiation::Refused(refusal)) => Some(refusal.error()),
            None | Some(ConnectionNegotiation::ReadingCaller(_)) => (method != DAEMON_HELLO_METHOD)
                .then(|| {
                    DomainError::new(
                        HANDSHAKE_REQUIRED_MESSAGE,
                        RefusalCode::ProtocolHandshakeRequired,
                        DomainErrorJsonRpcCode::InvalidRequest,
                    )
                }),
            // An unregistered method passes, so the registry answers that it is not served.
            Some(ConnectionNegotiation::Latched(LatchedHandshake::Incompatible {
                reason, ..
            })) => registry
                .descriptor(method)
                .is_some_and(|descriptor| descriptor.is_mutating)
                .then(|| version_mismatch(*reason)),
            Some(ConnectionNegotiation::Latched(LatchedHandshake::Compatible { .. })) => None,
        }
    }

    async fn answer_hello(
        self: Arc<Self>,
        hello: DaemonHello,
        context: HandlerContext,
    ) -> Result<DaemonHelloAck, HandlerError> {
        let turn = match self.latched(context.transport_id) {
            Some(handshake) => HelloTurn::Repeat(handshake),
            None => self.latch_handshake(&hello, &context).await?,
        };
        Ok(acknowledgement(turn, context.device_id))
    }

    async fn answer_repairing_hello(
        self: Arc<Self>,
        hello: DaemonHello,
        context: HandlerContext,
        read_progress: RepairProgressReader,
    ) -> Result<DaemonHelloAck, HandlerError> {
        if self.latched(context.transport_id).is_none() {
            self.latch_handshake(&hello, &context).await?;
        } else if !self.is_session_token(hello.session_token.as_ref()) {
            return Err(ConnectionRefusal::TokenInvalid.error().into());
        }
        // A hello always fails, so a client keeps waiting for the repair to end.
        Err(DomainError::new(
            REPAIRING_MESSAGE,
            RefusalCode::DaemonRepairing,
            DomainErrorJsonRpcCode::InvalidRequest,
        )
        .with_detail(DaemonRepairingDetails {
            progress: read_progress(),
        })
        .into())
    }

    /// Refuses a hello without this start's token, then one from a caller the daemon refuses or
    /// the system could not name, latching the refusal; otherwise latches the version the hello
    /// negotiates. A hello whose connection closed during its caller read latches nothing, a
    /// refusal latched meanwhile wins, and a second hello during the read finds the first latched.
    async fn latch_handshake(
        &self,
        hello: &DaemonHello,
        context: &HandlerContext,
    ) -> Result<HelloTurn, HandlerError> {
        let transport = context.transport_id;
        if !self.is_session_token(hello.session_token.as_ref()) {
            return Err(self
                .refuse(transport, ConnectionRefusal::TokenInvalid)
                .into());
        }
        let Some(caller_process_id) = context.caller_process_id else {
            return Err(self
                .refuse(transport, ConnectionRefusal::CallerRefused)
                .into());
        };
        let caller_read = {
            let mut connections = self.connections();
            match connections.get(&transport) {
                Some(ConnectionNegotiation::Refused(refusal)) => {
                    return Err(refusal.error().into());
                }
                Some(ConnectionNegotiation::Latched(handshake)) => {
                    return Ok(HelloTurn::Repeat(handshake.clone()));
                }
                Some(ConnectionNegotiation::ReadingCaller(caller_read)) => caller_read.clone(),
                None => {
                    let caller_read = (self.is_refused_caller)(caller_process_id).shared();
                    connections.insert(
                        transport,
                        ConnectionNegotiation::ReadingCaller(caller_read.clone()),
                    );
                    caller_read
                }
            }
        };
        let is_refused_caller = caller_read
            .await
            .map_err(|error| HandlerError::Internal(Box::new(CallerReadFault(error))))?;
        let mut connections = self.connections();
        match connections.get(&transport) {
            // An ordinary disconnect: nothing can be sent, and no fault is logged.
            None => {
                tracing::debug!("A connection closed while its caller process was read");
                Err(HandlerError::Canceled)
            }
            Some(ConnectionNegotiation::Refused(refusal)) => Err(refusal.error().into()),
            Some(ConnectionNegotiation::ReadingCaller(_) | ConnectionNegotiation::Latched(_))
                if is_refused_caller =>
            {
                connections.insert(
                    transport,
                    ConnectionNegotiation::Refused(ConnectionRefusal::CallerRefused),
                );
                Err(ConnectionRefusal::CallerRefused.error().into())
            }
            Some(ConnectionNegotiation::Latched(handshake)) => {
                Ok(HelloTurn::Repeat(handshake.clone()))
            }
            Some(ConnectionNegotiation::ReadingCaller(_)) => {
                let handshake = negotiate(hello);
                connections.insert(transport, ConnectionNegotiation::Latched(handshake.clone()));
                Ok(HelloTurn::First(handshake))
            }
        }
    }

    /// Latches `transport` refused and answers the refusal.
    fn refuse(&self, transport: TransportId, refusal: ConnectionRefusal) -> DomainError {
        self.connections()
            .insert(transport, ConnectionNegotiation::Refused(refusal));
        refusal.error()
    }

    fn latched(&self, transport: TransportId) -> Option<LatchedHandshake> {
        match self.connections().get(&transport) {
            Some(ConnectionNegotiation::Latched(handshake)) => Some(handshake.clone()),
            Some(ConnectionNegotiation::ReadingCaller(_) | ConnectionNegotiation::Refused(_))
            | None => None,
        }
    }

    /// Whether `presented` is this start's token, compared in constant time.
    fn is_session_token(&self, presented: Option<&NegotiationText>) -> bool {
        presented.is_some_and(|presented| {
            bool::from(
                presented
                    .as_str()
                    .as_bytes()
                    .ct_eq(self.session_token.as_bytes()),
            )
        })
    }

    fn connections(&self) -> MutexGuard<'_, HashMap<TransportId, ConnectionNegotiation>> {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// The negotiation gate: refuses every call on a refused connection, every call but
/// `connection.initialize` before a hello completed, and every mutating call after an incompatible
/// one, each `-32600` with a fixed message; anything else goes to the next dispatch.
pub(crate) struct NegotiationGate {
    negotiator: Arc<ProtocolNegotiator>,
    next: Arc<dyn Dispatch>,
    registry: Arc<MethodRegistry>,
}

impl Dispatch for NegotiationGate {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        match self
            .negotiator
            .refusal_of(&request.method, context.transport_id, &self.registry)
        {
            Some(refusal) => futures::future::ready(Err(DispatchError::Refused(refusal))).boxed(),
            None => self.next.dispatch(request, context),
        }
    }
}

/// The refusal of a mutating call after an incompatible hello, carrying its `reason`.
fn version_mismatch(reason: NegotiationIncompatibleReason) -> DomainError {
    DomainError::new(
        VERSION_MISMATCH_MESSAGE,
        RefusalCode::ProtocolVersionMismatch,
        DomainErrorJsonRpcCode::InvalidRequest,
    )
    .with_detail(json!({ "reason": reason }))
}

/// The version `hello` and the daemon agree on, the newest both speak, or why there is none:
/// `floor` when every version the client offers is older than the daemon's oldest, else `ceiling`.
fn negotiate(hello: &DaemonHello) -> LatchedHandshake {
    let offered = match &hello.supported_protocols {
        Some(supported) => supported.as_slice(),
        None => std::slice::from_ref(&hello.protocol_version),
    };
    let daemon_versions = DAEMON_VERSIONS.as_slice();
    let agreed = offered
        .iter()
        .filter(|version| daemon_versions.contains(*version))
        .max();
    if let Some(version) = agreed {
        return LatchedHandshake::Compatible {
            version: version.clone(),
        };
    }
    let daemon_oldest = daemon_versions
        .iter()
        .min()
        .expect("the daemon speaks at least one version");
    let daemon_newest = daemon_versions
        .iter()
        .max()
        .expect("the daemon speaks at least one version");
    let reason = if offered.iter().all(|version| version < daemon_oldest) {
        NegotiationIncompatibleReason::FloorExceeded
    } else {
        NegotiationIncompatibleReason::CeilingExceeded
    };
    LatchedHandshake::Incompatible {
        daemon_newest: daemon_newest.clone(),
        reason,
    }
}

/// The ack of a hello: a repeat gets `handshake_already_completed` with the first's version; an
/// incompatible first gets its reason and the daemon's versions.
fn acknowledgement(turn: HelloTurn, device_id: DeviceId) -> DaemonHelloAck {
    let (compatible, protocol_version, reason, daemon_supported_protocols) = match turn {
        HelloTurn::Repeat(
            LatchedHandshake::Compatible { version }
            | LatchedHandshake::Incompatible {
                daemon_newest: version,
                ..
            },
        ) => (
            false,
            version,
            Some(NegotiationIncompatibleReason::HandshakeAlreadyCompleted),
            None,
        ),
        HelloTurn::First(LatchedHandshake::Compatible { version }) => (true, version, None, None),
        HelloTurn::First(LatchedHandshake::Incompatible {
            daemon_newest,
            reason,
        }) => (
            false,
            daemon_newest,
            Some(reason),
            Some(DAEMON_VERSIONS.clone()),
        ),
    };
    DaemonHelloAck {
        compatible,
        protocol_version,
        device_id,
        reason,
        server_capabilities: None,
        daemon_supported_protocols,
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::Arc;

    use futures::FutureExt as _;
    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::jsonrpc::negotiation::{
        CURRENT_PROTOCOL_VERSION, DAEMON_HELLO_METHOD, DaemonHelloAck,
        NegotiationIncompatibleReason,
    };
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
    use sidekicks_contracts::schema::received_check;
    use sidekicks_contracts::typescript::TypeName;
    use tokio::sync::{Notify, mpsc};

    use super::{NegotiationGate, ProtocolNegotiator, RefusedCallerCheck};
    use crate::ipc::call_fixtures::{Nothing, context};
    use crate::ipc::domain_error::DomainErrorJsonRpcCode;
    use crate::ipc::registry::{
        Dispatch, DispatchError, HandlerContext, MethodRegistryBuilder, Reply, Request,
    };

    const SESSION_TOKEN: &str = "the-session-token";

    /// A method that reads (`false`) or mutates (`true`).
    struct Probe<const IS_MUTATING: bool>;

    impl<const IS_MUTATING: bool> Method for Probe<IS_MUTATING> {
        type Params = Nothing;
        type Result = Nothing;
        const DESCRIPTOR: MethodDescriptor = MethodDescriptor {
            method: if IS_MUTATING {
                "test.write"
            } else {
                "test.read"
            },
            procedure_type: if IS_MUTATING {
                ProcedureType::Mutation
            } else {
                ProcedureType::Query
            },
            is_mutating: IS_MUTATING,
            params: TypeName::of::<Nothing>(),
            result: TypeName::of::<Nothing>(),
            emission: None,
            refusals: &[],
            received_check: received_check::<Nothing>,
        };
    }

    /// One call on the connection.
    #[derive(Clone, Copy, Debug)]
    enum Call {
        /// A hello with this token, offering this one version.
        Hello(&'static str, &'static str),
        Read,
        Write,
    }

    /// What the call answers.
    #[derive(Clone, Copy, Debug)]
    enum Answer {
        /// A hello's ack: whether compatible, and its reason.
        Ack(bool, Option<NegotiationIncompatibleReason>),
        /// A read's or a write's result.
        Served,
        Refused(RefusalCode),
    }

    fn request(call: Call) -> Request {
        let (method, params) = match call {
            Call::Hello(token, version) => (
                DAEMON_HELLO_METHOD,
                json!({ "protocolVersion": version, "sessionToken": token }),
            ),
            Call::Read => ("test.read", json!({})),
            Call::Write => ("test.write", json!({})),
        };
        Request {
            method: method.to_owned(),
            params: Some(RawValue::from_string(params.to_string()).expect("the params are JSON")),
            attachments: Vec::new(),
        }
    }

    /// The negotiation gate over a registry serving the hello, a read and a write, its callers
    /// checked by `is_refused_caller`.
    fn gate_over(is_refused_caller: RefusedCallerCheck) -> NegotiationGate {
        let negotiator = ProtocolNegotiator::new(SESSION_TOKEN.to_owned(), is_refused_caller);
        let mut builder = MethodRegistryBuilder::new();
        negotiator
            .register_handshake(&mut builder)
            .expect("the hello registers");
        builder
            .register::<Probe<false>, _>(|nothing, _context| async move { Ok(nothing) }.boxed())
            .expect("the read registers");
        builder
            .register::<Probe<true>, _>(|nothing, _context| async move { Ok(nothing) }.boxed())
            .expect("the write registers");
        let registry = Arc::new(builder.freeze());
        negotiator.gate(Arc::clone(&registry) as Arc<dyn Dispatch>, registry)
    }

    /// The context of a call on connection 1 from the process `caller_process_id`.
    fn caller_context(caller_process_id: Option<u32>) -> HandlerContext {
        HandlerContext {
            caller_process_id,
            ..context(1)
        }
    }

    #[rstest]
    #[case::wrong_token_latches_refused(Some(7), false, &[
        (Call::Hello("a-wrong-token", CURRENT_PROTOCOL_VERSION),
            Answer::Refused(RefusalCode::AuthTokenInvalid)),
        (Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
            Answer::Refused(RefusalCode::AuthTokenInvalid)),
        (Call::Read, Answer::Refused(RefusalCode::AuthTokenInvalid)),
    ])]
    #[case::floor(Some(7), false, &[
        (Call::Hello(SESSION_TOKEN, "2000-01-01"),
            Answer::Ack(false, Some(NegotiationIncompatibleReason::FloorExceeded))),
        (Call::Write, Answer::Refused(RefusalCode::ProtocolVersionMismatch)),
        (Call::Read, Answer::Served),
    ])]
    #[case::ceiling(Some(7), false, &[
        (Call::Hello(SESSION_TOKEN, "2999-12-31"),
            Answer::Ack(false, Some(NegotiationIncompatibleReason::CeilingExceeded))),
        (Call::Write, Answer::Refused(RefusalCode::ProtocolVersionMismatch)),
        (Call::Read, Answer::Served),
    ])]
    #[case::compatible(Some(7), false, &[
        (Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION), Answer::Ack(true, None)),
        (Call::Write, Answer::Served),
        (Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
            Answer::Ack(false, Some(NegotiationIncompatibleReason::HandshakeAlreadyCompleted))),
    ])]
    #[case::before_the_hello(Some(7), false, &[
        (Call::Read, Answer::Refused(RefusalCode::ProtocolHandshakeRequired)),
        (Call::Write, Answer::Refused(RefusalCode::ProtocolHandshakeRequired)),
    ])]
    #[case::agent_process(Some(7), true, &[
        (Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
            Answer::Refused(RefusalCode::AuthCallerRefused)),
        (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
    ])]
    #[case::unnamed_caller(None, false, &[
        (Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
            Answer::Refused(RefusalCode::AuthCallerRefused)),
        (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
    ])]
    #[tokio::test]
    async fn the_gate_and_the_hello_answer_each_connection_state(
        #[case] caller_process_id: Option<u32>,
        #[case] is_agent_process: bool,
        #[case] calls: &[(Call, Answer)],
    ) {
        let gate = gate_over(Arc::new(move |_process_id: u32| {
            futures::future::ready(Ok::<_, Arc<dyn Error + Send + Sync>>(is_agent_process)).boxed()
        }));
        for &(call, expected) in calls {
            let answer = gate
                .dispatch(request(call), caller_context(caller_process_id))
                .await;
            match (answer, expected) {
                (Ok(Reply::Result(encoded)), Answer::Ack(compatible, reason)) => {
                    let ack: DaemonHelloAck =
                        serde_json::from_slice(&encoded.json).expect("the ack is JSON");
                    assert_eq!(
                        (ack.compatible, ack.reason),
                        (compatible, reason),
                        "{call:?}"
                    );
                }
                (Ok(Reply::Result(_)), Answer::Served) => {}
                (Err(DispatchError::Refused(refusal)), Answer::Refused(code)) => {
                    assert_eq!(refusal.code, code, "{call:?}");
                    assert_eq!(
                        refusal.json_rpc_code,
                        DomainErrorJsonRpcCode::InvalidRequest
                    );
                    assert!(
                        !refusal.message.contains("test."),
                        "the message names no method"
                    );
                }
                (Err(error), _) => panic!("{call:?}: expected {expected:?}, got {error:?}"),
                (Ok(_), _) => panic!("{call:?}: expected {expected:?}, got another reply"),
            }
        }
    }

    #[tokio::test]
    async fn a_refusal_latched_during_the_caller_read_wins_over_its_success() {
        let (read_started, mut has_read_started) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let read_release = Arc::clone(&release);
        let gate = gate_over(Arc::new(move |_process_id: u32| {
            read_started.send(()).expect("the test listens");
            let release = Arc::clone(&read_release);
            async move {
                release.notified().await;
                Ok::<_, Arc<dyn Error + Send + Sync>>(false)
            }
            .boxed()
        }));

        let hello = tokio::spawn(gate.dispatch(
            request(Call::Hello(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION)),
            caller_context(Some(7)),
        ));
        has_read_started
            .recv()
            .await
            .expect("the caller read starts");
        let wrong = gate
            .dispatch(
                request(Call::Hello("a-wrong-token", CURRENT_PROTOCOL_VERSION)),
                caller_context(Some(7)),
            )
            .await;
        assert!(matches!(
            wrong,
            Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
        ));

        // The read then finds the caller is no agent's, and the latched refusal still answers.
        release.notify_one();
        let answer = hello.await.expect("the hello ran");
        assert!(matches!(
            answer,
            Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
        ));
        let read = gate
            .dispatch(request(Call::Read), caller_context(Some(7)))
            .await;
        assert!(matches!(
            read,
            Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
        ));
    }
}

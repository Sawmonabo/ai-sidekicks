//! Protocol negotiation: the `connection.initialize` exchange and the gate in front of every other
//! call. A connection is served nothing until a handshake from the person's own client has
//! completed, and no mutating call after an incompatible one.
//!
//! The caller is checked first: an agent's process (one the daemon started outside the person's
//! terminals, or one a provider service the daemon holds a connection to started), or one the
//! system could not name or trace, latches the connection refused whatever the handshake carries,
//! so reading the token file is not enough to be the machine's own client. Then a handshake with
//! this start's session token is admitted (the command line), and one without a token is admitted
//! when its caller is the desktop's signed client; any other latches the connection refused. Each
//! connection's first handshake decides it: a handshake sent while the first's caller check runs
//! waits for that outcome and gets it, so a wrong token followed by the right one is refused, and a
//! repeated or hostile handshake cannot flip the gate. A repeat on an admitted connection is
//! answered only when it carries the token, or none on a connection its caller's signature
//! admitted; any other is refused `auth.token.invalid` and changes nothing latched.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sidekicks_contracts::daemon::recovery::{DaemonRepairProgress, DaemonRepairingDetails};
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, ConnectionInitializeRequest, ConnectionInitializeResponse,
    DaemonHandshake, NegotiationIncompatibleReason, NegotiationText, ProtocolVersion,
    SUPPORTED_PROTOCOL_VERSIONS, SUPPORTED_PROTOCOLS_MAX_LEN,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_platforms::PinnedProcess;
use subtle::ConstantTimeEq as _;
use tracing::Instrument as _;

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{
    Dispatch, DispatchError, HandlerContext, HandlerError, MethodRegistry, MethodRegistryBuilder,
    RegistrationError, Reply, Request, TransportId,
};
use crate::mutex_lock::lock;

/// How a handshake's caller is admitted, read once per connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallerAdmission {
    /// The caller is an agent's, or nothing vouches for it: refused whatever the handshake carries.
    Refused,
    /// The caller is the desktop's signed client, admitted by its signature without the session
    /// token.
    Signature,
    /// The caller is admitted only with this start's session token.
    TokenRequired,
}

/// Answers how a handshake from this pinned process is admitted; the flag says whether the
/// handshake carried no token, the only handshake whose caller's signature is read. A failed read
/// answers the handshake `-32603`.
pub(crate) type CallerAdmissionCheck = Arc<
    dyn Fn(
            PinnedProcess,
            bool,
        ) -> BoxFuture<'static, Result<CallerAdmission, Arc<dyn Error + Send + Sync>>>
        + Send
        + Sync,
>;

/// Reads how far a database file's repair has come; `None` while the step it is on gives no count.
pub(crate) type RepairProgressReader = Arc<dyn Fn() -> Option<DaemonRepairProgress> + Send + Sync>;

/// A connection's caller read, shared by every handshake on it.
type CallerRead = Shared<BoxFuture<'static, Result<CallerAdmission, Arc<dyn Error + Send + Sync>>>>;

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
const TOKEN_INVALID_MESSAGE: &str = "The connection.initialize call lacked this daemon's session \
     token, so nothing is served on it";

/// The message of a refusal of an agent's connection, or one the system could not name.
const CALLER_REFUSED_MESSAGE: &str = "The connection was opened by a process this daemon or a \
     provider service it reaches started, such as a command an agent ran, or by one the system \
     could not name or trace, so nothing is served on it";

/// The message of a call before the connection's handshake; it never names the call.
const HANDSHAKE_REQUIRED_MESSAGE: &str =
    "The call was refused because the connection has not completed its handshake";

/// The message of a mutating call after an incompatible handshake; it never names the call.
const VERSION_MISMATCH_MESSAGE: &str =
    "The mutating call was refused because the connection's handshake was incompatible";

/// The message of a handshake answered while the service repairs its database file.
const REPAIRING_MESSAGE: &str =
    "The service is repairing its database file and answers once the repair has ended";

/// Why a connection is latched refused.
#[derive(Clone, Copy)]
enum ConnectionRefusal {
    /// Its handshake carried a wrong session token, or none from a caller that is not the
    /// desktop's signed client.
    TokenInvalid,
    /// Its handshake came from an agent's process, or one the system could not name.
    CallerRefused,
}

impl ConnectionRefusal {
    fn error(self) -> DomainError {
        match self {
            Self::TokenInvalid => {
                DomainError::new(TOKEN_INVALID_MESSAGE, RefusalCode::AuthTokenInvalid)
            }
            Self::CallerRefused => {
                DomainError::new(CALLER_REFUSED_MESSAGE, RefusalCode::AuthCallerRefused)
            }
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

/// How a connection's first handshake was admitted.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Admission {
    /// By the caller's signature, without a token.
    Signature,
    /// By this start's session token.
    Token,
}

/// What a connection's first handshake carried, read when its caller read starts, so the outcome
/// is the same whichever handshake waiting on the read latches it.
#[derive(Clone)]
struct FirstHandshake {
    /// The handshake it negotiates.
    handshake: LatchedHandshake,
    /// Whether it carried this start's session token.
    has_session_token: bool,
    /// Whether it carried no token at all.
    is_tokenless: bool,
}

impl FirstHandshake {
    /// How the connection is decided once its caller reads `caller_admission`.
    fn outcome(
        &self,
        caller_admission: CallerAdmission,
    ) -> Result<(LatchedHandshake, Admission), ConnectionRefusal> {
        let admission = match caller_admission {
            CallerAdmission::Refused => return Err(ConnectionRefusal::CallerRefused),
            // A handshake that carries a token is admitted by that token alone.
            CallerAdmission::Signature if self.is_tokenless => Admission::Signature,
            CallerAdmission::Signature | CallerAdmission::TokenRequired => {
                if !self.has_session_token {
                    return Err(ConnectionRefusal::TokenInvalid);
                }
                Admission::Token
            }
        };
        Ok((self.handshake.clone(), admission))
    }
}

/// One connection's negotiation; a connection with no entry is before its handshake.
enum ConnectionNegotiation {
    /// The first handshake is reading its caller; nothing is latched yet.
    ReadingCaller(CallerRead, FirstHandshake),
    /// Nothing is served on the connection.
    Refused(ConnectionRefusal),
    /// The first handshake's outcome and how it was admitted.
    Latched(LatchedHandshake, Admission),
}

/// Which handshake on its connection an answer is for.
enum HandshakeTurn {
    /// The handshake that latched it.
    First(LatchedHandshake),
    /// A later handshake, which finds the first latched, and how the first was admitted.
    Repeat(LatchedHandshake, Admission),
}

/// A handshake the daemon could not answer: a fault, never the client's.
#[derive(Debug, thiserror::Error)]
#[error("the connection's caller process could not be read")]
struct CallerReadFault(#[source] Arc<dyn Error + Send + Sync>);

/// Keeps each connection's negotiation and answers `connection.initialize`. The gateway calls
/// `cleanup_transport` as each connection closes, or the state keeps one entry per connection.
pub(crate) struct ProtocolNegotiator {
    /// The token this start wrote to its token file.
    session_token: String,
    /// How a handshake from a process is admitted.
    admit_caller: CallerAdmissionCheck,
    /// Each connection's negotiation.
    connections: Mutex<HashMap<TransportId, ConnectionNegotiation>>,
}

impl ProtocolNegotiator {
    /// A negotiator for this start: `session_token` is the token it wrote to its token file, and
    /// `admit_caller` answers how a handshake from a process is admitted.
    pub(crate) fn new(session_token: String, admit_caller: CallerAdmissionCheck) -> Arc<Self> {
        Arc::new(Self {
            session_token,
            admit_caller,
            connections: Mutex::new(HashMap::new()),
        })
    }

    /// Registers `connection.initialize` on `registry`; fails as any second registration of it
    /// does. The handshake is a read, so a client whose handshake was incompatible can repeat it
    /// and read the latched answer.
    pub(crate) fn register_handshake(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
    ) -> Result<(), RegistrationError> {
        let negotiator = Arc::clone(self);
        registry.register::<DaemonHandshake, _>(move |request, context| {
            Arc::clone(&negotiator)
                .answer_handshake(request, context)
                .boxed()
        })
    }

    /// Registers the `connection.initialize` of a service still repairing its database file: a
    /// handshake the negotiator admits is refused `daemon.repairing` with the progress
    /// `read_progress` reads, every time, and latches the handshake as any handshake does, so the
    /// gate lets that connection's lifecycle calls through; a repeat's token is checked as on the
    /// normal handshake.
    pub(crate) fn register_repairing_handshake(
        self: &Arc<Self>,
        registry: &mut MethodRegistryBuilder,
        read_progress: RepairProgressReader,
    ) -> Result<(), RegistrationError> {
        let negotiator = Arc::clone(self);
        registry.register::<DaemonHandshake, _>(move |request, context| {
            Arc::clone(&negotiator)
                .answer_repairing_handshake(request, context, Arc::clone(&read_progress))
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
            None | Some(ConnectionNegotiation::ReadingCaller(..)) => {
                (method != CONNECTION_INITIALIZE_METHOD).then(|| {
                    DomainError::new(
                        HANDSHAKE_REQUIRED_MESSAGE,
                        RefusalCode::ConnectionHandshakeRequired,
                    )
                })
            }
            // An unregistered method passes, so the registry answers that it is not served.
            Some(ConnectionNegotiation::Latched(
                LatchedHandshake::Incompatible { reason, .. },
                _,
            )) => registry
                .descriptor(method)
                .is_some_and(|descriptor| descriptor.is_mutating)
                .then(|| version_mismatch(*reason)),
            Some(ConnectionNegotiation::Latched(LatchedHandshake::Compatible { .. }, _)) => None,
        }
    }

    async fn answer_handshake(
        self: Arc<Self>,
        request: ConnectionInitializeRequest,
        context: HandlerContext,
    ) -> Result<ConnectionInitializeResponse, HandlerError> {
        // Read before anything latches, so a connection wired with no device latches nothing.
        let device_id = context.calling_device(CONNECTION_INITIALIZE_METHOD)?;
        let turn = self.take_turn(&request, &context).await?;
        Ok(acknowledgment(turn, device_id))
    }

    async fn answer_repairing_handshake(
        self: Arc<Self>,
        request: ConnectionInitializeRequest,
        context: HandlerContext,
        read_progress: RepairProgressReader,
    ) -> Result<ConnectionInitializeResponse, HandlerError> {
        self.take_turn(&request, &context).await?;
        // A handshake always fails, so a client keeps waiting for the repair to end.
        Err(
            DomainError::new(REPAIRING_MESSAGE, RefusalCode::DaemonRepairing)
                .with_detail(DaemonRepairingDetails {
                    progress: read_progress(),
                })
                .into(),
        )
    }

    /// Which handshake on its connection `request` is: the first, which latches it, or a repeat,
    /// whether it came before or during the first's caller read. A repeat that carries a wrong
    /// token, or none on a connection the token admitted, is refused `auth.token.invalid`, and
    /// what is latched stays.
    async fn take_turn(
        &self,
        request: &ConnectionInitializeRequest,
        context: &HandlerContext,
    ) -> Result<HandshakeTurn, HandlerError> {
        let turn = match self.latched(context.transport_id) {
            Some((handshake, admission)) => HandshakeTurn::Repeat(handshake, admission),
            None => self.latch_handshake(request, context).await?,
        };
        if let HandshakeTurn::Repeat(_, admission) = turn {
            let is_tokenless_signature =
                request.session_token.is_none() && admission == Admission::Signature;
            if !is_tokenless_signature && !self.is_session_token(request.session_token.as_ref()) {
                return Err(ConnectionRefusal::TokenInvalid.error().into());
            }
        }
        Ok(turn)
    }

    /// Refuses a handshake from a caller the daemon refuses or the system could not name, then one
    /// that carries a wrong token, or no token from a caller that is not the desktop's signed
    /// client, latching the refusal; otherwise latches the version the handshake negotiates. A
    /// handshake whose connection closed during its caller read latches nothing, a refusal latched
    /// meanwhile wins, and a later handshake during the read waits for it and gets the first
    /// handshake's outcome: its refusal, or the latched handshake as a repeat.
    async fn latch_handshake(
        &self,
        request: &ConnectionInitializeRequest,
        context: &HandlerContext,
    ) -> Result<HandshakeTurn, HandlerError> {
        let transport = context.transport_id;
        let Some(caller_process) = context.caller_process.clone() else {
            return Err(self
                .refuse(transport, ConnectionRefusal::CallerRefused)
                .into());
        };
        let (caller_read, first, is_first) = {
            let mut connections = self.connections();
            match connections.get(&transport) {
                Some(ConnectionNegotiation::Refused(refusal)) => {
                    return Err(refusal.error().into());
                }
                Some(ConnectionNegotiation::Latched(handshake, admission)) => {
                    return Ok(HandshakeTurn::Repeat(handshake.clone(), *admission));
                }
                Some(ConnectionNegotiation::ReadingCaller(caller_read, first)) => {
                    (caller_read.clone(), first.clone(), false)
                }
                None => {
                    let first = FirstHandshake {
                        handshake: negotiate(request),
                        has_session_token: self.is_session_token(request.session_token.as_ref()),
                        is_tokenless: request.session_token.is_none(),
                    };
                    // The connection's id rides on every line the caller check logs.
                    let caller_read = (self.admit_caller)(caller_process, first.is_tokenless)
                        .instrument(tracing::debug_span!(
                            "caller_check",
                            connection = transport.0
                        ))
                        .boxed()
                        .shared();
                    connections.insert(
                        transport,
                        ConnectionNegotiation::ReadingCaller(caller_read.clone(), first.clone()),
                    );
                    (caller_read, first, true)
                }
            }
        };
        let caller_admission = caller_read
            .await
            .map_err(|error| HandlerError::Internal(Box::new(CallerReadFault(error))))?;
        let turn = |handshake: LatchedHandshake, admission: Admission| {
            if is_first {
                HandshakeTurn::First(handshake)
            } else {
                HandshakeTurn::Repeat(handshake, admission)
            }
        };
        let mut connections = self.connections();
        match connections.get(&transport) {
            // An ordinary disconnect: nothing can be sent, and no fault is logged.
            None => {
                tracing::debug!("A connection closed while its caller process was read");
                Err(HandlerError::Canceled)
            }
            Some(ConnectionNegotiation::Refused(refusal)) => Err(refusal.error().into()),
            // Latched by a handshake that woke first, from the same first handshake.
            Some(ConnectionNegotiation::Latched(handshake, admission)) => {
                Ok(turn(handshake.clone(), *admission))
            }
            Some(ConnectionNegotiation::ReadingCaller(..)) => {
                match first.outcome(caller_admission) {
                    Ok((handshake, admission)) => {
                        connections.insert(
                            transport,
                            ConnectionNegotiation::Latched(handshake.clone(), admission),
                        );
                        Ok(turn(handshake, admission))
                    }
                    Err(refusal) => {
                        connections.insert(transport, ConnectionNegotiation::Refused(refusal));
                        Err(refusal.error().into())
                    }
                }
            }
        }
    }

    /// Latches `transport` refused and answers the refusal.
    fn refuse(&self, transport: TransportId, refusal: ConnectionRefusal) -> DomainError {
        self.connections()
            .insert(transport, ConnectionNegotiation::Refused(refusal));
        refusal.error()
    }

    fn latched(&self, transport: TransportId) -> Option<(LatchedHandshake, Admission)> {
        match self.connections().get(&transport) {
            Some(ConnectionNegotiation::Latched(handshake, admission)) => {
                Some((handshake.clone(), *admission))
            }
            Some(ConnectionNegotiation::ReadingCaller(..) | ConnectionNegotiation::Refused(_))
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
        lock(&self.connections)
    }
}

/// The negotiation gate: refuses every call on a refused connection, every call but
/// `connection.initialize` before a handshake completed, and every mutating call after an
/// incompatible one, each `-31000` with a fixed message; anything else goes to the next dispatch.
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

/// The refusal of a mutating call after an incompatible handshake, carrying its `reason`.
fn version_mismatch(reason: NegotiationIncompatibleReason) -> DomainError {
    DomainError::new(
        VERSION_MISMATCH_MESSAGE,
        RefusalCode::ConnectionVersionMismatch,
    )
    .with_detail(json!({ "reason": reason }))
}

/// The version `request` and the daemon agree on, the newest both speak, or why there is none:
/// `connection.version.floorExceeded` when every version the client offers is older than the
/// daemon's oldest, else `connection.version.ceilingExceeded`.
fn negotiate(request: &ConnectionInitializeRequest) -> LatchedHandshake {
    let offered = match &request.supported_protocols {
        Some(supported) => supported.as_slice(),
        None => std::slice::from_ref(&request.protocol_version),
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

/// The answer to a handshake: a repeat gets `connection.handshake.alreadyCompleted` with the
/// first's version; an incompatible first gets its reason and the daemon's versions.
fn acknowledgment(turn: HandshakeTurn, device_id: DeviceId) -> ConnectionInitializeResponse {
    let (compatible, protocol_version, reason, daemon_supported_protocols) = match turn {
        HandshakeTurn::Repeat(
            LatchedHandshake::Compatible { version }
            | LatchedHandshake::Incompatible {
                daemon_newest: version,
                ..
            },
            _,
        ) => (
            false,
            version,
            Some(NegotiationIncompatibleReason::HandshakeAlreadyCompleted),
            None,
        ),
        HandshakeTurn::First(LatchedHandshake::Compatible { version }) => {
            (true, version, None, None)
        }
        HandshakeTurn::First(LatchedHandshake::Incompatible {
            daemon_newest,
            reason,
        }) => (
            false,
            daemon_newest,
            Some(reason),
            Some(DAEMON_VERSIONS.clone()),
        ),
    };
    ConnectionInitializeResponse {
        compatible,
        protocol_version,
        device_id,
        reason,
        server_capabilities: None,
        daemon_supported_protocols,
    }
}

#[cfg(test)]
mod tests;

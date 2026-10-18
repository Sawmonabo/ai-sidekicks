use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, CURRENT_PROTOCOL_VERSION, ConnectionInitializeResponse,
    NegotiationIncompatibleReason,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::{Method, MethodDescriptor, ProcedureType};
use sidekicks_contracts::schema::received_check;
use sidekicks_contracts::typescript::TypeName;
use sidekicks_platforms::{PinnedProcess, this_process};
use tokio::sync::{Notify, mpsc};

use super::{NegotiationGate, ProtocolNegotiator, RefusedCallerCheck};
use crate::ipc::call_fixtures::{Nothing, context};
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
    /// A handshake with this token, offering this one version.
    Handshake(&'static str, &'static str),
    Read,
    Write,
}

/// What the call answers.
#[derive(Clone, Copy, Debug)]
enum Answer {
    /// A handshake's ack: whether compatible, and its reason.
    Ack(bool, Option<NegotiationIncompatibleReason>),
    /// A read's or a write's result.
    Served,
    Refused(RefusalCode),
}

fn request(call: Call) -> Request {
    let (method, params) = match call {
        Call::Handshake(token, version) => (
            CONNECTION_INITIALIZE_METHOD,
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

/// The negotiation gate over a registry serving the handshake, a read and a write, its callers
/// checked by `is_refused_caller`.
fn gate_over(is_refused_caller: RefusedCallerCheck) -> NegotiationGate {
    let negotiator = ProtocolNegotiator::new(SESSION_TOKEN.to_owned(), is_refused_caller);
    let mut builder = MethodRegistryBuilder::new();
    negotiator
        .register_handshake(&mut builder)
        .expect("the handshake registers");
    builder
        .register::<Probe<false>, _>(|nothing, _context| async move { Ok(nothing) }.boxed())
        .expect("the read registers");
    builder
        .register::<Probe<true>, _>(|nothing, _context| async move { Ok(nothing) }.boxed())
        .expect("the write registers");
    let registry = Arc::new(builder.freeze());
    negotiator.gate(Arc::clone(&registry) as Arc<dyn Dispatch>, registry)
}

/// The context of a call on connection 1, from this test's own process when `is_caller_named`.
fn caller_context(is_caller_named: bool) -> HandlerContext {
    HandlerContext {
        caller_process: is_caller_named.then(this_process),
        ..context(1)
    }
}

#[rstest]
#[case::wrong_token_latches_refused(true, false, &[
    (Call::Handshake("a-wrong-token", CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Read, Answer::Refused(RefusalCode::AuthTokenInvalid)),
])]
#[case::floor(true, false, &[
    (Call::Handshake(SESSION_TOKEN, "2000-01-01"),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::FloorExceeded))),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionVersionMismatch)),
    (Call::Read, Answer::Served),
])]
#[case::ceiling(true, false, &[
    (Call::Handshake(SESSION_TOKEN, "2999-12-31"),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::CeilingExceeded))),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionVersionMismatch)),
    (Call::Read, Answer::Served),
])]
#[case::compatible(true, false, &[
    (Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION), Answer::Ack(true, None)),
    (Call::Write, Answer::Served),
    (Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::HandshakeAlreadyCompleted))),
])]
#[case::before_the_handshake(true, false, &[
    (Call::Read, Answer::Refused(RefusalCode::ConnectionHandshakeRequired)),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionHandshakeRequired)),
])]
#[case::agent_process(true, true, &[
    (Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[case::unnamed_caller(false, false, &[
    (Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[tokio::test]
async fn the_gate_and_the_handshake_answer_each_connection_state(
    #[case] is_caller_named: bool,
    #[case] is_agent_process: bool,
    #[case] calls: &[(Call, Answer)],
) {
    let gate = gate_over(Arc::new(move |_process: PinnedProcess| {
        futures::future::ready(Ok::<_, Arc<dyn Error + Send + Sync>>(is_agent_process)).boxed()
    }));
    for &(call, expected) in calls {
        let answer = gate
            .dispatch(request(call), caller_context(is_caller_named))
            .await;
        match (answer, expected) {
            (Ok(Reply::Result(encoded)), Answer::Ack(compatible, reason)) => {
                let ack: ConnectionInitializeResponse =
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
    let gate = gate_over(Arc::new(move |_process: PinnedProcess| {
        read_started.send(()).expect("the test listens");
        let release = Arc::clone(&read_release);
        async move {
            release.notified().await;
            Ok::<_, Arc<dyn Error + Send + Sync>>(false)
        }
        .boxed()
    }));

    let handshake = tokio::spawn(gate.dispatch(
        request(Call::Handshake(SESSION_TOKEN, CURRENT_PROTOCOL_VERSION)),
        caller_context(true),
    ));
    has_read_started
        .recv()
        .await
        .expect("the caller read starts");
    let wrong = gate
        .dispatch(
            request(Call::Handshake("a-wrong-token", CURRENT_PROTOCOL_VERSION)),
            caller_context(true),
        )
        .await;
    assert!(matches!(
        wrong,
        Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
    ));

    // The read then finds the caller is no agent's, and the latched refusal still answers.
    release.notify_one();
    let answer = handshake.await.expect("the handshake ran");
    assert!(matches!(
        answer,
        Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
    ));
    let read = gate
        .dispatch(request(Call::Read), caller_context(true))
        .await;
    assert!(matches!(
        read,
        Err(DispatchError::Refused(refusal)) if refusal.code == RefusalCode::AuthTokenInvalid
    ));
}

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

use super::{CallerAdmission, CallerAdmissionCheck, NegotiationGate, ProtocolNegotiator};
use crate::ipc::call_fixtures::{Nothing, context};
use crate::ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistryBuilder, Reply, Request,
};

/// This start's session token.
const TOKEN: Option<&str> = Some("the-session-token");

/// A token that is not this start's.
const WRONG_TOKEN: Option<&str> = Some("a-wrong-token");

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
    /// A handshake with this token, or none, offering this one version.
    Handshake(Option<&'static str>, &'static str),
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
        Call::Handshake(token, version) => {
            let mut params = json!({ "protocolVersion": version });
            if let Some(token) = token {
                params["sessionToken"] = json!(token);
            }
            (CONNECTION_INITIALIZE_METHOD, params)
        }
        Call::Read => ("test.read", json!({})),
        Call::Write => ("test.write", json!({})),
    };
    Request {
        method: method.to_owned(),
        params: Some(RawValue::from_string(params.to_string()).expect("the params are JSON")),
        attachments: Vec::new(),
    }
}

/// A caller check that answers `admission` for every caller.
fn admitting(admission: CallerAdmission) -> CallerAdmissionCheck {
    Arc::new(move |_process: PinnedProcess, _is_tokenless: bool| {
        futures::future::ready(Ok::<_, Arc<dyn Error + Send + Sync>>(admission)).boxed()
    })
}

/// The negotiation gate over a registry serving the handshake, or the repairing service's one when
/// `is_repairing`, a read and a write, its callers checked by `admit_caller`.
fn gate_over(admit_caller: CallerAdmissionCheck, is_repairing: bool) -> NegotiationGate {
    let negotiator = ProtocolNegotiator::new(
        TOKEN.expect("the start has a token").to_owned(),
        admit_caller,
    );
    let mut builder = MethodRegistryBuilder::new();
    if is_repairing {
        negotiator
            .register_repairing_handshake(&mut builder, Arc::new(|| None))
            .expect("the handshake registers");
    } else {
        negotiator
            .register_handshake(&mut builder)
            .expect("the handshake registers");
    }
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

/// Runs `calls` in order on one connection and checks each answer.
async fn expect_answers(gate: &NegotiationGate, is_caller_named: bool, calls: &[(Call, Answer)]) {
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

#[rstest]
#[case::wrong_token_latches_refused(true, CallerAdmission::TokenRequired, &[
    (Call::Handshake(WRONG_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Read, Answer::Refused(RefusalCode::AuthTokenInvalid)),
])]
#[case::floor(true, CallerAdmission::TokenRequired, &[
    (Call::Handshake(TOKEN, "2000-01-01"),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::FloorExceeded))),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionVersionMismatch)),
    (Call::Read, Answer::Served),
])]
#[case::ceiling(true, CallerAdmission::TokenRequired, &[
    (Call::Handshake(TOKEN, "2999-12-31"),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::CeilingExceeded))),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionVersionMismatch)),
    (Call::Read, Answer::Served),
])]
#[case::compatible(true, CallerAdmission::TokenRequired, &[
    (Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION), Answer::Ack(true, None)),
    (Call::Write, Answer::Served),
    (Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Ack(false, Some(NegotiationIncompatibleReason::HandshakeAlreadyCompleted))),
])]
#[case::before_the_handshake(true, CallerAdmission::TokenRequired, &[
    (Call::Read, Answer::Refused(RefusalCode::ConnectionHandshakeRequired)),
    (Call::Write, Answer::Refused(RefusalCode::ConnectionHandshakeRequired)),
])]
#[case::agent_process_with_the_token(true, CallerAdmission::Refused, &[
    (Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[case::agent_process_without_a_token(true, CallerAdmission::Refused, &[
    (Call::Handshake(None, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[case::agent_process_with_a_wrong_token(true, CallerAdmission::Refused, &[
    (Call::Handshake(WRONG_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[case::unnamed_caller(false, CallerAdmission::TokenRequired, &[
    (Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthCallerRefused)),
    (Call::Read, Answer::Refused(RefusalCode::AuthCallerRefused)),
])]
#[case::signed_client_without_a_token(true, CallerAdmission::Signature, &[
    (Call::Handshake(None, CURRENT_PROTOCOL_VERSION), Answer::Ack(true, None)),
    (Call::Write, Answer::Served),
])]
#[case::signed_client_with_a_wrong_token(true, CallerAdmission::Signature, &[
    (Call::Handshake(WRONG_TOKEN, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Read, Answer::Refused(RefusalCode::AuthTokenInvalid)),
])]
#[case::unsigned_caller_without_a_token(true, CallerAdmission::TokenRequired, &[
    (Call::Handshake(None, CURRENT_PROTOCOL_VERSION),
        Answer::Refused(RefusalCode::AuthTokenInvalid)),
    (Call::Read, Answer::Refused(RefusalCode::AuthTokenInvalid)),
])]
#[tokio::test]
async fn the_gate_and_the_handshake_answer_each_connection_state(
    #[case] is_caller_named: bool,
    #[case] admission: CallerAdmission,
    #[case] calls: &[(Call, Answer)],
) {
    let gate = gate_over(admitting(admission), false);
    expect_answers(&gate, is_caller_named, calls).await;
}

#[rstest]
#[case::signed_client_repeats_without_a_token(CallerAdmission::Signature, None)]
#[case::token_holder_repeats_with_it(CallerAdmission::TokenRequired, TOKEN)]
#[tokio::test]
async fn a_repairing_service_answers_a_repeat_as_it_admitted_the_first(
    #[case] admission: CallerAdmission,
    #[case] token: Option<&'static str>,
) {
    let gate = gate_over(admitting(admission), true);
    let repairing = Answer::Refused(RefusalCode::DaemonRepairing);
    expect_answers(
        &gate,
        true,
        &[
            (Call::Handshake(token, CURRENT_PROTOCOL_VERSION), repairing),
            (Call::Handshake(token, CURRENT_PROTOCOL_VERSION), repairing),
            (
                Call::Handshake(WRONG_TOKEN, CURRENT_PROTOCOL_VERSION),
                if token.is_none() {
                    repairing
                } else {
                    Answer::Refused(RefusalCode::AuthTokenInvalid)
                },
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn a_handshake_during_the_first_ones_caller_read_gets_the_first_ones_outcome() {
    let (read_started, mut has_read_started) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let read_release = Arc::clone(&release);
    let gate = gate_over(
        Arc::new(move |_process: PinnedProcess, _is_tokenless: bool| {
            read_started.send(()).expect("the test listens");
            let release = Arc::clone(&read_release);
            async move {
                release.notified().await;
                Ok::<_, Arc<dyn Error + Send + Sync>>(CallerAdmission::TokenRequired)
            }
            .boxed()
        }),
        false,
    );

    // A wrong guess starts the caller read and waits on it.
    let mut wrong = gate.dispatch(
        request(Call::Handshake(WRONG_TOKEN, CURRENT_PROTOCOL_VERSION)),
        caller_context(true),
    );
    assert!(
        futures::poll!(&mut wrong).is_pending(),
        "the guess waits for its caller read"
    );
    has_read_started
        .try_recv()
        .expect("the guess started the caller read");

    // The right token's handshake joins the read and, once it ends, wakes first.
    release.notify_one();
    let right = gate
        .dispatch(
            request(Call::Handshake(TOKEN, CURRENT_PROTOCOL_VERSION)),
            caller_context(true),
        )
        .await;
    let wrong = wrong.await;
    let read = gate
        .dispatch(request(Call::Read), caller_context(true))
        .await;

    // The first handshake decides the connection: its wrong token refuses it, the token's
    // handshake included.
    for (answer, what) in [
        (wrong, "the guess"),
        (right, "the token's handshake"),
        (read, "a later call"),
    ] {
        match answer {
            Err(DispatchError::Refused(refusal)) => {
                assert_eq!(refusal.code, RefusalCode::AuthTokenInvalid, "{what}");
            }
            Err(error) => panic!("{what}: expected a refusal, got {error:?}"),
            Ok(_) => panic!("{what}: expected a refusal, got a reply"),
        }
    }
}

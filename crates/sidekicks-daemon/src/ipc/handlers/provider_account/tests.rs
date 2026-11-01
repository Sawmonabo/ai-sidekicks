//! Who reaches the `provider.account.*` methods: the gateway's admission, before any of them runs.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, CURRENT_PROTOCOL_VERSION,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::PROVIDER_ACCOUNT_METHOD_DESCRIPTORS;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::caller_process::descent::CallerCheck;
use sidekicks_ipc::caller_process::descent::test_reader::ScriptedReader;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistry, MethodRegistryBuilder, Reply, Request,
};
use sidekicks_platforms::{ParentProcess, ResponsibleProcess, this_process};

/// This start's session token.
const SESSION_TOKEN: &str = "the-session-token";

/// The dispatch behind the gate: it records every call that reaches it and serves only the
/// handshake, so a recorded account method is one the gate let through.
struct RecordingDispatch {
    registry: Arc<MethodRegistry>,
    reached: Mutex<Vec<String>>,
}

impl Dispatch for RecordingDispatch {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        self.reached
            .lock()
            .expect("no test thread panics holding the record")
            .push(request.method.clone());
        if request.method == CONNECTION_INITIALIZE_METHOD {
            self.registry.dispatch(request, context)
        } else {
            futures::future::ready(Err(DispatchError::MethodNotFound)).boxed()
        }
    }
}

// The caller is untracked by the system and its parent is the daemon (the test's own process),
// as a command an agent ran is. The real caller check refuses it whether its hello holds the
// session token or none, and every account method on that connection is refused the same, with
// no detail, so no readiness entry and no remedy, before any reaches the dispatch. Killed by an
// admission arm that lets a token through from inside the daemon's tree: the hello with the token
// would then latch and the account methods reach the dispatch.
#[rstest]
#[case::holding_the_session_token(Some(SESSION_TOKEN))]
#[case::without_a_token(None)]
#[tokio::test]
async fn a_daemon_started_caller_reaches_no_provider_account_method(#[case] token: Option<&str>) {
    let check = CallerCheck::new(
        Arc::new(ScriptedReader {
            responsible: ResponsibleProcess::Untracked,
            parent: ParentProcess::Pinned(this_process()),
            is_desktop_client: false,
            was_signature_read: AtomicBool::new(false),
        }) as Arc<dyn CallerProcessReader>,
        Arc::new(HashSet::new),
        Arc::new(ProviderServiceProcesses::default()),
    );
    let negotiator = ProtocolNegotiator::new(SESSION_TOKEN.to_owned(), check.admission_check());
    let mut builder = MethodRegistryBuilder::new();
    negotiator
        .register_handshake(&mut builder)
        .expect("the handshake registers");
    let registry = Arc::new(builder.freeze());
    let recording = Arc::new(RecordingDispatch {
        registry: Arc::clone(&registry),
        reached: Mutex::new(Vec::new()),
    });
    let gate = negotiator.gate(Arc::clone(&recording) as Arc<dyn Dispatch>, registry);
    let caller = || HandlerContext {
        caller_process: Some(this_process()),
        ..context(1)
    };

    let mut hello = json!({ "protocolVersion": CURRENT_PROTOCOL_VERSION });
    if let Some(token) = token {
        hello["sessionToken"] = json!(token);
    }
    let refused = |answer: Result<Reply, DispatchError>| match answer {
        Err(DispatchError::Refused(refusal)) => {
            assert_eq!(refusal.code, RefusalCode::AuthCallerRefused);
            assert!(refusal.detail.is_none());
        }
        Ok(_) => panic!("the call was served"),
        Err(other) => panic!("the call failed otherwise: {other}"),
    };
    refused(
        gate.dispatch(
            request(CONNECTION_INITIALIZE_METHOD, Some(&hello)),
            caller(),
        )
        .await,
    );
    for descriptor in PROVIDER_ACCOUNT_METHOD_DESCRIPTORS.methods {
        refused(
            gate.dispatch(request(descriptor.method, Some(&json!({}))), caller())
                .await,
        );
    }

    assert_eq!(
        *recording
            .reached
            .lock()
            .expect("no test thread panics holding the record"),
        [CONNECTION_INITIALIZE_METHOD]
    );
}

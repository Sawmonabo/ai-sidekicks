use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::test_registry::first_provider;

use super::{McpCommand, McpCommandAnswer};
use crate::binding::store::McpBindingKey;
use crate::mutation::receipts::McpIntentReceipt;
use crate::mutation::receipts::tests::idempotency_key;
use crate::mutation::service::tests::{Fixture, user_binding_ref};
use crate::mutation::settle::tests::{is_owed, settled};

/// The address a sign-in serves, which its receipt never keeps.
const AUTHORIZATION_URL: &str = "https://auth.example.test/a";

/// What a test's command answers when it acts.
#[derive(Clone, Copy, Debug)]
enum Acted {
    /// Serves the address and saves the acknowledgment without it.
    Served,
    /// Refuses with the sign-in's passing failure.
    Refused,
    /// Fails with a fault inside the daemon.
    Faulted,
}

impl Acted {
    fn answer(self) -> Result<McpCommandAnswer, HandlerError> {
        match self {
            Self::Served => Ok(McpCommandAnswer {
                served: json!({ "authorizationUrl": AUTHORIZATION_URL }),
                saved: json!({}),
            }),
            Self::Refused => Err(HandlerError::Refused(DomainError::new(
                "the server could not be reached",
                RefusalCode::McpServerSignInFailed,
            ))),
            Self::Faulted => Err(HandlerError::Internal(
                "the sign-in's folder was not made".into(),
            )),
        }
    }
}

/// The code a command's call was refused with, `None` where it was served or faulted.
fn code(answer: &Result<Value, HandlerError>) -> Option<RefusalCode> {
    match answer {
        Err(HandlerError::Refused(refusal)) => Some(refusal.code),
        Ok(_) | Err(HandlerError::Internal(_) | HandlerError::Canceled) => None,
    }
}

/// A sign-in request under `key` naming the server `name`; the runner reads it only for its
/// digest.
fn sign_in_request(key: &ClientUuid, name: &str) -> Value {
    json!({ "clientIdempotencyKey": key.as_str(), "serverName": name })
}

/// The binding every test's command is addressed to.
fn docs() -> McpServerBindingRef {
    user_binding_ref(&first_provider(), "docs")
}

/// Runs a sign-in under `key` with `request`, counting in `acts` each time it acts.
async fn sign_in(
    fixture: &Fixture,
    key: &ClientUuid,
    request: &Value,
    acts: &Arc<AtomicUsize>,
    acted: Acted,
) -> Result<Value, HandlerError> {
    fixture
        .service
        .run_command(McpCommand::SignIn, key, request, &docs(), || async {
            acts.fetch_add(1, Ordering::SeqCst);
            acted.answer()
        })
        .await
}

/// Leaves a sign-in's intent under `key` for `request` `pending`, as a stopped daemon leaves it.
async fn begin_pending(fixture: &Fixture, key: &ClientUuid, request: &Value) {
    let service = &fixture.service;
    let receipt_key = service
        .receipt_keys
        .read(&service.key_locks)
        .await
        .expect("the receipt key reads");
    let request_digest = receipt_key
        .digest_request(key, McpCommand::SignIn.method(), request)
        .expect("the request digests");
    let intent = McpIntentReceipt {
        idempotency_key: key.clone(),
        operation: McpCommand::SignIn.method().to_owned(),
        binding: McpBindingKey::of(&docs()),
        request_digest,
        before_digest: None,
        after_digest: None,
        wanted_enabled: None,
    };
    service
        .parts
        .receipts
        .begin(&intent)
        .await
        .expect("the intent begins");
}

/// A command acts once per key, and a retry with the same request answers what its receipt saved:
/// the acknowledgment without the address, or the same refusal. Killed by the served answer
/// committed, so the address is kept, by the command run again, and by a refusal answered but not
/// committed.
#[rstest]
#[case::served(Acted::Served, Ok(json!({ "authorizationUrl": AUTHORIZATION_URL })), Ok(json!({})))]
#[case::refused(
    Acted::Refused,
    Err(Some(RefusalCode::McpServerSignInFailed)),
    Err(Some(RefusalCode::McpServerSignInFailed))
)]
#[tokio::test]
async fn a_command_runs_once_per_key_and_replays_what_it_saved(
    #[case] acted: Acted,
    #[case] first_answer: Result<Value, Option<RefusalCode>>,
    #[case] retry_answer: Result<Value, Option<RefusalCode>>,
) {
    let fixture = Fixture::new(vec![Arc::new(MockProviderDriver::new())], None).await;
    let (key, acts) = (idempotency_key(), Arc::new(AtomicUsize::new(0)));
    let request = sign_in_request(&key, "docs");
    let answered = |answer: Result<Value, HandlerError>| answer.map_err(|error| code(&Err(error)));

    let first = sign_in(&fixture, &key, &request, &acts, acted).await;
    let retry = sign_in(&fixture, &key, &request, &acts, acted).await;

    assert_eq!(answered(first), first_answer);
    assert_eq!(answered(retry), retry_answer);
    assert_eq!(acts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
    let kept_addresses = fixture.count(
        "SELECT count(*) FROM mcp_mutation_receipts WHERE response_json LIKE '%authorizationUrl%'",
    );
    assert_eq!(kept_addresses, 0);
}

/// The same key with another request is refused as the key's conflict without the command
/// acting, whether the key's receipt was committed or a stop left it `pending`, which stays so.
/// Killed by the digest skipped, and by a pending receipt expired before the digest is compared.
#[rstest]
#[case::committed(false, "committed")]
#[case::pending(true, "pending")]
#[tokio::test]
async fn a_reused_command_key_with_another_request_is_refused(
    #[case] is_left_pending: bool,
    #[case] status: &str,
) {
    let fixture = Fixture::new(vec![Arc::new(MockProviderDriver::new())], None).await;
    let (key, acts) = (idempotency_key(), Arc::new(AtomicUsize::new(0)));
    let first_request = sign_in_request(&key, "docs");
    if is_left_pending {
        begin_pending(&fixture, &key, &first_request).await;
    } else {
        let first = sign_in(&fixture, &key, &first_request, &acts, Acted::Served).await;
        assert_eq!(code(&first), None);
        acts.store(0, Ordering::SeqCst);
    }

    let other_request = sign_in_request(&key, "mail");
    let reused = sign_in(&fixture, &key, &other_request, &acts, Acted::Served).await;

    assert_eq!(
        code(&reused),
        Some(RefusalCode::McpServerIdempotencyConflict)
    );
    assert_eq!(acts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_status(&key).as_deref(), Some(status));
}

/// How a test reaches a command's receipt a stop left `pending`.
#[derive(Clone, Copy, Debug)]
enum PendingReach {
    /// A retry under the key with the same request.
    Retry,
    /// The start's pass over the `pending` receipts.
    Pass,
}

/// A command's receipt a stop left `pending` is expired, never settled against a provider's
/// config: a retry runs the command fresh and answers what it serves, and the start's pass leaves
/// no receipt and owes no pass; neither observes the provider or sends a config notice. Killed by
/// the mutations' settlement run on a command, whose observe the bare driver refuses, and by no
/// settler registered for the command, which leaves the receipt and owes a pass.
#[rstest]
#[case::retry(PendingReach::Retry)]
#[case::pass(PendingReach::Pass)]
#[tokio::test]
async fn a_command_left_pending_runs_fresh(#[case] reach: PendingReach) {
    let mut fixture = Fixture::new(vec![Arc::new(MockProviderDriver::new())], None).await;
    let (key, acts) = (idempotency_key(), Arc::new(AtomicUsize::new(0)));
    let request = sign_in_request(&key, "docs");
    begin_pending(&fixture, &key, &request).await;

    match reach {
        PendingReach::Retry => {
            let retry = sign_in(&fixture, &key, &request, &acts, Acted::Served).await;
            assert_eq!(
                retry.ok(),
                Some(json!({ "authorizationUrl": AUTHORIZATION_URL }))
            );
            assert_eq!(acts.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
        }
        PendingReach::Pass => {
            fixture.service.settle_pending();
            settled(&fixture.service.pending).await;
            assert_eq!(fixture.receipt_status(&key), None);
            assert!(!is_owed(&fixture.service.pending));
        }
    }
    assert_eq!(fixture.config_notices(), Vec::new());
}

/// A fault the command answers passes through and is never saved: its receipt is expired, so the
/// next call under the key runs the command again. Killed by a fault committed as an answer.
#[tokio::test]
async fn a_command_fault_is_not_saved() {
    let fixture = Fixture::new(vec![Arc::new(MockProviderDriver::new())], None).await;
    let (key, acts) = (idempotency_key(), Arc::new(AtomicUsize::new(0)));
    let request = sign_in_request(&key, "docs");

    let faulted = sign_in(&fixture, &key, &request, &acts, Acted::Faulted).await;

    assert!(matches!(faulted, Err(HandlerError::Internal(_))));
    assert_eq!(fixture.receipt_status(&key), None);
    let retry = sign_in(&fixture, &key, &request, &acts, Acted::Served).await;
    assert_eq!(code(&retry), None);
    assert_eq!(acts.load(Ordering::SeqCst), 2);
}

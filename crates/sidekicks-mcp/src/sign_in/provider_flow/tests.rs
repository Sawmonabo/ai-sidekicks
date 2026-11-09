use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use reqwest::{Method, Url};
use rstest::rstest;
use secrecy::ExposeSecret;
use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    BEARER_TOKEN_TYPE, NoPersonServerEntry, ProviderSignInFailure, ProviderSignInReturn,
    ProviderSignInTakeover,
};
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_std::mutex_lock::lock;

use crate::client::http::McpRequestAuthorizer as _;
use crate::errors::{McpRefusal, SignInLaunchError, SignInUnsupportedReason};
use crate::sign_in::completion_event::SignInFailureReason;
use crate::sign_in::service::{ProviderAccounts, SignInTarget};
use crate::sign_in::test_service::{
    FakeAuthorizationServer, FakeServerAnswers, Harness, addressed_target, harness_with,
    serve_authorization_server, server_name,
};

const PROVIDER_ACCESS_TOKEN: &str = "test-provider-access-token";
const PROVIDER_REFRESH_TOKEN: &str = "test-provider-refresh-token";
const PROVIDER_CLIENT_ID: &str = "test-provider-client";
const PROVIDER_CLIENT_SECRET: &str = "test-provider-client-secret";

/// What a scripted driver's flow does once asked.
#[derive(Clone)]
enum ScriptedFlow {
    /// Fails at once: the provider has no entry of the person's for the binding.
    NoFlow,
    /// Fails before the browser opens, with the driver's failure `failure` makes.
    FailsBeforeBrowser { failure: fn() -> DriverError },
    /// Opens the browser at its address, then completes with credentials the server at the
    /// address issued.
    Completes { issuer: String },
    /// Opens the browser at its address, then fails: with that kind of sign-in failure, or
    /// as the driver's own failure for `None`.
    Fails {
        failure: Option<ProviderSignInFailure>,
    },
}

/// The browser address every scripted flow opens.
fn scripted_browser_url() -> Url {
    Url::parse("https://login.example.com/authorize?state=test-state").expect("an address")
}

/// A driver answering every sign-in with `flow`, writing `label` into `calls` when asked.
fn scripted_driver(
    flow: ScriptedFlow,
    label: &'static str,
    calls: &Arc<Mutex<Vec<&'static str>>>,
) -> Arc<dyn ProviderDriver> {
    let calls = Arc::clone(calls);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_sign_in_with_own_client()
        .returning(move |request| {
            lock(&calls).push(label);
            let flow = flow.clone();
            async move {
                let issuer = match flow {
                    ScriptedFlow::NoFlow => {
                        return Err(NoPersonServerEntry {
                            binding: request.binding,
                        }
                        .into());
                    }
                    ScriptedFlow::FailsBeforeBrowser { failure } => return Err(failure()),
                    ScriptedFlow::Completes { issuer } => issuer,
                    ScriptedFlow::Fails { failure } => {
                        request
                            .authorization_url
                            .send(scripted_browser_url())
                            .expect("the launch waits for the address");
                        return Err(failure.map_or_else(
                            || DriverError::Internal("the scripted flow failed".into()),
                            DriverError::SignInFailed,
                        ));
                    }
                };
                request
                    .authorization_url
                    .send(scripted_browser_url())
                    .expect("the launch waits for the address");
                Ok(ProviderSignInTakeover {
                    access_token: PROVIDER_ACCESS_TOKEN.to_owned(),
                    refresh_token: Some(PROVIDER_REFRESH_TOKEN.to_owned()),
                    // Already past, so the first use renews it.
                    expires_at: Some(SystemTime::now() - Duration::from_secs(60)),
                    scopes: vec!["docs.read".to_owned()],
                    token_type: BEARER_TOKEN_TYPE.to_owned(),
                    client_id: PROVIDER_CLIENT_ID.to_owned(),
                    client_secret: Some(PROVIDER_CLIENT_SECRET.to_owned()),
                    issuer: Some(issuer),
                })
            }
            .boxed()
        });
    Arc::new(driver)
}

/// The providers the harness's registry holds, in its order.
fn registered_providers(harness: &Harness) -> Vec<ProviderId> {
    harness
        .service
        .providers
        .drivers()
        .map(|(provider, _driver)| provider.clone())
        .collect()
}

/// A user binding of `provider`'s to the fake server, with every registered provider's account.
fn provider_target(
    harness: &Harness,
    provider: &ProviderId,
    server: &FakeAuthorizationServer,
) -> (SignInTarget, ProviderAccounts) {
    let target = SignInTarget {
        binding: McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: server_name(),
        },
        ..addressed_target(&server.base)
    };
    let accounts = registered_providers(harness)
        .into_iter()
        .map(|provider| (provider, test_provider_account_id()))
        .collect();
    (target, accounts)
}

/// The completion events once one is appended.
async fn settled_completions(harness: &Harness) -> Vec<Value> {
    for _ in 0..500 {
        let completions = harness.completions();
        if !completions.is_empty() {
            return completions;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no completion event was appended");
}

/// A server that refused the daemon's registration, whose provider flow then fails, has no
/// admitted client written, is not signed in and gets one failure event, whose reason is the
/// driver's kind of failure, and not finished in time for the driver's own failure. Killed by
/// writing the admitted row when the registration is refused or on a failed flow, and by every
/// failure read as one reason.
#[rstest]
#[case::callback_error(
    Some(ProviderSignInFailure::CallbackCarriedError),
    SignInFailureReason::CallbackCarriedError
)]
#[case::code_not_redeemed(
    Some(ProviderSignInFailure::CodeNotRedeemed),
    SignInFailureReason::CodeNotRedeemed
)]
#[case::not_saved(
    Some(ProviderSignInFailure::SignInNotSaved),
    SignInFailureReason::SignInNotSaved
)]
#[case::not_in_time(
    Some(ProviderSignInFailure::DidNotFinishInTime),
    SignInFailureReason::DidNotFinishInTime
)]
#[case::reply_unreadable(
    Some(ProviderSignInFailure::ReplyUnreadable),
    SignInFailureReason::ReplyUnreadable
)]
#[case::driver_failure(None, SignInFailureReason::DidNotFinishInTime)]
#[tokio::test]
async fn a_failed_provider_flow_appends_its_reason_and_writes_no_admitted_row(
    #[case] failure: Option<ProviderSignInFailure>,
    #[case] expected_reason: SignInFailureReason,
) {
    let server = serve_authorization_server(FakeServerAnswers {
        is_registration_refused: true,
        ..FakeServerAnswers::default()
    })
    .await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(
        ScriptedFlow::Fails { failure },
        "only",
        &calls,
    )])
    .await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);

    let browser_url = harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect("the provider's flow opens the browser");

    assert_eq!(browser_url.as_str(), scripted_browser_url().as_str());
    let completions = settled_completions(&harness).await;
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["outcome"], "failure");
    assert_eq!(completions[0]["failureReason"], expected_reason.as_str());
    let address = McpServerAddress::new(&server.base).expect("a server address");
    assert_eq!(
        harness
            .admitted_clients
            .read(&harness.service.custody.test_digest(&address).await)
            .await
            .expect("the admitted client reads"),
        None
    );
    assert!(
        harness
            .service
            .custody
            .signed_in_servers()
            .borrow()
            .is_empty()
    );
}

/// The binding's provider's flow is asked first, and the registry's other provider only once
/// it finds no entry of the person's for the binding. Killed by asking the providers in the
/// registry's order, the binding's provider being second there, and by a missing entry that
/// refuses the launch rather than handing on.
#[tokio::test]
async fn the_bindings_provider_is_tried_before_another() {
    let server = serve_authorization_server(FakeServerAnswers {
        is_registration_refused: true,
        ..FakeServerAnswers::default()
    })
    .await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![
        scripted_driver(
            ScriptedFlow::Completes {
                issuer: server.base.clone(),
            },
            "other",
            &calls,
        ),
        scripted_driver(ScriptedFlow::NoFlow, "binding's", &calls),
    ])
    .await;
    let binding_provider = registered_providers(&harness).remove(1);
    let (target, accounts) = provider_target(&harness, &binding_provider, &server);

    let browser_url = harness.service.launch(&target, &[], &accounts).await;

    assert_eq!(
        browser_url
            .expect("the other provider's flow opens the browser")
            .as_str(),
        scripted_browser_url().as_str()
    );
    assert_eq!(*lock(&calls), ["binding's", "other"]);
}

/// A driver with no flow for the binding that writes the redirect address its request carried
/// into `seen`, or `None` where its provider's own listener takes the return.
fn return_recording_driver(seen: &Arc<Mutex<Vec<Option<Url>>>>) -> Arc<dyn ProviderDriver> {
    let seen = Arc::clone(seen);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_sign_in_with_own_client()
        .returning(move |request| {
            let redirect_url = match request.browser_return {
                ProviderSignInReturn::ThroughDaemonReceiver { redirect_url, .. } => {
                    Some(redirect_url)
                }
                ProviderSignInReturn::OwnListener => None,
            };
            lock(&seen).push(redirect_url);
            let binding = request.binding;
            async move { Err(NoPersonServerEntry { binding }.into()) }.boxed()
        });
    Arc::new(driver)
}

/// A driver whose descriptor says its flow returns to the daemon's receiver is handed the bound
/// receiver's address, even after a driver whose descriptor says no was asked first and told its
/// provider's own listener takes the return. Killed by the descriptor's word ignored either way,
/// and by a receiver bound only for the first driver asked.
#[tokio::test]
async fn only_a_driver_whose_flow_returns_to_the_daemons_receiver_is_handed_its_address() {
    let server = serve_authorization_server(FakeServerAnswers {
        is_registration_refused: true,
        ..FakeServerAnswers::default()
    })
    .await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![
        return_recording_driver(&seen),
        return_recording_driver(&seen),
    ])
    .await;
    // The registry's second provider's flow cannot return to the daemon's receiver; as the
    // binding's provider it is asked first.
    let providers = registered_providers(&harness);
    let (target, accounts) = provider_target(&harness, &providers[1], &server);

    let refused = harness.service.launch(&target, &[], &accounts).await;

    assert!(refused.is_err(), "no provider offers a flow");
    let seen = lock(&seen).clone();
    let [own_listener, daemon_receiver] = seen.as_slice() else {
        panic!("each provider is asked once: {seen:?}");
    };
    assert_eq!(
        *own_listener, None,
        "the driver whose provider's listener takes the return is handed no address"
    );
    assert!(
        daemon_receiver.is_some(),
        "the daemon's receiver is bound and its address handed over"
    );
}

/// A server whose metadata does not list `S256`, which the daemon's own client never opens a
/// browser for, goes to the providers' flows: one that admits it signs in, and where none does the
/// sign-in is refused as unsupported for the missing method. Killed by the refusal answered
/// before the providers' flows are asked, and by the reason lost to the plain no-flow one.
#[rstest]
#[case::a_provider_admits(true)]
#[case::none_admits(false)]
#[tokio::test]
async fn a_server_without_s256_signs_in_through_a_provider_or_is_refused_for_it(
    #[case] does_provider_admit: bool,
) {
    let server = serve_authorization_server(FakeServerAnswers {
        pkce_methods: &[],
        ..FakeServerAnswers::default()
    })
    .await;
    let flow = if does_provider_admit {
        ScriptedFlow::Completes {
            issuer: server.base.clone(),
        }
    } else {
        ScriptedFlow::NoFlow
    };
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(flow, "only", &calls)]).await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);

    let launched = harness.service.launch(&target, &[], &accounts).await;

    assert_eq!(*lock(&calls), ["only"], "the provider's flow is asked");
    if does_provider_admit {
        assert_eq!(
            launched
                .expect("the provider's flow opens the browser")
                .as_str(),
            scripted_browser_url().as_str()
        );
        let completions = settled_completions(&harness).await;
        assert_eq!(completions[0]["outcome"], "success");
    } else {
        assert!(
            matches!(
                &launched,
                Err(SignInLaunchError::Refused(
                    McpRefusal::ServerSignInUnsupported {
                        reason: SignInUnsupportedReason::NoS256Challenge,
                        ..
                    }
                ))
            ),
            "refused for the missing method, not {launched:?}"
        );
    }
}

/// A completed flow keeps the credentials with the issuer they came from, marks the server
/// signed in, records the provider as the admitted client, clearing the mark the daemon's own
/// client left, and appends one success event. Killed by a save without the issuer, by no
/// mark, and by recording the provider without clearing the mark.
#[tokio::test]
async fn a_completed_flow_keeps_the_sign_in_with_its_issuer_and_marks_it_signed_in() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(
        ScriptedFlow::Completes {
            issuer: server.base.clone(),
        },
        "only",
        &calls,
    )])
    .await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);
    let address = McpServerAddress::new(&server.base).expect("a server address");
    // The daemon's own client did not finish here before, so the press goes to the provider.
    harness
        .admitted_clients
        .mark_own_client_unfinished(&harness.service.custody.test_digest(&address).await)
        .await
        .expect("the mark is recorded");
    let mut signed_in = harness.service.custody.signed_in_servers();

    harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect("the provider's flow opens the browser");

    let digest = harness.service.custody.test_digest(&address).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        signed_in.wait_for(|addresses| addresses.contains(&digest)),
    )
    .await
    .expect("the server is marked signed in")
    .expect("the service is alive");
    let held = harness
        .service
        .custody
        .test_held_store(&address)
        .await
        .held()
        .await
        .expect("the keychain answers")
        .expect("the sign-in is kept");
    assert_eq!(
        held.credentials.issuer.as_deref(),
        Some(server.base.as_str())
    );
    assert_eq!(held.credentials.client_id, PROVIDER_CLIENT_ID);
    assert_eq!(held.credentials.granted_scopes, ["docs.read"]);
    let completions = settled_completions(&harness).await;
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0]["outcome"], "success");
    assert_eq!(completions[0]["provider"], provider.as_str());
    let admitted = harness
        .admitted_clients
        .read(&harness.service.custody.test_digest(&address).await)
        .await
        .expect("the admitted client reads")
        .expect("the provider is recorded");
    assert_eq!(admitted.provider, Some(provider));
    assert!(!admitted.is_own_client_unfinished);
}

/// A kept provider sign-in whose token ran out, its issuer written with a slash the server's
/// metadata leaves off, renews through the daemon's own store with its refresh token and its
/// client's secret, keeps that secret for the next renewal, and leaves the person's own saved
/// sign-ins byte for byte as they were. Killed by a renewal that reads or writes the person's
/// folder, by a kept sign-in that drops the refresh token or the secret, by a renewal save
/// that drops the secret, and by an issuer compared as exact text, which forgets the sign-in.
#[tokio::test]
async fn a_kept_provider_sign_in_renews_through_the_daemons_store_alone() {
    let person_home = tempfile::tempdir().expect("a person's home folder");
    let planted: Vec<(std::path::PathBuf, &[u8])> = vec![
        (
            person_home.path().join(".claude").join(".credentials.json"),
            br#"{"mcpOAuth":{"docs":{"accessToken":"test-person-token"}}}"#,
        ),
        (
            person_home.path().join(".codex").join(".credentials.json"),
            br#"{"docs":{"access_token":"test-person-token"}}"#,
        ),
    ];
    for (path, bytes) in &planted {
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("the folder is made");
        std::fs::write(path, bytes).expect("the person's file is planted");
    }
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(
        ScriptedFlow::Completes {
            issuer: format!("{}/", server.base),
        },
        "only",
        &calls,
    )])
    .await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);
    let address = McpServerAddress::new(&server.base).expect("a server address");
    harness
        .admitted_clients
        .mark_own_client_unfinished(&harness.service.custody.test_digest(&address).await)
        .await
        .expect("the mark is recorded");
    harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect("the provider's flow opens the browser");
    settled_completions(&harness).await;

    let authorizer = harness.authorizer(&server.base).await;
    let headers = authorizer
        .authorize(&Method::POST, &server.base, None)
        .await
        .expect("the token renews");

    assert!(headers.contains(&(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer test-access-token")
    )));
    let forms = lock(&server.token_forms).clone();
    let renewal = forms.last().expect("a token request was sent");
    for field in [
        ("grant_type", "refresh_token"),
        ("refresh_token", PROVIDER_REFRESH_TOKEN),
        ("client_id", PROVIDER_CLIENT_ID),
        ("client_secret", PROVIDER_CLIENT_SECRET),
    ] {
        assert!(
            renewal.contains(&(field.0.to_owned(), field.1.to_owned())),
            "{}",
            field.0
        );
    }
    let held = harness
        .service
        .custody
        .test_held_store(&address)
        .await
        .held()
        .await
        .expect("the keychain answers")
        .expect("the sign-in is kept");
    let held_tokens = serde_json::to_value(&held.credentials).expect("credentials write as JSON");
    assert_eq!(
        held_tokens["token_response"]["access_token"],
        "test-access-token"
    );
    assert_eq!(
        held.client_secret.as_ref().map(ExposeSecret::expose_secret),
        Some(PROVIDER_CLIENT_SECRET)
    );
    for (path, bytes) in &planted {
        assert_eq!(
            std::fs::read(path).expect("the person's file reads"),
            *bytes,
            "{}",
            path.display()
        );
    }
}

/// The own client's mark, as the admitted clients store reads it.
async fn is_own_client_unfinished(harness: &Harness, address: &McpServerAddress) -> bool {
    harness
        .admitted_clients
        .read(&harness.service.custody.test_digest(address).await)
        .await
        .expect("the admitted client reads")
        .is_some_and(|admitted| admitted.is_own_client_unfinished)
}

/// A provider's flow that opened the browser and then failed, after the daemon's own client did
/// not finish, clears that mark, so the next press reaches the daemon's own client again and runs
/// no provider's flow. Killed by a failed flow that leaves the mark, which sends every later press
/// to the provider's flow.
#[tokio::test]
async fn a_failed_provider_flow_sends_the_next_press_to_the_own_client() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(
        ScriptedFlow::Fails {
            failure: Some(ProviderSignInFailure::CodeNotRedeemed),
        },
        "only",
        &calls,
    )])
    .await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);
    let address = McpServerAddress::new(&server.base).expect("a server address");
    harness
        .admitted_clients
        .mark_own_client_unfinished(&harness.service.custody.test_digest(&address).await)
        .await
        .expect("the mark is recorded");

    let first = harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect("the provider's flow opens the browser");
    assert_eq!(first.as_str(), scripted_browser_url().as_str());
    let completions = settled_completions(&harness).await;
    assert_eq!(completions[0]["outcome"], "failure");
    assert!(!is_own_client_unfinished(&harness, &address).await);

    let next = harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect("the daemon's own client opens the browser");

    assert!(
        next.as_str()
            .starts_with(&format!("{}/authorize", server.base)),
        "the own client's authorization address opens, not {}",
        next.as_str()
    );
    assert_eq!(*lock(&calls), ["only"], "the provider's flow runs once");
}

/// A provider's flow that fails before the browser opens answers the launch as its driver's error
/// does: a provider refusal by its code, the driver's own fault as a fault of the daemon, and only
/// a sign-in that did not finish as `mcp.server.signInFailed`. Killed by every driver failure
/// answered `mcp.server.signInFailed`, and by a sign-in that did not finish answered as a fault.
#[rstest]
#[case::provider_unavailable(
    || DomainError::new("the provider failed", RefusalCode::ProviderUnavailable).into(),
    Some(RefusalCode::ProviderUnavailable)
)]
#[case::driver_fault(|| DriverError::Internal("the driver failed".into()), None)]
#[case::sign_in_not_finished(
    || DriverError::SignInFailed(ProviderSignInFailure::ReplyUnreadable),
    Some(RefusalCode::McpServerSignInFailed)
)]
#[tokio::test]
async fn a_provider_failure_before_the_browser_answers_as_its_driver_error(
    #[case] failure: fn() -> DriverError,
    #[case] expected_code: Option<RefusalCode>,
) {
    let server = serve_authorization_server(FakeServerAnswers {
        is_registration_refused: true,
        ..FakeServerAnswers::default()
    })
    .await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(
        ScriptedFlow::FailsBeforeBrowser { failure },
        "only",
        &calls,
    )])
    .await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);

    let refused = harness
        .service
        .launch(&target, &[], &accounts)
        .await
        .expect_err("no provider's flow opens the browser");

    let code = match HandlerError::from(refused) {
        HandlerError::Refused(refusal) => Some(refusal.code),
        HandlerError::Internal(_) => None,
        HandlerError::Canceled => panic!("a launch is never canceled"),
    };
    assert_eq!(code, expected_code);
}

/// A press that ran the providers' flows, after the daemon's own client did not finish, and then
/// had the own client's pushed request refused, answers that no provider's flow admits the server
/// without running the flows again. Killed by a refused push that runs every provider's flow a
/// second time.
#[tokio::test]
async fn a_refused_push_after_the_flows_ran_runs_them_no_more() {
    let server = serve_authorization_server(FakeServerAnswers {
        pushed_request_refusal: Some("invalid_client"),
        ..FakeServerAnswers::default()
    })
    .await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let harness = harness_with(vec![scripted_driver(ScriptedFlow::NoFlow, "only", &calls)]).await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);
    let address = McpServerAddress::new(&server.base).expect("a server address");
    harness
        .admitted_clients
        .mark_own_client_unfinished(&harness.service.custody.test_digest(&address).await)
        .await
        .expect("the mark is recorded");

    let refused = harness.service.launch(&target, &[], &accounts).await;

    assert!(
        matches!(
            &refused,
            Err(SignInLaunchError::Refused(
                McpRefusal::ServerSignInUnsupported {
                    reason: SignInUnsupportedReason::NoProviderFlow,
                    ..
                }
            ))
        ),
        "refused as no provider's flow admits it, not {refused:?}"
    );
    assert_eq!(*lock(&calls), ["only"], "the provider's flow runs once");
}

/// A provider's flow that names a page of another scheme ends at once, its flow forgotten, and the
/// sign-in is refused as unsupported. Killed by the flow kept running after the refusal.
#[tokio::test]
async fn a_provider_page_that_is_no_web_address_keeps_no_flow() {
    let server = serve_authorization_server(FakeServerAnswers {
        pkce_methods: &[],
        ..FakeServerAnswers::default()
    })
    .await;
    let mut driver = MockProviderDriver::new();
    driver
        .expect_sign_in_with_own_client()
        .returning(|request| {
            async move {
                request
                    .authorization_url
                    .send(Url::parse("ftp://login.example.com/authorize").expect("an address"))
                    .expect("the launch waits for the address");
                std::future::pending().await
            }
            .boxed()
        });
    let harness = harness_with(vec![Arc::new(driver)]).await;
    let provider = registered_providers(&harness).remove(0);
    let (target, accounts) = provider_target(&harness, &provider, &server);

    let launched = harness.service.launch(&target, &[], &accounts).await;

    assert!(
        matches!(
            &launched,
            Err(SignInLaunchError::Refused(
                McpRefusal::ServerSignInUnsupported {
                    reason: SignInUnsupportedReason::UnusableMetadata,
                    ..
                }
            ))
        ),
        "refused as unsupported, not {launched:?}"
    );
    assert!(lock(&harness.service.attempts).provider_flows.is_empty());
}

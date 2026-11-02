//! The sign-in through a provider's own client, for a server that does not admit the daemon's.
//!
//! - **Which provider.** The provider the server admitted before goes first, then the binding's,
//!   then every other registered provider in the registry's order; one with no account handed in
//!   is passed over, and one whose driver finds no entry of the person's for the binding (it has
//!   no flow for the server) hands on to the next. Any other failure before the browser opens, or
//!   no provider left, means no provider's flow admits the server; the launch decides what follows.
//! - **The browser.** The driver names the address the browser opens, which the launch answers.
//!   The flow goes on in a task the daemon's stop, a sign-out or a new launch for the server ends.
//!   The browser comes back to a loopback receiver bound for this flow, whose return is handed to
//!   the driver whole, and the browser is shown the flow's outcome; a driver that gave up the
//!   return before naming its address (its provider's own listener takes it) gets no receiver,
//!   and the listener closes.
//! - **The completion.** A completed flow's credentials are kept as the server's sign-in, which
//!   marks it signed in, unless the server was signed out since the flow began; the provider is
//!   recorded as the client the server admits, and the completion event is appended; a failed one
//!   appends its failure and records nothing.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mcp.server.signIn handler launches the sign-in that runs a provider's flow"
    )
)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use oauth2::basic::BasicTokenType;
use oauth2::{AccessToken, RefreshToken};
use reqwest::Url;
use rmcp::transport::auth::{
    CredentialStore as _, OAuthTokenResponse, StoredCredentials, VendorExtraTokenFields,
};
use secrecy::SecretString;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    ProviderSignInBrowser, ProviderSignInTakeover, ProviderSignInTakeoverRequest,
};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::binding::store::McpBindingKey;
use crate::errors::McpRefusal;
use crate::oauth::redirect_receiver::{
    CallbackAnswer, CallbackPath, RedirectCallback, RedirectCallbackOwner, RedirectListener,
    RedirectReceiver, ResultPage,
};
use crate::sign_in::completion_event::{SignInFailureReason, append_sign_in_completed};
use crate::sign_in::credential_store::SignOutGeneration;
use crate::sign_in::redemption::REDEMPTION_BOUND;
use crate::sign_in::service::{
    ATTEMPT_LIFETIME, AddressedServer, ProviderAccounts, SignInService, SignInTarget,
};

/// What a driver's flow came to: its credentials or its failure, or `None` when it was ended
/// first.
type FlowEnd = Option<Result<ProviderSignInTakeover, DriverError>>;

/// How a provider's flow began: the address the browser opens, or that no provider's flow admits
/// the server.
pub(super) enum ProviderFlowStart {
    /// A driver named the address the browser opens; the flow goes on behind it.
    Opened(Url),
    /// No provider offers a flow for the server, or the one asked failed before the browser
    /// opened, with that failure.
    NoneAdmits {
        /// Why the provider asked failed; `None` when no provider offers a flow.
        failure: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
}

/// Why a provider's flow ended before the browser opened, where its driver gave no failure.
#[derive(Debug, thiserror::Error)]
enum ProviderFlowError {
    /// The flow answered with no address for the browser to open.
    #[error("the provider's MCP sign-in ended before it named an address to open")]
    NoAuthorizationAddress,
    /// A new launch, a sign-out or the daemon's stop ended the flow first.
    #[error("the provider's MCP sign-in was ended before it named an address to open")]
    Ended,
}

// One flow under way: the server it signs in to, the provider whose flow it is and the stop that
// ends it, kept by the service under its id.
struct RunningFlow {
    binding: McpServerBindingRef,
    address: McpServerAddress,
    canonical_address: String,
    provider: ProviderId,
    flow_id: u64,
    stop: CancellationToken,
    // The server's sign-outs when the flow began; a later one keeps the flow's sign-in out.
    since: SignOutGeneration,
}

impl SignInService {
    /// Runs a provider's own flow to sign in to `target`'s `server`, the provider the server
    /// admitted first when it names one, each for its account in `provider_accounts`; answers the
    /// address the browser opens once a driver names one, or that no provider's flow admits the
    /// server. Refuses with `mcp.server.signInFailed`, carrying the cause, when the flow's
    /// listener cannot be bound or the daemon is stopping.
    pub(super) async fn run_provider_flow(
        self: &Arc<Self>,
        target: &SignInTarget,
        server: &AddressedServer,
        admitted_provider: Option<ProviderId>,
        provider_accounts: &ProviderAccounts,
    ) -> Result<ProviderFlowStart, McpRefusal> {
        let failed =
            |source: Box<dyn std::error::Error + Send + Sync>| McpRefusal::ServerSignInFailed {
                binding: Box::new(target.binding.clone()),
                source,
            };
        let listener =
            RedirectListener::bind(None, CallbackPath::PerServer(&server.canonical_address))
                .await
                .map_err(|error| failed(Box::new(error)))?;
        let since = self.custody.sign_out_generation(&server.address);
        let stop = self.revocations.token().child_token();
        let flow_id = self
            .keep_provider_flow(&server.canonical_address, stop.clone().drop_guard())
            .map_err(|error| failed(Box::new(error)))?;
        let binding_provider = McpBindingKey::of(&target.binding).provider;
        let mut candidates: Vec<(ProviderId, Arc<dyn ProviderDriver>)> = self
            .providers
            .drivers()
            .map(|(provider, driver)| (provider.clone(), Arc::clone(driver)))
            .collect();
        // A stable sort, so the providers after the first two keep the registry's order.
        candidates.sort_by_key(|(provider, _driver)| {
            if admitted_provider.as_ref() == Some(provider) {
                0
            } else if *provider == binding_provider {
                1
            } else {
                2
            }
        });

        for (provider, driver) in candidates {
            let Some(provider_account_id) = provider_accounts.get(&provider) else {
                continue;
            };
            let (authorization_url, opened) = oneshot::channel();
            let (browser_return, returned) = oneshot::channel();
            let request = ProviderSignInTakeoverRequest {
                provider_account_id: provider_account_id.clone(),
                binding: target.binding.clone(),
                root_folder: target.root_folder.clone(),
                server_address: server.address.clone(),
                redirect_url: listener.redirect_url().clone(),
                lifetime: ATTEMPT_LIFETIME,
                browser: ProviderSignInBrowser {
                    authorization_url,
                    browser_return: returned,
                },
            };
            let flow_stop = stop.clone();
            let mut flow = AbortOnDropHandle::new(tokio::spawn(async move {
                tokio::select! {
                    () = flow_stop.cancelled() => None,
                    takeover = driver.sign_in_with_own_client(request) => Some(takeover),
                }
            }));
            // The address comes first; a closed channel means the driver ended without one.
            if let Ok(browser_url) = opened.await {
                let running = RunningFlow {
                    binding: target.binding.clone(),
                    address: server.address.clone(),
                    canonical_address: server.canonical_address.clone(),
                    provider,
                    flow_id,
                    stop,
                    since,
                };
                // A driver whose provider's own listener takes the return gave it up already.
                let listener = (!browser_return.is_closed()).then_some(listener);
                self.follow_flow(running, flow, listener, &browser_url, browser_return);
                return Ok(ProviderFlowStart::Opened(browser_url));
            }
            let failure: Box<dyn std::error::Error + Send + Sync> = match (&mut flow).await {
                Ok(Some(Err(DriverError::NoPersonServerEntry(_)))) => {
                    tracing::debug!(
                        provider = provider.as_str(),
                        "a provider offers no MCP sign-in for the server; the next one is tried"
                    );
                    continue;
                }
                Ok(Some(Err(error))) => Box::new(error),
                Ok(Some(Ok(_takeover))) => Box::new(ProviderFlowError::NoAuthorizationAddress),
                Ok(None) => Box::new(ProviderFlowError::Ended),
                Err(error) => Box::new(error),
            };
            self.end_provider_flow(&server.canonical_address, Some(flow_id));
            return Ok(ProviderFlowStart::NoneAdmits {
                failure: Some(failure),
            });
        }
        self.end_provider_flow(&server.canonical_address, Some(flow_id));
        Ok(ProviderFlowStart::NoneAdmits { failure: None })
    }

    // Follows `flow` once its browser opened `browser_url`: serves the browser's return on
    // `listener`, where the driver waits for one, matched by the `state` the address carries, and
    // settles the flow when it ends, unless `running`'s stop ends it first.
    fn follow_flow(
        self: &Arc<Self>,
        running: RunningFlow,
        flow: AbortOnDropHandle<FlowEnd>,
        listener: Option<RedirectListener>,
        browser_url: &Url,
        browser_return: oneshot::Sender<Url>,
    ) {
        let (outcome, outcome_watch) = watch::channel(None);
        let forward = Arc::new(BrowserReturnForward {
            browser_return: Mutex::new(Some(browser_return)),
            outcome: outcome_watch,
            parked: Mutex::new(None),
        });
        // A return with no `state` to match cannot be told from another page's request, so an
        // address carrying none is opened with no receiver behind it.
        let state = browser_url
            .query_pairs()
            .find_map(|(name, value)| (name == "state").then(|| value.into_owned()));
        let receiver = listener.zip(state).map(|(listener, state)| {
            listener.receive(
                state,
                Arc::clone(&forward) as Arc<dyn RedirectCallbackOwner>,
            )
        });
        // The task holds the service weakly, so a flow under way never keeps it alive.
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            let stop = running.stop.clone();
            tokio::select! {
                () = stop.cancelled() => {}
                () = async {
                    let end = flow.await;
                    if let Some(service) = service.upgrade() {
                        service.settle_flow(&running, end, &outcome).await;
                    }
                } => {}
            }
            forward.park(receiver);
            if let Some(service) = service.upgrade() {
                service.end_provider_flow(&running.canonical_address, Some(running.flow_id));
            }
        });
    }

    // Settles the flow by how it ended: keeps a completed flow's sign-in, appends the one
    // completion event and publishes the outcome the browser is shown. A flow ended by its stop
    // settles nothing.
    async fn settle_flow(
        &self,
        running: &RunningFlow,
        end: Result<FlowEnd, tokio::task::JoinError>,
        outcome: &watch::Sender<Option<bool>>,
    ) {
        let failure = match end {
            Ok(Some(Ok(takeover))) => self.keep_takeover(running, takeover).await,
            Ok(Some(Err(error))) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    provider = running.provider.as_str(),
                    "a provider's MCP sign-in did not finish"
                );
                Some(SignInFailureReason::DidNotFinishInTime)
            }
            Ok(None) => return,
            Err(error) => {
                tracing::error!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a provider's MCP sign-in task failed"
                );
                Some(SignInFailureReason::DidNotFinishInTime)
            }
        };
        if let Err(error) = append_sign_in_completed(&self.events, &running.binding, failure).await
        {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "an MCP sign-in's completion event was not appended"
            );
        }
        outcome.send_replace(Some(failure.is_none()));
    }

    // Keeps `takeover` as the server's sign-in under its custody lock, its client's secret beside
    // the credentials, which marks the server signed in unless it was signed out since the flow
    // began, and records the provider as the client the server admits, which also clears the mark
    // that the daemon's own client did not finish. Answers why the sign-in was not kept.
    async fn keep_takeover(
        &self,
        running: &RunningFlow,
        takeover: ProviderSignInTakeover,
    ) -> Option<SignInFailureReason> {
        let client_secret = takeover.client_secret.clone().map(SecretString::from);
        let saved = self
            .custody
            .attempt_credential_store(&running.address, running.since, None, client_secret)
            .save(stored_credentials(takeover, SystemTime::now()))
            .await;
        if let Err(error) = saved {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a provider's MCP sign-in was not kept"
            );
            return Some(SignInFailureReason::SignInNotSaved);
        }
        if let Err(error) = self
            .admitted_clients
            .record_admitted_provider(&running.address, &running.provider)
            .await
        {
            // The sign-in is kept; the next press finds the provider's flow again.
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the provider an MCP server admitted was not recorded"
            );
        }
        None
    }
}

/// `takeover` as rmcp's credentials, received at `received_at`: its lifetime is counted from then,
/// as the renewal reads it, so a token past its expiry is renewed on first use.
fn stored_credentials(
    takeover: ProviderSignInTakeover,
    received_at: SystemTime,
) -> StoredCredentials {
    let token_type = if takeover
        .token_type
        .eq_ignore_ascii_case(BasicTokenType::Bearer.as_ref())
    {
        BasicTokenType::Bearer
    } else {
        BasicTokenType::Extension(takeover.token_type)
    };
    let mut token_response = OAuthTokenResponse::new(
        AccessToken::new(takeover.access_token),
        token_type,
        VendorExtraTokenFields::default(),
    );
    token_response.set_refresh_token(takeover.refresh_token.map(RefreshToken::new));
    let expires_in = takeover.expires_at.map(|expires_at| {
        expires_at
            .duration_since(received_at)
            .unwrap_or(Duration::ZERO)
    });
    token_response.set_expires_in(expires_in.as_ref());
    // A clock before 1970 reads as no lifetime counted, as rmcp's own clock does.
    let received_at_seconds = received_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    StoredCredentials::new(
        takeover.client_id,
        Some(token_response),
        takeover.scopes,
        Some(received_at_seconds),
    )
    .with_issuer(takeover.issuer)
}

// The owner of a provider flow's receiver: it hands the browser's first return to the driver and
// shows the browser the flow's outcome.
struct BrowserReturnForward {
    browser_return: Mutex<Option<oneshot::Sender<Url>>>,
    outcome: watch::Receiver<Option<bool>>,
    // The receiver, kept once a return was handed on until it has served its result page:
    // dropping it before its answer is written would cut the browser off.
    parked: Mutex<Option<RedirectReceiver>>,
}

impl BrowserReturnForward {
    // Keeps `receiver` while a return it took is being answered, and drops it otherwise.
    fn park(&self, receiver: Option<RedirectReceiver>) {
        if lock(&self.browser_return).is_none() {
            *lock(&self.parked) = receiver;
        }
    }
}

impl RedirectCallbackOwner for BrowserReturnForward {
    fn answer(&self, callback: RedirectCallback) -> BoxFuture<'_, CallbackAnswer> {
        Box::pin(async move {
            let Some(browser_return) = lock(&self.browser_return).take() else {
                return CallbackAnswer::Reject;
            };
            if browser_return.send(callback.return_url).is_err() {
                return CallbackAnswer::Page(ResultPage::NotFinished);
            }
            let mut outcome = self.outcome.clone();
            let settled =
                tokio::time::timeout(REDEMPTION_BOUND, outcome.wait_for(Option::is_some)).await;
            let is_signed_in = matches!(settled, Ok(Ok(outcome)) if *outcome == Some(true));
            CallbackAnswer::Page(if is_signed_in {
                ResultPage::SignedIn
            } else {
                ResultPage::NotFinished
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime};

    use futures::FutureExt as _;
    use reqwest::header::{AUTHORIZATION, HeaderValue};
    use reqwest::{Method, Url};
    use secrecy::ExposeSecret;
    use serde_json::Value;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::contract::sign_in::{
        BEARER_TOKEN_TYPE, NoPersonServerEntry, ProviderSignInTakeover,
    };
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
    use sidekicks_std::mutex_lock::lock;

    use crate::client::http::McpRequestAuthorizer as _;
    use crate::sign_in::canonical_server_address;
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
        /// Opens the browser at its address, then completes with credentials the server at the
        /// address issued.
        Completes { issuer: String },
        /// Opens the browser at its address, then fails.
        Fails,
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
                        ScriptedFlow::Completes { issuer } => issuer,
                        ScriptedFlow::Fails => {
                            request
                                .browser
                                .authorization_url
                                .send(scripted_browser_url())
                                .expect("the launch waits for the address");
                            return Err(DriverError::Internal("the scripted flow failed".into()));
                        }
                    };
                    request
                        .browser
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
    /// admitted client written, is not signed in and gets one failure event. Killed by writing the
    /// admitted row when the registration is refused, and by writing it on a failed flow.
    #[tokio::test]
    async fn a_refused_registration_whose_provider_flow_fails_writes_no_admitted_row() {
        let server = serve_authorization_server(FakeServerAnswers {
            is_registration_refused: true,
            ..FakeServerAnswers::default()
        })
        .await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let harness =
            harness_with(vec![scripted_driver(ScriptedFlow::Fails, "only", &calls)]).await;
        let provider = registered_providers(&harness).remove(0);
        let (target, accounts) = provider_target(&harness, &provider, &server);

        let browser_url = harness
            .service
            .launch(&target, &[], &accounts)
            .await
            .expect("the provider's flow opens the browser");

        assert_eq!(browser_url, scripted_browser_url());
        let completions = settled_completions(&harness).await;
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0]["outcome"], "failure");
        let address = McpServerAddress::new(&server.base).expect("a server address");
        assert_eq!(
            harness
                .admitted_clients
                .read(&address)
                .await
                .expect("the admitted client reads"),
            None
        );
        assert!(
            harness
                .service
                .custody
                .signed_in_addresses()
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
            browser_url.expect("the other provider's flow opens the browser"),
            scripted_browser_url()
        );
        assert_eq!(*lock(&calls), ["binding's", "other"]);
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
            .mark_own_client_unfinished(&address)
            .await
            .expect("the mark is recorded");
        let mut signed_in = harness.service.custody.signed_in_addresses();

        harness
            .service
            .launch(&target, &[], &accounts)
            .await
            .expect("the provider's flow opens the browser");

        let canonical_address = canonical_server_address(&address);
        tokio::time::timeout(
            Duration::from_secs(5),
            signed_in.wait_for(|addresses| addresses.contains(&canonical_address)),
        )
        .await
        .expect("the server is marked signed in")
        .expect("the service is alive");
        let held = harness
            .service
            .custody
            .credential_store(&address)
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
            .read(&address)
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
            .mark_own_client_unfinished(&address)
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
            .credential_store(&address)
            .held()
            .await
            .expect("the keychain answers")
            .expect("the sign-in is kept");
        let held_tokens =
            serde_json::to_value(&held.credentials).expect("credentials write as JSON");
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
}

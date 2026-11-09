//! The sign-in through a provider's own client, for a server that does not admit the daemon's.
//!
//! - **Which provider.** The provider the server admitted before goes first, then the binding's,
//!   then every other registered provider in the registry's order; one with no account handed in
//!   is passed over, and one whose driver finds no entry of the person's for the binding at the
//!   server's address (it has no flow for the server) hands on to the next. Any other failure
//!   before the browser opens, or no provider left, means no provider's flow admits the server;
//!   the launch decides what follows, and runs the flows at most once per press. A driver's
//!   failure answers the launch as the driver's error does, but for a sign-in that did not finish,
//!   which is `mcp.server.signInFailed`.
//! - **The browser.** The driver names the address the browser opens, which the launch answers.
//!   The flow goes on in a task the daemon's stop, a sign-out or a new launch for the server ends.
//!   For a driver whose descriptor says its flow can return to the daemon's receiver, the browser
//!   comes back to a loopback receiver bound for this flow, whose return is handed to the driver
//!   whole, and the browser is shown the flow's outcome; a driver that gave up the return before
//!   naming its address (its provider's own listener took it after all) gets no receiver, and the
//!   listener closes. A driver whose descriptor says no is told its provider's own listener takes
//!   the return, and no listener is bound for it.
//! - **The completion.** A completed flow's credentials are kept as the server's sign-in, which
//!   marks it signed in, unless the server was signed out since the flow began; the provider is
//!   recorded as the client the server admits, the sign-in kept or not, since the server admitted
//!   it, and the completion event is appended. A failed one records no provider, clears the mark
//!   that the daemon's own client did not finish, so the next press reaches the own client again,
//!   and appends its failure.

use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use oauth2::basic::BasicTokenType;
use oauth2::{AccessToken, RefreshToken};
use reqwest::Url;
use rmcp::transport::auth::{
    CredentialStore as _, OAuthClientConfig, OAuthTokenResponse, StoredCredentials,
    VendorExtraTokenFields,
};
use secrecy::SecretString;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::sign_in::{
    ProviderSignInReturn, ProviderSignInTakeover, ProviderSignInTakeoverRequest,
};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::binding::store::McpBindingKey;
use crate::errors::{McpRefusal, SignInLaunchError, SignInUnsupportedReason};
use crate::oauth::redirect_receiver::{
    CallbackAnswer, CallbackPath, RedirectCallback, RedirectCallbackOwner, RedirectListener,
    RedirectReceiver, ResultPage,
};
use crate::sign_in::address_digest::ServerAddressDigest;
use crate::sign_in::completion_event::{SignInFailureReason, append_sign_in_completed};
use crate::sign_in::credential_store::SignOutGeneration;
use crate::sign_in::redemption::REDEMPTION_BOUND;
use crate::sign_in::registration::SignInClient;
use crate::sign_in::service::{
    ATTEMPT_LIFETIME, AddressedServer, ProviderAccounts, SignInService, SignInTarget,
};

/// What a driver's flow came to: its credentials or its failure, or `None` when it was ended
/// first.
type FlowEnd = Option<Result<ProviderSignInTakeover, DriverError>>;

/// How a provider's flow began: the address the browser opens, or that no provider's flow admits
/// the server.
pub(super) enum ProviderFlowStart {
    /// A driver named the web address the browser opens; the flow goes on behind it.
    Opened(WebAddress),
    /// No provider offers a flow for the server, or the one asked failed before the browser
    /// opened, with that failure.
    NoneAdmits {
        /// Why the provider asked failed; `None` when no provider offers a flow.
        failure: Option<ProviderFlowError>,
    },
}

/// Why the provider's flow asked ended before the browser opened.
#[derive(Debug, thiserror::Error)]
pub(super) enum ProviderFlowError {
    /// Its driver failed.
    #[error(transparent)]
    Driver(DriverError),
    /// The flow answered with no address for the browser to open.
    #[error("the provider's MCP sign-in ended before it named an address to open")]
    NoAuthorizationAddress,
    /// A new launch, a sign-out or the daemon's stop ended the flow first.
    #[error("the provider's MCP sign-in was ended before it named an address to open")]
    Ended,
    /// The flow's task failed.
    #[error("the provider's MCP sign-in task failed")]
    TaskFailed(#[source] tokio::task::JoinError),
}

impl ProviderFlowError {
    // The launch's refusal for `binding` with this failure: a driver's failure answers as the
    // driver's error does, but for a sign-in that did not finish, which, like every other
    // failure, is `mcp.server.signInFailed`.
    fn into_launch_error(self, binding: &McpServerBindingRef) -> SignInLaunchError {
        match self {
            Self::Driver(error) if !matches!(error, DriverError::SignInFailed(_)) => {
                SignInLaunchError::Provider(error)
            }
            failure @ (Self::Driver(_)
            | Self::NoAuthorizationAddress
            | Self::Ended
            | Self::TaskFailed(_)) => McpRefusal::ServerSignInFailed {
                binding: Box::new(binding.clone()),
                source: Box::new(failure),
            }
            .into(),
        }
    }
}

/// Whether this press has run the providers' flows yet, and once it has, what they came to: no
/// flow admitted the server, with the failure of the one asked, where one failed.
pub(super) enum ProviderFlowsTried {
    /// The press has not run them.
    No,
    /// The press ran them and none admitted the server.
    NoneAdmitted(Option<ProviderFlowError>),
}

// One flow under way: the server it signs in to, the provider whose flow it is and the stop that
// ends it, kept by the service under its id.
struct RunningFlow {
    binding: McpServerBindingRef,
    address: McpServerAddress,
    digest: ServerAddressDigest,
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
    /// listener cannot be bound for a driver whose flow returns through it, or the daemon is
    /// stopping, and with `mcp.server.signInUnsupported` when the driver names a page that is no
    /// `http:` or `https:` address, the flow ended and its listener closed first.
    pub(super) async fn run_provider_flow(
        self: &Arc<Self>,
        target: &SignInTarget,
        server: &AddressedServer,
        digest: &ServerAddressDigest,
        admitted_provider: Option<ProviderId>,
        provider_accounts: &ProviderAccounts,
    ) -> Result<ProviderFlowStart, McpRefusal> {
        let failed =
            |source: Box<dyn std::error::Error + Send + Sync>| McpRefusal::ServerSignInFailed {
                binding: Box::new(target.binding.clone()),
                source,
            };
        let since = self.custody.sign_out_generation(digest);
        let stop = self.revocations.token().child_token();
        let flow_id = self
            .keep_provider_flow(digest, stop.clone().drop_guard())
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

        // The daemon's receiver, bound for the first driver whose flow can return to it.
        let mut listener: Option<RedirectListener> = None;
        for (provider, driver) in candidates {
            let Some(provider_account_id) = provider_accounts.get(&provider) else {
                continue;
            };
            let can_return_to_daemon_receiver = self
                .providers
                .descriptor(&provider)
                .expect("a provider the registry lists has its descriptor")
                .can_mcp_sign_in_return_to_daemon_receiver;
            let (browser_return, request_return) = if can_return_to_daemon_receiver {
                let bound = match listener.take() {
                    Some(bound) => bound,
                    None => {
                        match RedirectListener::bind(None, CallbackPath::PerServer(digest.as_str()))
                            .await
                        {
                            Ok(bound) => bound,
                            Err(error) => {
                                self.end_provider_flow(digest, Some(flow_id));
                                return Err(failed(Box::new(error)));
                            }
                        }
                    }
                };
                let redirect_url = bound.redirect_url().clone();
                listener = Some(bound);
                let (browser_return, returned) = oneshot::channel();
                (
                    Some(browser_return),
                    ProviderSignInReturn::ThroughDaemonReceiver {
                        redirect_url,
                        browser_return: returned,
                    },
                )
            } else {
                (None, ProviderSignInReturn::OwnListener)
            };
            let (authorization_url, opened) = oneshot::channel();
            let request = ProviderSignInTakeoverRequest {
                provider_account_id: provider_account_id.clone(),
                binding: target.binding.clone(),
                root_folder: target.root_folder.clone(),
                server_address: server.address.clone(),
                every_project_rows: target.every_project_rows.clone(),
                project_rows: target.project_rows.clone(),
                lifetime: ATTEMPT_LIFETIME,
                authorization_url,
                browser_return: request_return,
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
                // A driver can name a page of any scheme: its flow ends and its listener closes
                // before the refusal.
                let Some(page) = WebAddress::new(browser_url.as_str()) else {
                    drop(flow);
                    drop(listener);
                    self.end_provider_flow(digest, Some(flow_id));
                    return Err(McpRefusal::ServerSignInUnsupported {
                        binding: Box::new(target.binding.clone()),
                        reason: SignInUnsupportedReason::UnusableMetadata,
                    });
                };
                let running = RunningFlow {
                    binding: target.binding.clone(),
                    address: server.address.clone(),
                    digest: digest.clone(),
                    provider,
                    flow_id,
                    stop,
                    since,
                };
                // A driver whose provider's own listener takes the return gave it up already.
                let daemon_receiver = browser_return
                    .filter(|browser_return| !browser_return.is_closed())
                    .zip(listener.take());
                self.follow_flow(running, flow, daemon_receiver, &browser_url);
                return Ok(ProviderFlowStart::Opened(page));
            }
            let failure = match (&mut flow).await {
                Ok(Some(Err(DriverError::NoPersonServerEntry(_)))) => {
                    tracing::debug!(
                        provider = provider.as_str(),
                        "a provider offers no MCP sign-in for the server; the next one is tried"
                    );
                    continue;
                }
                Ok(Some(Err(error))) => ProviderFlowError::Driver(error),
                Ok(Some(Ok(_takeover))) => ProviderFlowError::NoAuthorizationAddress,
                Ok(None) => ProviderFlowError::Ended,
                Err(error) => ProviderFlowError::TaskFailed(error),
            };
            self.end_provider_flow(digest, Some(flow_id));
            return Ok(ProviderFlowStart::NoneAdmits {
                failure: Some(failure),
            });
        }
        self.end_provider_flow(digest, Some(flow_id));
        Ok(ProviderFlowStart::NoneAdmits { failure: None })
    }

    /// The launch's answer for every client but the daemon's own, whose configuration continues
    /// the launch: a provider's flow is run, the provider the server admitted first, unless this
    /// press ran the flows already (`tried`); where no provider's flow admits the server the
    /// sign-in is refused with the failure of the one asked, or as unsupported for the reason the
    /// client carries.
    pub(super) async fn answer_other_client(
        self: &Arc<Self>,
        target: &SignInTarget,
        server: &AddressedServer,
        digest: &ServerAddressDigest,
        client: SignInClient,
        provider_accounts: &ProviderAccounts,
        tried: &mut ProviderFlowsTried,
    ) -> ControlFlow<Result<WebAddress, SignInLaunchError>, OAuthClientConfig> {
        let binding = Box::new(target.binding.clone());
        let (admitted_provider, refusal_if_none_admits) = match client {
            SignInClient::OwnClient(own_client) => return ControlFlow::Continue(own_client),
            SignInClient::Unsupported { reason } => {
                return ControlFlow::Break(Err(McpRefusal::ServerSignInUnsupported {
                    binding,
                    reason,
                }
                .into()));
            }
            SignInClient::Failed { source } => {
                return ControlFlow::Break(Err(
                    McpRefusal::ServerSignInFailed { binding, source }.into()
                ));
            }
            SignInClient::ProviderFlow {
                admitted_provider,
                refusal_if_none_admits,
            } => (admitted_provider, refusal_if_none_admits),
            SignInClient::OwnClientUnfinished => (None, SignInUnsupportedReason::NoProviderFlow),
        };
        let failure = match std::mem::replace(tried, ProviderFlowsTried::No) {
            ProviderFlowsTried::NoneAdmitted(failure) => failure,
            ProviderFlowsTried::No => {
                match self
                    .run_provider_flow(target, server, digest, admitted_provider, provider_accounts)
                    .await
                {
                    Ok(ProviderFlowStart::Opened(browser_url)) => {
                        return ControlFlow::Break(Ok(browser_url));
                    }
                    Ok(ProviderFlowStart::NoneAdmits { failure }) => failure,
                    Err(refusal) => return ControlFlow::Break(Err(refusal.into())),
                }
            }
        };
        ControlFlow::Break(Err(match failure {
            Some(failure) => failure.into_launch_error(&binding),
            None => McpRefusal::ServerSignInUnsupported {
                binding,
                reason: refusal_if_none_admits,
            }
            .into(),
        }))
    }

    // Follows `flow` once its browser opened `browser_url`: serves the browser's return on the
    // `daemon_receiver`'s listener, where the driver waits for one on its sender, matched by the
    // `state` the address carries, and settles the flow when it ends, unless `running`'s stop ends
    // it first.
    fn follow_flow(
        self: &Arc<Self>,
        running: RunningFlow,
        flow: AbortOnDropHandle<FlowEnd>,
        daemon_receiver: Option<(oneshot::Sender<Url>, RedirectListener)>,
        browser_url: &Url,
    ) {
        let (browser_return, listener) = daemon_receiver.unzip();
        let (outcome, outcome_watch) = watch::channel(None);
        let forward = Arc::new(BrowserReturnForward {
            browser_return: Mutex::new(browser_return),
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
                service.end_provider_flow(&running.digest, Some(running.flow_id));
            }
        });
    }

    // Settles the flow by how it ended: keeps a completed flow's sign-in, appends the one
    // completion event and publishes the outcome the browser is shown. A flow that ended without a
    // sign-in clears the mark that the daemon's own client did not finish, so the next press
    // reaches the own client again, and carries its driver's kind of failure; any other failure,
    // the task's own among them, reads as not finished in time. A flow ended by its stop settles
    // nothing.
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
                self.clear_own_client_unfinished(running).await;
                Some(if let DriverError::SignInFailed(failure) = error {
                    SignInFailureReason::from(failure)
                } else {
                    SignInFailureReason::DidNotFinishInTime
                })
            }
            Ok(None) => return,
            Err(error) => {
                tracing::error!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a provider's MCP sign-in task failed"
                );
                self.clear_own_client_unfinished(running).await;
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

    // Clears the mark that the daemon's own client did not finish for `running`'s server, which a
    // flow that ended without signing in leaves to the own client again; a clear that does not
    // keep is logged.
    async fn clear_own_client_unfinished(&self, running: &RunningFlow) {
        if let Err(error) = self
            .admitted_clients
            .clear_own_client_unfinished(&running.digest)
            .await
        {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the mark that the daemon's own client did not finish an MCP sign-in was not \
                 cleared"
            );
        }
    }

    // Keeps `takeover` as the server's sign-in under its custody lock, its client's secret beside
    // the credentials, which marks the server signed in unless it was signed out since the flow
    // began, and records the provider as the client the server admits, kept or not, since the
    // flow completed at the server; the record also clears the mark that the daemon's own client
    // did not finish. Answers why the sign-in was not kept.
    async fn keep_takeover(
        &self,
        running: &RunningFlow,
        takeover: ProviderSignInTakeover,
    ) -> Option<SignInFailureReason> {
        let client_secret = takeover.client_secret.clone().map(SecretString::from);
        let saved = self
            .custody
            .attempt_credential_store(
                &running.digest,
                &running.address,
                running.since,
                None,
                client_secret,
            )
            .save(stored_credentials(takeover, SystemTime::now()))
            .await;
        if let Err(error) = self
            .admitted_clients
            .record_admitted_provider(&running.digest, &running.provider)
            .await
        {
            // The next press finds the provider's flow again.
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the provider an MCP server admitted was not recorded"
            );
        }
        let Err(error) = saved else {
            return None;
        };
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a provider's MCP sign-in was not kept"
        );
        Some(SignInFailureReason::SignInNotSaved)
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
mod tests;

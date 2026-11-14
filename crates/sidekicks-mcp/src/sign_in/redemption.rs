//! The browser's return to one sign-in attempt: the issuer check, then the code's redemption.
//!
//! - **The issuer check** runs on every callback, a code or an error alike. A callback whose `iss`
//!   is not the server's, or that leaves `iss` out where the server says it always sends one, is
//!   refused with 400 and the attempt keeps waiting, so a forged return cannot end the real one and
//!   no token request is sent for it.
//! - **No scope, once.** The first error a callback that passes carries, where the daemon picked
//!   the scopes, sends the browser on to a new page asking for no scope; the attempt keeps waiting
//!   on that page's `state`.
//! - **Settling.** A callback that passes takes the attempt out of the server's open attempts, so
//!   a new launch no longer ends it. An error settles it as a failure the daemon's own client did
//!   not finish, so the next press goes to a provider's flow; a code is exchanged through the
//!   attempt's manager, which keeps the tokens through the attempt's credential store, marking the
//!   server signed in. Either way the attempt appends its one completion event and the browser is
//!   sent to its result page; the attempt, and with it the listener, goes once that page has been
//!   served.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use rmcp::transport::auth::AuthError;
use sidekicks_std::mutex_lock::lock;

use crate::oauth::redirect_receiver::{
    AuthorizationResponse, CallbackAnswer, RedirectCallback, RedirectCallbackOwner, ResultPage,
};
use crate::sign_in::address_digest::ServerAddressDigest;
use crate::sign_in::completion_event::{SignInFailureReason, append_sign_in_completed};
use crate::sign_in::service::{SignInAttempt, SignInService};

/// How long the code's exchange may take: inside the 30 s the receiver holds the browser, so the
/// page the browser is sent to is the outcome the event records.
pub(super) const REDEMPTION_BOUND: Duration = Duration::from_secs(25);

/// The issuer a callback must name (RFC 9207), as the server's metadata gave it at the launch.
#[derive(Clone, Debug)]
pub(crate) struct ExpectedIssuer {
    issuer: Option<String>,
    is_required: bool,
}

impl ExpectedIssuer {
    /// The check for a server whose metadata names `issuer`, which sends `iss` with every response
    /// when `is_required`.
    pub(crate) fn new(issuer: Option<String>, is_required: bool) -> Self {
        Self {
            issuer,
            is_required,
        }
    }

    // Whether a callback naming `received` passes, by the same table the token exchange applies:
    // an `iss` must equal the issuer, an issuer the metadata never named admits no `iss`, and a
    // missing `iss` passes only where the server does not say it always sends one.
    fn admits(&self, received: Option<&str>) -> bool {
        match (self.issuer.as_deref(), received) {
            (Some(expected), Some(received)) => expected == received,
            (None, Some(_)) => false,
            (Some(_) | None, None) => !self.is_required,
        }
    }
}

/// The owner of one attempt's receiver: it checks each callback's issuer and settles the attempt
/// on the first one that passes.
pub(crate) struct AttemptRedemption {
    service: Weak<SignInService>,
    digest: ServerAddressDigest,
    attempt_id: u64,
    expected_issuer: ExpectedIssuer,
    // The settled attempt, kept until the receiver is done with its result page: dropping the
    // attempt drops the receiver, which before its answer is written would cut the browser off.
    settled: Mutex<Option<SignInAttempt>>,
}

impl AttemptRedemption {
    /// The owner of attempt `attempt_id`, kept by `service` under `digest`, whose
    /// callbacks must name `expected_issuer`.
    pub(crate) fn new(
        service: Weak<SignInService>,
        digest: ServerAddressDigest,
        attempt_id: u64,
        expected_issuer: ExpectedIssuer,
    ) -> Self {
        Self {
            service,
            digest,
            attempt_id,
            expected_issuer,
            settled: Mutex::new(None),
        }
    }
}

impl AttemptRedemption {
    // Opens the attempt's one more page asking for no scope, where it keeps one, and waits on
    // that page's `state`: `None` where it keeps none, or where the page could not be opened,
    // which settles the return as the failure it carried.
    async fn restart_without_scopes(&self, service: &SignInService) -> Option<CallbackAnswer> {
        let (manager, retry) =
            service.change_attempt(&self.digest, self.attempt_id, |attempt| {
                Some((Arc::clone(&attempt.manager), attempt.scope_retry.take()?))
            })?;
        let page = match retry.open_page(&manager).await {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP sign-in's page asking for no scope did not open"
                );
                return None;
            }
        };
        let expected_state = page.expected_state.clone();
        service.change_attempt(&self.digest, self.attempt_id, |attempt| {
            attempt.expected_state = expected_state;
            Some(())
        })?;
        tracing::info!(
            "the authorization server sent an MCP sign-in back with an error for the scopes the \
             daemon picked, so it asks again for none"
        );
        Some(CallbackAnswer::Restart {
            browser_url: page.browser_url,
            expected_state: page.expected_state,
        })
    }
}

impl RedirectCallbackOwner for AttemptRedemption {
    fn answer(&self, callback: RedirectCallback) -> BoxFuture<'_, CallbackAnswer> {
        Box::pin(async move {
            if !self.expected_issuer.admits(callback.issuer.as_deref()) {
                return CallbackAnswer::Reject;
            }
            // An attempt already ended (replaced, past its life, signed out or stopped) appends
            // nothing and its receiver is closing; one being settled by an earlier callback keeps
            // the receiver waiting for that settling's answer.
            let Some(service) = self.service.upgrade() else {
                return CallbackAnswer::Reject;
            };
            if matches!(callback.response, AuthorizationResponse::Error { .. })
                && let Some(answer) = self.restart_without_scopes(&service).await
            {
                return answer;
            }
            let Some(attempt) = service.take_attempt(&self.digest, Some(self.attempt_id)) else {
                return CallbackAnswer::Reject;
            };
            // Settled on a task of its own, so a browser that leaves mid-exchange still gets its
            // sign-in kept and its one event appended.
            let settling = tokio::spawn(settle(service, attempt, callback));
            match settling.await {
                Ok((page, attempt)) => {
                    *lock(&self.settled) = Some(attempt);
                    CallbackAnswer::Page(page)
                }
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "an MCP sign-in's settling task failed"
                    );
                    CallbackAnswer::Page(ResultPage::NotFinished)
                }
            }
        })
    }
}

// Settles the taken attempt on `callback`: redeems a code, or marks that the daemon's own client
// did not finish on an error, appends the one completion event, and answers the result page with
// the attempt to keep.
async fn settle(
    service: Arc<SignInService>,
    attempt: SignInAttempt,
    callback: RedirectCallback,
) -> (ResultPage, SignInAttempt) {
    let failure = match callback.response {
        AuthorizationResponse::Error { error, .. } => {
            tracing::info!(
                error_code = error.as_str(),
                "the authorization server sent an MCP sign-in back with an error"
            );
            service.mark_unfinished_logged(&attempt.digest).await;
            Some(SignInFailureReason::CallbackCarriedError)
        }
        AuthorizationResponse::Code(code) => redeem(&attempt, &code, callback.issuer.as_deref())
            .await
            .err(),
    };
    if let Err(error) = append_sign_in_completed(&service.events, &attempt.binding, failure).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "an MCP sign-in's completion event was not appended"
        );
    }
    let page = match failure {
        None => ResultPage::SignedIn,
        Some(_) => ResultPage::NotFinished,
    };
    (page, attempt)
}

// Exchanges `code` for tokens through the attempt's manager, which checks `issuer` once more and
// keeps the tokens through the attempt's credential store.
async fn redeem(
    attempt: &SignInAttempt,
    code: &str,
    issuer: Option<&str>,
) -> Result<(), SignInFailureReason> {
    let exchange =
        attempt
            .manager
            .exchange_code_for_token_with_issuer(code, &attempt.expected_state, issuer);
    match tokio::time::timeout(REDEMPTION_BOUND, exchange).await {
        Ok(Ok(_token)) => Ok(()),
        Ok(Err(error)) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "an MCP sign-in's code was not redeemed and kept"
            );
            // rmcp's error is open to new variants, so only the store's refusal is named.
            Err(if matches!(error, AuthError::CredentialStoreError(_)) {
                SignInFailureReason::SignInNotSaved
            } else {
                SignInFailureReason::CodeNotRedeemed
            })
        }
        Err(elapsed) => {
            tracing::warn!(
                error = &elapsed as &(dyn std::error::Error + 'static),
                "an MCP sign-in's code exchange did not finish in time"
            );
            Err(SignInFailureReason::DidNotFinishInTime)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use reqwest::Url;
    use rstest::rstest;
    use secrecy::{ExposeSecret, SecretString};
    use serde_json::Value;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_provider::captured_logs::CapturedLogs;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    use super::SignInFailureReason;
    use crate::sign_in::service::{
        AddressedServer, OwnerIssuedClient, ProviderAccounts, SignInServer, SignInTarget,
    };
    use crate::sign_in::test_service::{
        FakeServerAnswers, NAMED_METADATA_PATH, REFUSED_CODE_DESCRIPTION, REGISTERED_CLIENT_SECRET,
        addressed_target, harness, launch_to_browser, serve_authorization_server,
    };

    const FORGED_ISSUER: &str = "http://attacker.example";

    // The browser URL's parameter `name`.
    fn parameter(browser_url: &Url, name: &str) -> String {
        browser_url
            .query_pairs()
            .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
            .expect("the browser address names the parameter")
    }

    // Sends the browser's return to the attempt behind `browser_url` with the parameters
    // `parameters` beside its `state`, and answers the status and the `Location`.
    async fn return_to(browser_url: &Url, parameters: &[(&str, &str)]) -> (String, Option<String>) {
        let mut callback =
            Url::parse(&parameter(browser_url, "redirect_uri")).expect("the redirect is a URL");
        callback
            .query_pairs_mut()
            .extend_pairs(parameters)
            .append_pair("state", &parameter(browser_url, "state"));
        let host = format!(
            "{}:{}",
            callback.host_str().expect("a host"),
            callback.port().expect("a port")
        );
        let request = format!(
            "GET {}?{} HTTP/1.1\r\nHost: {host}\r\n\r\n",
            callback.path(),
            callback.query().expect("a query")
        );
        let mut stream = TcpStream::connect(&host)
            .await
            .expect("the receiver accepts");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("the request is written");
        let mut answer = Vec::new();
        tokio::time::timeout(Duration::from_secs(40), stream.read_to_end(&mut answer))
            .await
            .expect("the answer ends while the browser is held")
            .expect("the answer is read");
        let answer = String::from_utf8_lossy(&answer).into_owned();
        let status = answer.split(' ').nth(1).expect("a status line").to_owned();
        let location = answer.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("location")
                .then(|| value.trim().to_owned())
        });
        (status, location)
    }

    /// A callback naming another issuer, or none where the server says it always sends one, is
    /// refused with no token request, and the real callback after it still signs in with one
    /// success event, the secret the server issued the daemon's client kept with the sign-in.
    /// Killed by a check that skips error callbacks or the missing `iss` (the forged return
    /// settles the attempt, the real one gets 400), by an owner that settles before the check (a
    /// token request, or a failure event, for the forged return), and by a registration whose
    /// secret is not kept.
    #[rstest]
    #[case::a_code_from_another_issuer(&[("code", "forged-code"), ("iss", FORGED_ISSUER)])]
    #[case::a_code_without_its_issuer(&[("code", "forged-code")])]
    #[case::an_error_from_another_issuer(&[("error", "access_denied"), ("iss", FORGED_ISSUER)])]
    #[tokio::test]
    async fn a_return_from_another_issuer_is_refused_and_the_real_one_still_signs_in(
        #[case] forged: &[(&str, &str)],
    ) {
        let server = serve_authorization_server(FakeServerAnswers {
            is_issuer_in_response: true,
            ..FakeServerAnswers::default()
        })
        .await;
        let harness = harness().await;
        let browser_url = launch_to_browser(&harness, &addressed_target(&server.base)).await;
        let signed_in = harness.service.custody.signed_in_servers();

        let (status, _) = return_to(&browser_url, forged).await;

        assert_eq!(status, "400");
        assert_eq!(server.token_requests.load(Ordering::SeqCst), 0);
        assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());

        let (status, location) = return_to(
            &browser_url,
            &[("code", "test-code"), ("iss", &server.base)],
        )
        .await;

        assert_eq!(status, "303");
        assert_eq!(location.as_deref(), Some("/signed-in"));
        assert_eq!(server.token_requests.load(Ordering::SeqCst), 1);
        let completions = harness.completions();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0]["outcome"], "success");
        assert_eq!(completions[0]["provider"], "provider-a");
        assert_eq!(completions[0]["scope"], "user");
        assert_eq!(completions[0]["serverName"], "docs");
        assert!(completions[0].get("failureReason").is_none());
        let address = McpServerAddress::new(&server.base).expect("a server address");
        assert!(
            signed_in
                .borrow()
                .contains(&harness.service.custody.test_digest(&address).await)
        );
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
            held.client_secret.as_ref().map(ExposeSecret::expose_secret),
            Some(REGISTERED_CLIENT_SECRET)
        );
    }

    /// A return that settles as a failure appends one failure event carrying the daemon's own
    /// reason and none of the server's words, and leaves the server signed out; an error sent
    /// back marks that the daemon's own client did not finish, so the next press goes to a
    /// provider's flow. Killed by appending the server's text as the reason, by a second or a
    /// missing event, and by an error callback that marks nothing.
    #[rstest]
    #[case::the_server_sent_an_error(
        false,
        &[("error", "access_denied"), ("error_description", REFUSED_CODE_DESCRIPTION)],
        SignInFailureReason::CallbackCarriedError,
        0,
        true
    )]
    #[case::the_server_refused_the_code(
        true,
        &[("code", "test-code")],
        SignInFailureReason::CodeNotRedeemed,
        1,
        false
    )]
    #[tokio::test]
    async fn a_failed_sign_in_appends_one_failure_in_the_daemons_words(
        #[case] is_code_refused: bool,
        #[case] parameters: &[(&str, &str)],
        #[case] reason: SignInFailureReason,
        #[case] token_requests: usize,
        #[case] is_marked_unfinished: bool,
    ) {
        let server = serve_authorization_server(FakeServerAnswers {
            is_issuer_in_response: true,
            is_code_refused,
            ..FakeServerAnswers::default()
        })
        .await;
        let harness = harness().await;
        let browser_url = launch_to_browser(&harness, &addressed_target(&server.base)).await;
        let mut returned = parameters.to_vec();
        returned.push(("iss", &server.base));

        let (status, location) = return_to(&browser_url, &returned).await;

        assert_eq!(status, "303");
        assert_eq!(location.as_deref(), Some("/sign-in-failed"));
        assert_eq!(server.token_requests.load(Ordering::SeqCst), token_requests);
        let completions = harness.completions();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0]["outcome"], "failure");
        assert_eq!(
            completions[0]["failureReason"],
            Value::from(reason.as_str())
        );
        let payload = completions[0].to_string();
        assert!(!payload.contains(REFUSED_CODE_DESCRIPTION), "{payload}");
        assert!(!payload.contains("access_denied"), "{payload}");
        assert!(!payload.contains(&server.base), "{payload}");
        assert!(
            harness
                .service
                .custody
                .signed_in_servers()
                .borrow()
                .is_empty()
        );
        let address = McpServerAddress::new(&server.base).expect("a server address");
        assert_eq!(
            harness
                .admitted_clients
                .read(&harness.service.custody.test_digest(&address).await)
                .await
                .expect("the admitted client reads")
                .is_some_and(|admitted| admitted.is_own_client_unfinished),
            is_marked_unfinished
        );
    }

    /// A server that sends the browser back with an error for the scopes the daemon picked from
    /// the metadata the entry names gets one more page asking for no scope, and its return signs
    /// in; a second error, or the first where the entry pins its scopes, settles as the failure.
    /// Killed by no retry (the first error settles), by a retry that still asks for the scopes, by
    /// a receiver or an exchange left on the first page's `state` (the second return is refused
    /// or its code not redeemed), by a retry with no bound (the second error opens a third page),
    /// and by a retry of pinned scopes.
    #[rstest]
    #[case::then_a_code(&[], &[("code", "test-code")], Some("/signed-in"))]
    #[case::then_an_error_again(&[], &[("error", "invalid_scope")], Some("/sign-in-failed"))]
    #[case::pinned_scopes(&["read"], &[], None)]
    #[tokio::test]
    async fn a_refused_pick_of_scopes_asks_once_more_for_none(
        #[case] entry_scopes: &[&str],
        #[case] second_return: &[(&str, &str)],
        #[case] second_location: Option<&str>,
    ) {
        let server = serve_authorization_server(FakeServerAnswers::default()).await;
        let harness = harness().await;
        let metadata_address =
            Url::parse(&format!("{}{NAMED_METADATA_PATH}", server.base)).expect("a URL");
        let target = SignInTarget {
            server: SignInServer::Address(Box::new(AddressedServer::new(
                McpServerAddress::new(&server.base).expect("a server address"),
                None,
                None,
                Some(metadata_address),
                false,
            ))),
            ..addressed_target(&server.base)
        };
        let entry_scopes: Vec<String> =
            entry_scopes.iter().map(|&scope| scope.to_owned()).collect();
        let browser_url = match harness
            .service
            .launch(&target, &entry_scopes, &ProviderAccounts::new())
            .await
        {
            Ok(browser_url) => Url::parse(browser_url.as_str()).expect("a web address parses"),
            Err(error) => panic!("the sign-in opens the browser: {error:?}"),
        };
        assert_ne!(parameter(&browser_url, "scope"), "");

        let (status, location) = return_to(&browser_url, &[("error", "invalid_scope")]).await;

        assert_eq!(status, "303");
        let Some(second_location) = second_location else {
            assert_eq!(location.as_deref(), Some("/sign-in-failed"));
            return;
        };
        let retried = Url::parse(&location.expect("the browser is sent on")).expect("a URL");
        assert!(
            !retried.query_pairs().any(|(name, _)| name == "scope"),
            "{retried}"
        );
        assert_ne!(
            parameter(&retried, "state"),
            parameter(&browser_url, "state")
        );
        assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());

        let (status, location) = return_to(&retried, second_return).await;

        assert_eq!(status, "303");
        assert_eq!(location.as_deref(), Some(second_location));
        let completions = harness.completions();
        assert_eq!(completions.len(), 1);
        let is_signed_in = second_location == "/signed-in";
        assert_eq!(
            completions[0]["outcome"],
            if is_signed_in { "success" } else { "failure" }
        );
        assert_eq!(
            !harness
                .service
                .custody
                .signed_in_servers()
                .borrow()
                .is_empty(),
            is_signed_in
        );
    }

    /// A client its owner issued with a secret signs in with that secret: the code's exchange
    /// sends it beside the owner's id, and the keychain keeps it with the sign-in for each
    /// renewal, while no event, no row or file of the database and no log line carries it.
    /// Killed by the owner's secret left off the client the exchange goes through (no
    /// `client_secret` in the token form, none kept), and by any event, row or log line that
    /// writes it.
    #[tokio::test]
    async fn an_owners_client_secret_reaches_the_token_endpoint_and_no_row_or_log() {
        const OWNER_CLIENT_SECRET: &str = "test-owner-client-secret";
        let (logs, _capture) = CapturedLogs::start();
        let server = serve_authorization_server(FakeServerAnswers {
            is_registration_refused: true,
            ..FakeServerAnswers::default()
        })
        .await;
        let harness = harness().await;
        let target = SignInTarget {
            server: SignInServer::Address(Box::new(AddressedServer::new(
                McpServerAddress::new(&server.base).expect("a server address"),
                Some(OwnerIssuedClient {
                    client_id: Some("owner-client".to_owned()),
                    client_secret: Some(SecretString::from(OWNER_CLIENT_SECRET)),
                    callback: None,
                }),
                None,
                None,
                false,
            ))),
            ..addressed_target(&server.base)
        };
        let browser_url = launch_to_browser(&harness, &target).await;

        let (status, location) = return_to(&browser_url, &[("code", "test-code")]).await;

        assert_eq!(status, "303");
        assert_eq!(location.as_deref(), Some("/signed-in"));
        let forms = server.token_forms.lock().expect("never poisoned").clone();
        assert_eq!(forms.len(), 1);
        for field in [
            ("client_id", "owner-client"),
            ("client_secret", OWNER_CLIENT_SECRET),
        ] {
            assert!(
                forms[0]
                    .iter()
                    .any(|(name, value)| (name.as_str(), value.as_str()) == field),
                "the token form carries {}",
                field.0
            );
        }
        let address = McpServerAddress::new(&server.base).expect("a server address");
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
            held.client_secret.as_ref().map(ExposeSecret::expose_secret),
            Some(OWNER_CLIENT_SECRET)
        );
        let completions = Value::from(harness.completions()).to_string();
        assert!(completions.contains("success"), "{completions}");
        assert!(!completions.contains(OWNER_CLIENT_SECRET), "{completions}");
        let database_folder = harness
            .database
            .path()
            .parent()
            .expect("the database sits in a folder")
            .to_owned();
        for file in std::fs::read_dir(&database_folder).expect("the database folder reads") {
            let path = file.expect("a database file is listed").path();
            let bytes = std::fs::read(&path).expect("a database file reads");
            assert!(
                !bytes
                    .windows(OWNER_CLIENT_SECRET.len())
                    .any(|window| window == OWNER_CLIENT_SECRET.as_bytes()),
                "{} holds the secret",
                path.display()
            );
        }
        assert!(!logs.text().contains(OWNER_CLIENT_SECRET));
    }
}

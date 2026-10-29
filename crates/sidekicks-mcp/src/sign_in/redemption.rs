//! The browser's return to one sign-in attempt: the issuer check, then the code's redemption.
//!
//! - **The issuer check** runs on every callback, a code or an error alike. A callback whose `iss`
//!   is not the server's, or that leaves `iss` out where the server says it always sends one, is
//!   refused with 400 and the attempt keeps waiting, so a forged return cannot end the real one and
//!   no token request is sent for it.
//! - **Settling.** A callback that passes takes the attempt out of the server's open attempts, so
//!   a new launch no longer ends it. An error settles it as a failure; a code is exchanged through
//!   the attempt's manager, which keeps the tokens through the attempt's credential store. Either
//!   way the attempt appends its one completion event and the browser is sent to its result page;
//!   the attempt, and with it the listener, goes once that page has been served.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the sign-in service whose launch hands the receiver \
                  its owner"
    )
)]

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use rmcp::transport::auth::AuthError;
use sidekicks_std::mutex_lock::lock;

use crate::oauth::redirect_receiver::{
    AuthorizationResponse, CallbackAnswer, RedirectCallback, RedirectCallbackOwner, ResultPage,
};
use crate::sign_in::completion_event::{SignInFailureReason, append_sign_in_completed};
use crate::sign_in::service::{SignInAttempt, SignInService};

/// How long the code's exchange may take: inside the 30 s the receiver holds the browser, so the
/// page the browser is sent to is the outcome the event records.
const REDEMPTION_BOUND: Duration = Duration::from_secs(25);

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
    canonical_address: String,
    attempt_id: u64,
    expected_issuer: ExpectedIssuer,
    // The settled attempt, kept until the receiver is done with its result page: dropping the
    // attempt drops the receiver, which before its answer is written would cut the browser off.
    settled: Mutex<Option<SignInAttempt>>,
}

impl AttemptRedemption {
    /// The owner of attempt `attempt_id`, kept by `service` under `canonical_address`, whose
    /// callbacks must name `expected_issuer`.
    pub(crate) fn new(
        service: Weak<SignInService>,
        canonical_address: String,
        attempt_id: u64,
        expected_issuer: ExpectedIssuer,
    ) -> Self {
        Self {
            service,
            canonical_address,
            attempt_id,
            expected_issuer,
            settled: Mutex::new(None),
        }
    }
}

impl RedirectCallbackOwner for AttemptRedemption {
    fn answer(&self, callback: RedirectCallback) -> BoxFuture<'_, CallbackAnswer> {
        Box::pin(async move {
            if !self.expected_issuer.admits(callback.issuer.as_deref()) {
                return CallbackAnswer::Reject;
            }
            // An attempt already ended (replaced, past its life, signed out or stopped) appends
            // nothing; its receiver is closing.
            let Some(service) = self.service.upgrade() else {
                return CallbackAnswer::Page(ResultPage::NotFinished);
            };
            let Some(attempt) =
                service.take_attempt(&self.canonical_address, Some(self.attempt_id))
            else {
                return CallbackAnswer::Page(ResultPage::NotFinished);
            };
            // Settled on a task of its own, so a browser that leaves mid-exchange still gets its
            // sign-in kept and its one event appended.
            let settling = tokio::spawn(settle(
                service,
                self.canonical_address.clone(),
                attempt,
                callback,
            ));
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

// Settles the taken attempt on `callback`: redeems a code, marks the server signed in on success,
// appends the one completion event, and answers the result page with the attempt to keep.
async fn settle(
    service: Arc<SignInService>,
    canonical_address: String,
    attempt: SignInAttempt,
    callback: RedirectCallback,
) -> (ResultPage, SignInAttempt) {
    let failure = match callback.response {
        AuthorizationResponse::Error { error, .. } => {
            tracing::info!(
                error_code = error.as_str(),
                "the authorization server sent an MCP sign-in back with an error"
            );
            Some(SignInFailureReason::CallbackCarriedError)
        }
        AuthorizationResponse::Code(code) => redeem(&attempt, &code, callback.issuer.as_deref())
            .await
            .err(),
    };
    if failure.is_none() {
        service.mark_signed_in(&canonical_address);
    }
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
            Err(match error {
                AuthError::CredentialStoreError(_) => SignInFailureReason::SignInNotSaved,
                _ => SignInFailureReason::CodeNotRedeemed,
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
    use serde_json::Value;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    use super::SignInFailureReason;
    use crate::sign_in::canonical_server_address;
    use crate::sign_in::test_service::{
        REFUSED_CODE_DESCRIPTION, addressed_target, harness, launch_to_browser,
        serve_authorization_server,
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
    /// success event. Killed by a check that skips error callbacks or the missing `iss` (the forged
    /// return settles the attempt, the real one gets 400), and by an owner that settles before
    /// the check (a token request, or a failure event, for the forged return).
    #[rstest]
    #[case::a_code_from_another_issuer(&[("code", "forged-code"), ("iss", FORGED_ISSUER)])]
    #[case::a_code_without_its_issuer(&[("code", "forged-code")])]
    #[case::an_error_from_another_issuer(&[("error", "access_denied"), ("iss", FORGED_ISSUER)])]
    #[tokio::test]
    async fn a_return_from_another_issuer_is_refused_and_the_real_one_still_signs_in(
        #[case] forged: &[(&str, &str)],
    ) {
        let server = serve_authorization_server(true, false).await;
        let harness = harness().await;
        let browser_url = launch_to_browser(&harness, &addressed_target(&server.base)).await;
        let signed_in = harness.service.signed_in_addresses();

        let (status, _) = return_to(&browser_url, forged).await;

        assert_eq!(status, "400");
        assert_eq!(server.token_requests.load(Ordering::SeqCst), 0);
        assert!(harness.completions().is_empty());

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
                .contains(&canonical_server_address(&address))
        );
    }

    /// A return that settles as a failure appends one failure event carrying the daemon's own
    /// reason and none of the server's words, and leaves the server signed out. Killed by
    /// appending the server's text as the reason, and by a second or a missing event.
    #[rstest]
    #[case::the_server_sent_an_error(
        false,
        &[("error", "access_denied"), ("error_description", REFUSED_CODE_DESCRIPTION)],
        SignInFailureReason::CallbackCarriedError,
        0
    )]
    #[case::the_server_refused_the_code(
        true,
        &[("code", "test-code")],
        SignInFailureReason::CodeNotRedeemed,
        1
    )]
    #[tokio::test]
    async fn a_failed_sign_in_appends_one_failure_in_the_daemons_words(
        #[case] is_code_refused: bool,
        #[case] parameters: &[(&str, &str)],
        #[case] reason: SignInFailureReason,
        #[case] token_requests: usize,
    ) {
        let server = serve_authorization_server(true, is_code_refused).await;
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
        assert!(harness.service.signed_in_addresses().borrow().is_empty());
    }
}

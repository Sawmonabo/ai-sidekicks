//! Codex's sign-in state as `account/read` reports it, read into the driver's probe answer and into
//! the account a sign-in left, the sign-in read that tells a failed resume needing a new sign-in
//! from one needing recovery, and the renewing read that has Codex renew a home's sign-in.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;

use crate::driver::codex::app_server_protocol::GetAccountParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::session_control::auth_probe::{
    DriverAuthProbeResult, DriverAuthProbeStatus, build_auth_probe_result,
};
use crate::lenient_json::read_lenient;

/// The account read, which answers the sign-in Codex holds without touching a conversation.
const CODEX_ACCOUNT_READ_METHOD: &str = "account/read";

/// How long the sign-in probe waits: it reads the home's local sign-in and gates admission.
pub(crate) const CODEX_AUTH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a failed resume's sign-in read waits; short, so it never delays the failure.
const CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT: Duration = Duration::from_secs(2);

/// The members of an `account/read` reply the readers take; the account's email and plan are kept
/// only to name the account on its row, never logged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountReadReply {
    #[serde(default, with = "serde_with::rust::double_option")]
    #[expect(
        clippy::option_option,
        reason = "an absent account and a `null` one are two different answers"
    )]
    account: Option<Option<Box<RawValue>>>,
    requires_openai_auth: Option<bool>,
}

/// The members of an account the readers take: its sign-in kind, a closed tag, its email and its
/// plan, each read as text and dropped where it is anything else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountKind {
    #[serde(rename = "type")]
    kind: Option<Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    email: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    plan_type: Option<String>,
}

/// The account an `account/read` reply names.
pub(crate) enum CodexAccountReading {
    /// An account is signed in: its sign-in kind as Codex names it, and the email and plan it
    /// names.
    SignedIn {
        /// The sign-in kind, `chatgpt`, `apiKey` or `amazonBedrock` at the pinned release.
        kind: String,
        /// The account's email, where it names a non-empty one.
        email: Option<String>,
        /// The account's plan in Codex's word, where it names a non-empty one.
        plan: Option<String>,
    },
    /// No account is signed in.
    SignedOut,
    /// The reply could not be read, so it says nothing of the sign-in.
    Unreadable,
}

/// How an account Codex names by the sign-in `kind` signs in: a `ChatGPT` sign-in is a
/// subscription, an API key is one, a Bedrock sign-in comes from elsewhere, and any other kind is
/// unknown.
pub(crate) fn read_codex_auth_mode(kind: &str) -> ProviderAuthMode {
    match kind {
        "chatgpt" => ProviderAuthMode::OauthSubscription,
        "apiKey" => ProviderAuthMode::ApiKey,
        "amazonBedrock" => ProviderAuthMode::External,
        _ => ProviderAuthMode::Unknown,
    }
}

/// Asks `connection` for the account signed in, without a refresh, waiting at most `timeout`.
/// Fails as the request does; a reply it cannot read answers `Unreadable`.
pub(crate) async fn read_codex_account(
    connection: &CodexAppServerConnection,
    timeout: Duration,
) -> Result<CodexAccountReading, CodexError> {
    let reply = request_account(connection, false, timeout).await?;
    let Some(reply) = read_codex_object::<AccountReadReply>(reply.get()) else {
        return Ok(CodexAccountReading::Unreadable);
    };
    Ok(match reply.account {
        Some(Some(account)) => match read_codex_object::<AccountKind>(account.get()) {
            Some(AccountKind {
                kind: Some(Value::String(kind)),
                email,
                plan_type,
            }) if !kind.is_empty() => CodexAccountReading::SignedIn {
                kind,
                email: email.filter(|email| !email.is_empty()),
                plan: plan_type.filter(|plan| !plan.is_empty()),
            },
            Some(_) | None => CodexAccountReading::Unreadable,
        },
        Some(None) => CodexAccountReading::SignedOut,
        None => CodexAccountReading::Unreadable,
    })
}

/// Asks `connection` for its sign-in, without a refresh, waiting at most `timeout`. Fails as the
/// request does.
pub(crate) async fn read_codex_auth_status(
    connection: &CodexAppServerConnection,
    timeout: Duration,
) -> Result<DriverAuthProbeResult, CodexError> {
    let reply = request_account(connection, false, timeout).await?;
    Ok(classify_codex_auth_status(&reply))
}

/// Asks `connection`'s service to renew the sign-in it holds, waiting at most `timeout`: Codex
/// renews it with its own refresh token under its own refresh lock and writes what it got to its
/// home's `auth.json`. Its reply is not read, since Codex does not report the renewal there; the
/// caller reads the home's `auth.json` again. Fails as the request does.
pub(crate) async fn renew_codex_sign_in(
    connection: &CodexAppServerConnection,
    timeout: Duration,
) -> Result<(), CodexError> {
    request_account(connection, true, timeout).await?;
    Ok(())
}

/// Reads an `account/read` reply into the probe's answer: an account names its sign-in kind as the
/// detail; no account is signed out, worded by whether the service's provider needs an `OpenAI`
/// sign-in at all; a reply that cannot be read is indeterminate, never a verdict on the sign-in.
fn classify_codex_auth_status(reply: &RawValue) -> DriverAuthProbeResult {
    let Some(reply) = read_codex_object::<AccountReadReply>(reply.get()) else {
        return build_auth_probe_result(
            DriverAuthProbeStatus::Indeterminate,
            "the Codex app-server \"account/read\" reply was not an object",
        );
    };
    match reply.account {
        Some(Some(account)) => {
            match read_codex_object::<AccountKind>(account.get()).and_then(|account| account.kind) {
                Some(Value::String(kind)) if !kind.is_empty() => build_auth_probe_result(
                    DriverAuthProbeStatus::Authenticated,
                    &format!("sign-in: {kind}"),
                ),
                _ => build_auth_probe_result(
                    DriverAuthProbeStatus::Indeterminate,
                    "the Codex app-server \"account/read\" reply named an account of no readable \
                     kind",
                ),
            }
        }
        Some(None) => build_auth_probe_result(
            DriverAuthProbeStatus::Unauthenticated,
            if reply.requires_openai_auth == Some(false) {
                "no account is signed in; the configured provider reports it requires no OpenAI \
                 sign-in"
            } else {
                "no account is signed in for this Codex home"
            },
        ),
        None => build_auth_probe_result(
            DriverAuthProbeStatus::Indeterminate,
            "the Codex app-server \"account/read\" reply carried no account member",
        ),
    }
}

/// Tells a failed resume that needs a new sign-in from one that needs recovery. Only a refusal the
/// service itself answered, on a service still up, asks the service again, since asking a wedged
/// one would wait out a second deadline; anything short of a signed-out reading is recovery, and a
/// read that failed is reported.
pub(crate) async fn classify_codex_resume_recovery_condition(
    service: &CodexService,
    failure: &CodexError,
) -> RecoveryCondition {
    if !matches!(failure, CodexError::ProviderRequest { .. }) {
        return RecoveryCondition::RecoveryNeeded;
    }
    let Ok(connection) = service.connection() else {
        return RecoveryCondition::RecoveryNeeded;
    };
    match request_account(&connection, false, CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT).await {
        Ok(reply) => match classify_codex_auth_status(&reply).status {
            DriverAuthProbeStatus::Unauthenticated => RecoveryCondition::ReauthRequired,
            DriverAuthProbeStatus::Authenticated | DriverAuthProbeStatus::Indeterminate => {
                RecoveryCondition::RecoveryNeeded
            }
        },
        Err(error) => {
            CodexTransportDiagnostic::ResumeAuthClassificationFailed {
                error: Box::new(error),
            }
            .report();
            RecoveryCondition::RecoveryNeeded
        }
    }
}

// Sends `account/read`, renewing the sign-in only where `refresh_token`: the providers rotate
// refresh tokens single-use, so only the renewer, under the home's hold, asks for one, and a read
// that only checks never ends the sign-in it checks.
async fn request_account(
    connection: &CodexAppServerConnection,
    refresh_token: bool,
    timeout: Duration,
) -> Result<Box<RawValue>, CodexError> {
    connection
        .request_within(
            CODEX_ACCOUNT_READ_METHOD,
            &GetAccountParams {
                refresh_token: Some(refresh_token),
            },
            timeout,
        )
        .await
}

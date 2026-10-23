//! Codex's sign-in state as `account/read` reports it, read into the driver's probe answer, and the
//! sign-in read that tells a failed resume needing a new sign-in from one needing recovery.

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;

use crate::provider::driver::codex::app_server_protocol::GetAccountParams;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::{
    CodexAppServerConnection, read_codex_object,
};
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::session_control::{
    DriverAuthProbeResult, DriverAuthProbeStatus, build_auth_probe_result,
};

/// The account read, which answers the sign-in Codex holds without touching a conversation.
const CODEX_ACCOUNT_READ_METHOD: &str = "account/read";

/// How long the sign-in probe waits: it reads the home's local sign-in and gates admission.
#[expect(
    dead_code,
    reason = "the Codex driver's sign-in probe bounds its account read with it"
)]
pub(crate) const CODEX_AUTH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a failed resume's sign-in read waits; short, so it never delays the failure.
const CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT: Duration = Duration::from_secs(2);

/// The members of an `account/read` reply the reader takes; the account's email and plan are
/// never read, since only the sign-in kind is safe to show.
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

/// The one member of an account the reader takes: its sign-in kind, a closed tag.
#[derive(Deserialize)]
struct AccountKind {
    #[serde(rename = "type")]
    kind: Option<Value>,
}

/// Asks `connection` for its sign-in, without a refresh, waiting at most `timeout`. Fails as the
/// request does.
#[expect(
    dead_code,
    reason = "the Codex driver's sign-in probe reads the account service's sign-in through it"
)]
pub(crate) async fn read_codex_auth_status(
    connection: &CodexAppServerConnection,
    timeout: Duration,
) -> Result<DriverAuthProbeResult, CodexError> {
    let reply = request_account(connection, timeout).await?;
    Ok(classify_codex_auth_status(&reply))
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
#[expect(
    dead_code,
    reason = "the Codex session's resume classifies a failed resume through it"
)]
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
    match request_account(&connection, CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT).await {
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

async fn request_account(
    connection: &CodexAppServerConnection,
    timeout: Duration,
) -> Result<Box<RawValue>, CodexError> {
    connection
        .request_within(
            CODEX_ACCOUNT_READ_METHOD,
            // No refresh: the providers rotate refresh tokens single-use, and a refresh would end
            // the sign-in being checked.
            &GetAccountParams {
                refresh_token: Some(false),
            },
            timeout,
        )
        .await
}

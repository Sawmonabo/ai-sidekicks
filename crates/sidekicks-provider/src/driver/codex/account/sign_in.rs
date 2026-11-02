//! Codex's own interactive `ChatGPT` sign-in on one account's home: `account/login/start` sent on a
//! connection of its own to the service of that home, the browser arm for a sign-in at this machine
//! and the device-code arm for one from another device, run to the completion Codex sends for this
//! login; and the status read that names who signed in once it ended. The broker keeps one browser
//! sign-in per machine, since Codex's callback listens on one port the machine shares.

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, PROVIDER_SIGN_IN_USER_CODE_MAX_LEN,
    PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN,
};
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::account::credential_home::CredentialHome;
use crate::driver::codex::account::login::CodexLoginAccountParams;
use crate::driver::codex::account::{CodexAccountLegs, HomeService};
use crate::driver::codex::app_server_protocol::CancelLoginAccountParams;
use crate::driver::codex::auth_status::{
    CODEX_AUTH_PROBE_TIMEOUT, CodexAccountReading, read_codex_account,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::codex::transport::login_notices::{LoginNotice, LoginNotices};
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInObservation,
    SignInOrigin, read_sign_in_address,
};
use crate::driver::contract::error::DriverError;

/// The request that starts a sign-in.
const LOGIN_START_METHOD: &str = "account/login/start";

/// The request that cancels a sign-in by its id.
const LOGIN_CANCEL_METHOD: &str = "account/login/cancel";

/// The notice Codex sends, on every connection, once a sign-in ends.
const LOGIN_COMPLETED_METHOD: &str = "account/login/completed";

/// The host both arms' addresses are served from.
const CODEX_SIGN_IN_HOST: &str = "auth.openai.com";

/// How long Codex waits for the browser arm's callback before failing the login itself.
const BROWSER_CEILING: Duration = Duration::from_mins(10);

/// How long Codex waits for the device-code arm's code before failing the login itself.
const DEVICE_CODE_CEILING: Duration = Duration::from_mins(15);

/// How long past an arm's ceiling the sign-in waits for Codex's own end before canceling it.
const BOUND_MARGIN: Duration = Duration::from_secs(60);

/// The cancels held for the login, each answered before the next.
const INPUT_CAPACITY: usize = 4;

/// Why Codex's sign-in could not start, take its input or be read after.
#[derive(Debug, thiserror::Error)]
enum CodexAccountSignInError {
    /// Codex answered the start in a shape this build cannot read.
    #[error("Codex answered the sign-in's start in a shape that could not be read")]
    ReplyUnreadable,
    /// Codex answered an address not on its own sign-in host.
    #[error("Codex answered a sign-in address on a host it does not sign in at")]
    AddressRefused,
    /// Codex answered a device code that is not one line of text.
    #[error("Codex answered a device code that could not be read")]
    UserCodeUnreadable,
    /// The sign-in takes no pasted code: its page finishes it with Codex itself.
    #[error("Codex's sign-in takes no pasted code")]
    TakesNoCode,
    /// The sign-in has ended and takes no more input.
    #[error("Codex's sign-in has ended")]
    Ended,
    /// Codex's account read answered in a shape this build cannot read.
    #[error("Codex's account read after the sign-in could not be read")]
    StatusUnreadable,
}

impl From<CodexAccountSignInError> for DriverError {
    fn from(error: CodexAccountSignInError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// The arm a sign-in runs on: the browser arm at this machine, the device-code arm from another
/// device.
#[derive(Clone, Copy)]
enum LoginArm {
    Browser,
    DeviceCode,
}

impl LoginArm {
    fn ceiling(self) -> Duration {
        match self {
            Self::Browser => BROWSER_CEILING,
            Self::DeviceCode => DEVICE_CODE_CEILING,
        }
    }
}

// The members of the start's reply the sign-in reads, by its arm.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum LoginStartReply {
    #[serde(rename = "chatgpt", rename_all = "camelCase")]
    Chatgpt { login_id: String, auth_url: String },
    #[serde(rename = "chatgptDeviceCode", rename_all = "camelCase")]
    ChatgptDeviceCode {
        login_id: String,
        verification_url: String,
        user_code: String,
    },
}

// The members of a completion notice the sign-in reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginCompleted {
    #[serde(default)]
    login_id: Option<String>,
    success: bool,
}

/// Starts Codex's own sign-in for `provider_account_id`'s `home` on the service of that home,
/// a short-lived one started there where none serves, held until the sign-in ends: the browser arm
/// at this machine, which the broker keeps to one per machine, and the device-code arm from
/// another device. Fails
/// with the driver's error where the service cannot start or Codex refuses the start or answers an
/// address off its own sign-in host, the login then canceled.
pub(super) async fn start_codex_sign_in(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    home: CredentialHome,
    origin: SignInOrigin,
) -> Result<ProviderSignInHandle, DriverError> {
    let arm = match origin {
        SignInOrigin::ThisMachine => LoginArm::Browser,
        SignInOrigin::AnotherDevice => LoginArm::DeviceCode,
    };
    let home_service = legs.take_home_service(provider_account_id, home.path().to_path_buf());
    let (notices, received) = LoginNotices::open(LOGIN_COMPLETED_METHOD);
    let connection = match home_service
        .service()
        .open_detached_connection(notices)
        .await
    {
        Ok(connection) => Arc::new(connection),
        Err(error) => {
            home_service.release().await;
            return Err(error.into());
        }
    };
    let started_at = Instant::now();
    let started = start_login(&connection, arm).await;
    let (login_id, shown) = match started {
        Ok(started) => started,
        Err(error) => {
            close(&connection).await;
            home_service.release().await;
            return Err(error);
        }
    };
    let (inputs, received_inputs) = mpsc::channel(INPUT_CAPACITY);
    let (end, completion) = oneshot::channel();
    let login = Login {
        connection,
        id: login_id,
        started_at,
        notices: received,
        inputs: received_inputs,
        end,
        home_service,
        arm,
    };
    tokio::spawn(login.run());
    Ok(ProviderSignInHandle {
        verification_uri: shown.verification_uri,
        user_code: shown.user_code,
        expires_at: shown.expires_at,
        browser_opened_by_provider: false,
        code_prompts: Box::pin(futures::stream::empty()),
        input: Box::new(CodexSignInInput { inputs }),
        completion: async move { completion.await.unwrap_or(ProviderSignInEnd::Failed) }.boxed(),
    })
}

/// Reads who signed in on `provider_account_id`'s `home` after a sign-in there, through
/// `account/read` on the home's service: a `ChatGPT` sign-in is a subscription, named where Codex
/// names its email, an API key is one, a Bedrock sign-in comes from elsewhere, and none is signed
/// out. Fails as the service or the request does, and where the reply cannot be read.
pub(super) async fn observe_codex_sign_in(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    home: CredentialHome,
) -> Result<ProviderSignInObservation, DriverError> {
    legs.act_on_home_service(
        provider_account_id,
        home.path().to_path_buf(),
        async |service| read_signed_in_account(service).await,
    )
    .await
}

// Reads the account once `service` is up.
async fn read_signed_in_account(
    service: &CodexService,
) -> Result<ProviderSignInObservation, DriverError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    let connection = service.connection()?;
    let reading = read_codex_account(&connection, CODEX_AUTH_PROBE_TIMEOUT).await?;
    let (mode, is_named) = match reading {
        CodexAccountReading::SignedIn { kind, has_email } => match kind.as_str() {
            "chatgpt" => (Some(ProviderAuthMode::OauthSubscription), has_email),
            "apiKey" => (Some(ProviderAuthMode::ApiKey), false),
            "amazonBedrock" => (Some(ProviderAuthMode::External), false),
            _ => (Some(ProviderAuthMode::Unknown), false),
        },
        CodexAccountReading::SignedOut => (None, false),
        CodexAccountReading::Unreadable => {
            return Err(CodexAccountSignInError::StatusUnreadable.into());
        }
    };
    Ok(ProviderSignInObservation::read_now(mode, is_named))
}

// What a started login shows the person: its address, its device code and its bound.
struct ShownLogin {
    verification_uri: HttpsAddress<PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN>,
    user_code: Option<FreeFormText<PROVIDER_SIGN_IN_USER_CODE_MAX_LEN>>,
    expires_at: Option<WireInstant>,
}

// Sends the start on `arm` and reads its reply into the login's id and what it shows; a reply on
// another host is canceled.
async fn start_login(
    connection: &CodexAppServerConnection,
    arm: LoginArm,
) -> Result<(String, ShownLogin), DriverError> {
    let params = match arm {
        LoginArm::Browser => CodexLoginAccountParams::Chatgpt {},
        LoginArm::DeviceCode => CodexLoginAccountParams::ChatgptDeviceCode {},
    };
    let reply = connection.request(LOGIN_START_METHOD, &params).await?;
    let reply = read_codex_object::<LoginStartReply>(reply.get())
        .ok_or(CodexAccountSignInError::ReplyUnreadable)?;
    let (login_id, address, user_code) = match reply {
        LoginStartReply::Chatgpt { login_id, auth_url } => (login_id, auth_url, None),
        LoginStartReply::ChatgptDeviceCode {
            login_id,
            verification_url,
            user_code,
        } => (login_id, verification_url, Some(user_code)),
    };
    match read_shown_login(&address, user_code) {
        Ok(shown) => Ok((login_id, shown)),
        Err(error) => {
            if let Err(cancel) = send_cancel(connection, &login_id).await {
                tracing::warn!(
                    error = &cancel as &(dyn Error + 'static),
                    "a Codex sign-in refused for its address could not be canceled"
                );
            }
            Err(error.into())
        }
    }
}

// What the start answered, checked: the address on Codex's own host and the code as text.
fn read_shown_login(
    address: &str,
    user_code: Option<String>,
) -> Result<ShownLogin, CodexAccountSignInError> {
    let verification_uri = read_sign_in_address(address, &[CODEX_SIGN_IN_HOST])
        .ok_or(CodexAccountSignInError::AddressRefused)?;
    let user_code = user_code
        .map(FreeFormText::<PROVIDER_SIGN_IN_USER_CODE_MAX_LEN>::new)
        .transpose()
        .map_err(|_unreadable| CodexAccountSignInError::UserCodeUnreadable)?;
    // Codex's own device-code wait is the bound; the browser arm publishes none.
    let expires_at = user_code
        .as_ref()
        .and_then(|_device_code| device_code_expiry());
    Ok(ShownLogin {
        verification_uri,
        user_code,
        expires_at,
    })
}

// When the device-code arm started now reaches Codex's own wait.
fn device_code_expiry() -> Option<WireInstant> {
    let ceiling = jiff::SignedDuration::try_from(DEVICE_CODE_CEILING).ok()?;
    WireInstant::from_timestamp(jiff::Timestamp::now().checked_add(ceiling).ok()?)
}

async fn send_cancel(
    connection: &CodexAppServerConnection,
    login_id: &str,
) -> Result<(), CodexError> {
    connection
        .request(
            LOGIN_CANCEL_METHOD,
            &CancelLoginAccountParams {
                login_id: login_id.to_owned(),
            },
        )
        .await?;
    Ok(())
}

async fn close(connection: &CodexAppServerConnection) {
    if let Err(error) = connection.close().await {
        tracing::debug!(
            error = &error as &(dyn Error + 'static),
            "a Codex sign-in's connection did not close cleanly"
        );
    }
}

// A cancel of a running login, answered on its own channel.
struct CancelInput(oneshot::Sender<Result<(), CodexError>>);

// A started login, run to its end on its own task.
struct Login {
    connection: Arc<CodexAppServerConnection>,
    id: String,
    started_at: Instant,
    notices: mpsc::Receiver<LoginNotice>,
    inputs: mpsc::Receiver<CancelInput>,
    end: oneshot::Sender<ProviderSignInEnd>,
    home_service: HomeService,
    arm: LoginArm,
}

impl Login {
    // Waits for Codex's completion of this login, a cancel, the bound or the handle's drop, then
    // closes the connection and stops a short-lived service before answering the end, so the
    // callback port of the one browser sign-in the broker keeps per machine is free once the
    // broker hears it.
    async fn run(mut self) {
        let ceiling = self.arm.ceiling();
        let bound = tokio::time::sleep(ceiling + BOUND_MARGIN);
        tokio::pin!(bound);
        let mut is_input_open = true;
        let end = loop {
            tokio::select! {
                notice = self.notices.recv() => match notice {
                    Some(LoginNotice::Completed(params)) => {
                        let Some(completed) = read_codex_object::<LoginCompleted>(params.get())
                        else {
                            continue;
                        };
                        // A completion naming no login, or another, is not this one's.
                        if completed.login_id.as_deref() != Some(self.id.as_str()) {
                            continue;
                        }
                        break if completed.success {
                            ProviderSignInEnd::Finished
                        } else if self.started_at.elapsed() >= ceiling {
                            ProviderSignInEnd::Expired
                        } else {
                            ProviderSignInEnd::Failed
                        };
                    }
                    Some(LoginNotice::Closed(_)) | None => break ProviderSignInEnd::Failed,
                },
                input = self.inputs.recv(), if is_input_open => match input {
                    Some(CancelInput(answer)) => {
                        let sent = send_cancel(&self.connection, &self.id).await;
                        let is_sent = sent.is_ok();
                        if answer.send(sent).is_err() {
                            tracing::debug!("a Codex sign-in's cancel stopped waiting");
                        }
                        if is_sent {
                            break ProviderSignInEnd::Canceled;
                        }
                    }
                    None => is_input_open = false,
                },
                () = &mut bound => {
                    self.cancel_unasked().await;
                    break ProviderSignInEnd::Expired;
                }
                // No one waits for the end: the login is canceled as a cancel cancels it.
                () = self.end.closed() => {
                    self.cancel_unasked().await;
                    break ProviderSignInEnd::Canceled;
                }
            }
        };
        let Self {
            connection,
            end: end_sender,
            home_service,
            ..
        } = self;
        close(&connection).await;
        home_service.release().await;
        if end_sender.send(end).is_err() {
            tracing::debug!("a Codex sign-in ended after its handle was dropped");
        }
    }

    // Cancels the login where no one asked for it, logging a cancel that failed.
    async fn cancel_unasked(&self) {
        if let Err(error) = send_cancel(&self.connection, &self.id).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a Codex sign-in could not be canceled"
            );
        }
    }
}

// The input of one running login, handed to its task.
struct CodexSignInInput {
    inputs: mpsc::Sender<CancelInput>,
}

impl ProviderSignInInput for CodexSignInInput {
    fn write_code(
        &self,
        _code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        async { Err(CodexAccountSignInError::TakesNoCode.into()) }.boxed()
    }

    fn cancel(&self) -> BoxFuture<'_, Result<(), DriverError>> {
        async move {
            let (answer, answered) = oneshot::channel();
            self.inputs
                .send(CancelInput(answer))
                .await
                .map_err(|_unsent| CodexAccountSignInError::Ended)?;
            answered
                .await
                .map_err(|_unanswered| CodexAccountSignInError::Ended)??;
            Ok(())
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests;

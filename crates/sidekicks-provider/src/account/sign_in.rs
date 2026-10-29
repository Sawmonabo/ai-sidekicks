//! The sign-in broker: runs a provider's own interactive sign-in in one account's home through
//! that provider's sign-in legs, and settles every attempt in exactly one end.
//!
//! - One attempt per account at a time. A new account's id and home are minted at the start and
//!   held in memory; its row is written only once the status read after the flow names who signed
//!   in, with billing `unknown`. Any other end removes the minted home and writes no row. A sign-in
//!   on a registered account keeps its row whatever the end, storing the status read it took.
//! - Only typed fields leave: the reply's address, code and bound, `signInCodeRequested` and
//!   `signInCompleted`. No line of a provider's stream and no driver error's text reaches a caller.
//! - A pasted code goes to the input of the attempt that waits for one and nowhere else.
//! - The registry stays un-evented: completion is a wire notification, never a session event.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::StreamExt as _;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    BillingMode, PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN, PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN,
    ProviderAccountId, ProviderAccountNotification, ProviderSignInOutcome,
};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderAccountSignInRequest, ProviderAccountSignInResponse,
    ProviderSignInCancelStatus, ProviderSignInCodeSubmitStatus,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;

use crate::account::credential_home::CredentialHome;
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::{
    AccountAdmission, HealthObserver, MintedAccount, ProviderAccountRegistry,
};
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs, SignInOrigin,
};
use crate::driver::contract::error::DriverError;

/// One sign-in attempt's daemon-minted id.
type AttemptId = FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>;

/// The text a failed attempt's notification carries for the person.
type FailureReason = FreeFormText<PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN>;

// The random bytes of a minted attempt id, written as hexadecimal.
const ATTEMPT_ID_BYTES: usize = 16;

/// Where the account plane sends the wire-only notifications of `provider.account.subscribe`. It
/// never blocks or fails back into the plane, and keeps nothing.
pub trait ProviderAccountNotificationPublisher: Send + Sync {
    /// Publishes one notification to the subscription's open streams.
    fn publish(&self, notification: ProviderAccountNotification);
}

/// Why a sign-in start, a code submit or a cancel failed; a failed start leaves no attempt, no
/// row and no minted home behind.
#[derive(Debug, thiserror::Error)]
pub enum ProviderSignInError {
    /// The account already has a sign-in in flight.
    #[error("a sign-in is already in flight for the provider account")]
    InFlight,
    /// No sign-in legs are registered for the provider.
    #[error("the provider's sign-in cannot be brokered")]
    Unsupported,
    /// The system gave no random bytes for the attempt's id.
    #[error("the sign-in attempt's id could not be minted")]
    Mint(#[source] getrandom::Error),
    /// The account could not be read, or its home could not be made.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
    /// The provider's flow could not start or take its input, or refused.
    #[error(transparent)]
    Driver(#[from] DriverError),
}

impl From<ProviderSignInError> for HandlerError {
    /// An account with a sign-in in flight refuses `provider.account.signInInFlight` and a
    /// provider with no legs `provider.account.signInUnsupported`; the registry's and the
    /// driver's failures answer as their own conversions say, and a failed mint is the daemon's.
    fn from(error: ProviderSignInError) -> Self {
        match error {
            ProviderSignInError::InFlight => Self::Refused(DomainError::new(
                "A sign-in is already in flight for the provider account",
                RefusalCode::ProviderAccountSignInInFlight,
            )),
            ProviderSignInError::Unsupported => Self::Refused(DomainError::new(
                "The provider's sign-in cannot be brokered",
                RefusalCode::ProviderAccountSignInUnsupported,
            )),
            ProviderSignInError::Registry(error) => error.into(),
            ProviderSignInError::Driver(error) => error.into(),
            error @ ProviderSignInError::Mint(_) => Self::Internal(Box::new(error)),
        }
    }
}

/// The sign-in broker over the registry and each provider's sign-in legs. Its attempts live in
/// memory and settle on tasks spawned on the current tokio runtime, so it must run inside one.
pub struct ProviderSignInBroker {
    attempt: AttemptServices,
    legs: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
}

impl ProviderSignInBroker {
    /// A broker writing through `registry`, starting each provider's flow through its entry in
    /// `legs`, and sending its notifications to `publisher`.
    pub fn new(
        registry: Arc<ProviderAccountRegistry>,
        legs: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
        publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    ) -> Self {
        Self {
            attempt: AttemptServices {
                registry,
                publisher,
                attempts: Arc::new(Mutex::new(LiveAttempts::default())),
            },
            legs,
        }
    }

    /// Starts the provider's own sign-in for `request`'s account, or for a new account whose id
    /// and home it mints, on the arm `origin` calls for, and answers what the person needs. Fails
    /// with [`ProviderSignInError::InFlight`] while the account has an attempt,
    /// [`ProviderSignInError::Unsupported`] for a provider with no legs, the registry's error for
    /// an account not registered or a home that cannot be made, and the driver's where the flow
    /// does not start; a failed start leaves no minted home.
    pub async fn start(
        &self,
        request: ProviderAccountSignInRequest,
        origin: SignInOrigin,
    ) -> Result<ProviderAccountSignInResponse, ProviderSignInError> {
        let (legs, reservation) = match request {
            ProviderAccountSignInRequest::Registered(registered) => {
                let account = self.attempt.registry.read(registered.account_id).await?;
                let legs = self.legs_of(&account.provider)?;
                let reservation =
                    self.attempt
                        .reserve(account.account_id, account.credential_home, None)?;
                (legs, reservation)
            }
            ProviderAccountSignInRequest::New(new) => {
                let legs = self.legs_of(&new.provider)?;
                let minted = self.attempt.registry.mint(new.provider)?;
                let reservation = self.attempt.reserve(
                    minted.account_id().clone(),
                    minted.home().clone(),
                    Some(minted),
                )?;
                (legs, reservation)
            }
        };
        let attempt_id = mint_attempt_id()?;
        let ProviderSignInHandle {
            verification_uri,
            user_code,
            expires_at,
            code_prompts,
            input,
            completion,
        } = legs
            .start_sign_in(
                reservation.account_id.clone(),
                reservation.home.clone(),
                origin,
            )
            .await?;
        let attempt = reservation.open(attempt_id.clone(), Arc::from(input));
        tokio::spawn(attempt.run(legs, code_prompts, completion));
        Ok(ProviderAccountSignInResponse {
            attempt_id,
            verification_uri,
            user_code,
            expires_at,
        })
    }

    /// Writes `code` to the input of attempt `attempt_id` while it waits for one, and to nothing
    /// else; an attempt not waiting, ended or unknown answers `notFound` and nothing is written.
    /// Fails with the driver's error where the flow no longer takes input.
    pub async fn submit_code(
        &self,
        attempt_id: &AttemptId,
        code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> Result<ProviderSignInCodeSubmitStatus, ProviderSignInError> {
        let input = {
            let mut live = lock(&self.attempt.attempts);
            match live.attempts.get_mut(attempt_id) {
                Some(attempt) if attempt.is_waiting_for_code => {
                    attempt.is_waiting_for_code = false;
                    Arc::clone(&attempt.input)
                }
                Some(_) | None => return Ok(ProviderSignInCodeSubmitStatus::NotFound),
            }
        };
        input.write_code(code).await?;
        Ok(ProviderSignInCodeSubmitStatus::Submitted)
    }

    /// Cancels attempt `attempt_id` through its provider's own cancel; its end then settles as
    /// canceled. An ended or unknown attempt answers `notFound`, no refusal. Fails with the
    /// driver's error where the cancel could not be sent.
    pub async fn cancel(
        &self,
        attempt_id: &AttemptId,
    ) -> Result<ProviderSignInCancelStatus, ProviderSignInError> {
        let input = match lock(&self.attempt.attempts).attempts.get(attempt_id) {
            Some(attempt) => Arc::clone(&attempt.input),
            None => return Ok(ProviderSignInCancelStatus::NotFound),
        };
        input.cancel().await?;
        Ok(ProviderSignInCancelStatus::Canceled)
    }

    fn legs_of(
        &self,
        provider: &ProviderId,
    ) -> Result<Arc<dyn ProviderSignInLegs>, ProviderSignInError> {
        self.legs
            .get(provider)
            .cloned()
            .ok_or(ProviderSignInError::Unsupported)
    }
}

/// What an attempt reaches beyond its own flow: the registry, the notification publisher and the
/// broker's live attempts.
#[derive(Clone)]
struct AttemptServices {
    registry: Arc<ProviderAccountRegistry>,
    publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    attempts: Arc<Mutex<LiveAttempts>>,
}

impl AttemptServices {
    // Holds `account_id`'s one sign-in slot until the attempt settles or its start fails.
    fn reserve(
        &self,
        account_id: ProviderAccountId,
        home: CredentialHome,
        minted: Option<MintedAccount>,
    ) -> Result<Reservation, ProviderSignInError> {
        if !lock(&self.attempts).accounts.insert(account_id.clone()) {
            return Err(ProviderSignInError::InFlight);
        }
        Ok(Reservation {
            services: self.clone(),
            account_id,
            home,
            minted,
        })
    }
}

/// The attempts in flight, by id, and the accounts holding one.
#[derive(Default)]
struct LiveAttempts {
    attempts: HashMap<AttemptId, LiveAttempt>,
    accounts: HashSet<ProviderAccountId>,
}

/// One attempt in flight: the flow's input, and whether it waits for a pasted code.
struct LiveAttempt {
    input: Arc<dyn ProviderSignInInput>,
    is_waiting_for_code: bool,
}

/// An account's sign-in slot, held from the start until the attempt settles. Dropped, it frees
/// the slot and removes a minted home no row took, so a failed or abandoned start leaves neither.
struct Reservation {
    services: AttemptServices,
    account_id: ProviderAccountId,
    home: CredentialHome,
    minted: Option<MintedAccount>,
}

impl Reservation {
    // Lists the attempt so a code submit and a cancel reach its input.
    fn open(self, attempt_id: AttemptId, input: Arc<dyn ProviderSignInInput>) -> Attempt {
        lock(&self.services.attempts).attempts.insert(
            attempt_id.clone(),
            LiveAttempt {
                input,
                is_waiting_for_code: false,
            },
        );
        Attempt {
            attempt_id,
            reservation: self,
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        lock(&self.services.attempts)
            .accounts
            .remove(&self.account_id);
        if let Some(minted) = self.minted.take() {
            abandon(&self.services.registry, minted);
        }
    }
}

/// An open attempt, run to its one end on its own task; its reservation frees the account's slot
/// once the attempt has settled.
struct Attempt {
    attempt_id: AttemptId,
    reservation: Reservation,
}

impl Attempt {
    // Reports each wait for a code until the flow ends, then settles the account and reports the
    // end.
    async fn run(
        mut self,
        legs: Arc<dyn ProviderSignInLegs>,
        mut code_prompts: BoxStream<'static, ()>,
        mut completion: BoxFuture<'static, ProviderSignInEnd>,
    ) {
        let end = loop {
            tokio::select! {
                biased;
                end = &mut completion => break end,
                Some(()) = code_prompts.next() => self.mark_waiting_for_code(),
            }
        };
        let services = self.reservation.services.clone();
        lock(&services.attempts).attempts.remove(&self.attempt_id);
        let (outcome, failure_reason) = self.settle(legs.as_ref(), end).await;
        let Self {
            attempt_id,
            reservation,
        } = self;
        let account_id = reservation.account_id.clone();
        drop(reservation);
        services
            .publisher
            .publish(ProviderAccountNotification::SignInCompleted {
                attempt_id,
                account_id,
                outcome,
                failure_reason: failure_reason.map(failure_reason_text),
            });
    }

    fn mark_waiting_for_code(&self) {
        let services = &self.reservation.services;
        let is_live = match lock(&services.attempts).attempts.get_mut(&self.attempt_id) {
            Some(attempt) => {
                attempt.is_waiting_for_code = true;
                true
            }
            None => false,
        };
        if is_live {
            services
                .publisher
                .publish(ProviderAccountNotification::SignInCodeRequested {
                    attempt_id: self.attempt_id.clone(),
                });
        }
    }

    // Takes the status read after a finished flow and writes what it found; a new account that
    // ends any other way loses its minted home.
    async fn settle(
        &mut self,
        legs: &dyn ProviderSignInLegs,
        end: ProviderSignInEnd,
    ) -> (ProviderSignInOutcome, Option<&'static str>) {
        let settled = match end {
            ProviderSignInEnd::Finished => self.observe(legs).await,
            ProviderSignInEnd::Failed => (
                ProviderSignInOutcome::Failed,
                Some("The sign-in did not finish"),
            ),
            ProviderSignInEnd::Expired => {
                (ProviderSignInOutcome::Failed, Some("The sign-in expired"))
            }
            ProviderSignInEnd::Canceled => (ProviderSignInOutcome::Canceled, None),
        };
        if let Some(minted) = self.reservation.minted.take() {
            let registry = Arc::clone(&self.reservation.services.registry);
            if let Err(error) =
                tokio::task::spawn_blocking(move || abandon(&registry, minted)).await
            {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a sign-in's minted home was not removed"
                );
            }
        }
        settled
    }

    // Reads who signed in and stores it: a new account's row only where the provider named it,
    // with billing `unknown`, and a registered account's reading always. A written row takes the
    // minted account, so its home stays.
    async fn observe(
        &mut self,
        legs: &dyn ProviderSignInLegs,
    ) -> (ProviderSignInOutcome, Option<&'static str>) {
        let reservation = &mut self.reservation;
        let observation = match legs
            .observe_sign_in(reservation.account_id.clone(), reservation.home.clone())
            .await
        {
            Ok(observation) => observation,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the status read after a sign-in failed"
                );
                return (
                    ProviderSignInOutcome::Failed,
                    Some("The account could not be checked after the sign-in"),
                );
            }
        };
        let registry = &reservation.services.registry;
        let written = match &reservation.minted {
            Some(_) if !observation.is_account_named => None,
            Some(minted) => Some(
                registry
                    .admit(
                        minted,
                        &AccountAdmission {
                            display_label: None,
                            billing_mode: BillingMode::Unknown,
                            health: observation.health,
                            observed_auth_mode: None,
                        },
                    )
                    .await
                    .map(|_| ()),
            ),
            None => Some(
                registry
                    .record_health(
                        &reservation.account_id,
                        &observation.health,
                        HealthObserver::Probe,
                    )
                    .await
                    .map(|_| ()),
            ),
        };
        match written {
            Some(Ok(())) if observation.is_account_named => {
                reservation.minted = None;
                (ProviderSignInOutcome::Succeeded, None)
            }
            Some(Ok(())) | None => (
                ProviderSignInOutcome::Failed,
                Some("The provider did not name the account"),
            ),
            Some(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a sign-in's account was not saved"
                );
                (
                    ProviderSignInOutcome::Failed,
                    Some("The account could not be saved after the sign-in"),
                )
            }
        }
    }
}

// Removes the home of an account no sign-in admitted, keeping the failure in the service log.
fn abandon(registry: &ProviderAccountRegistry, minted: MintedAccount) {
    if let Err(error) = registry.abandon(minted) {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a sign-in's minted home was not removed"
        );
    }
}

fn mint_attempt_id() -> Result<AttemptId, ProviderSignInError> {
    let id = random_hex(ATTEMPT_ID_BYTES).map_err(ProviderSignInError::Mint)?;
    Ok(AttemptId::new(id).expect("a hexadecimal id of a fixed length is an attempt id"))
}

fn failure_reason_text(reason: &'static str) -> FailureReason {
    FailureReason::new(reason.to_owned()).expect("a fixed failure reason is within its cap")
}

#[cfg(test)]
mod tests;

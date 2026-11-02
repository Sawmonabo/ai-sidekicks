//! The sign-in broker: runs a provider's own interactive sign-in in one account's home through
//! that provider's sign-in legs, and settles every attempt in exactly one end.
//!
//! - One attempt per account at a time. The account's home is held only while the flow starts and
//!   while the status read after it is stored, never across the person's round trip. A new
//!   account's id and home are minted at the start and held in memory; its row is written only
//!   once the status read after the flow names who signed in, with billing `unknown` and the kind
//!   of sign-in the read reports. Any other end removes the minted home and writes no row. A
//!   sign-in on a registered account keeps its row whatever the end, storing the status read it
//!   took and its kind of sign-in, unless the home's sign-in changed since the flow started (a
//!   reset or another credential), which fails the attempt with nothing written. A row written
//!   goes out as `accountChanged` before the attempt's end.
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
    BillingMode, CredentialGeneration, PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN,
    PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN, ProviderAccountId, ProviderAccountNotification,
    ProviderSignInOutcome,
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
use tokio::sync::oneshot;

use crate::account::credential_home::CredentialHome;
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{
    AccountAdmission, MintedAccount, ProviderAccountRegistry, RegisteredAccount,
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

/// Where an account the broker signed in goes to be observed from then on: the background
/// observer, which reads it on its schedule.
pub trait SignedInAccountWatcher: Send + Sync {
    /// Starts observing `account`, which a sign-in just finished on; a failure is the watcher's
    /// to log.
    fn watch_signed_in(&self, account: &RegisteredAccount);
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
    /// The attempt's task ended before it answered whether the flow started.
    #[error("the sign-in's start ended without an answer")]
    StartEnded,
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
            error @ (ProviderSignInError::Mint(_) | ProviderSignInError::StartEnded) => {
                Self::Internal(Box::new(error))
            }
        }
    }
}

/// The sign-in broker over the registry and each provider's sign-in legs. Its attempts live in
/// memory and run on tasks spawned on the current tokio runtime, so it must run inside one.
pub struct ProviderSignInBroker {
    attempt: AttemptServices,
    legs: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
}

impl ProviderSignInBroker {
    /// A broker writing through `registry`, starting each provider's flow through its entry in
    /// `legs` and storing its end under the account's hold on `home_lock`, sending its
    /// notifications to `publisher` and each account it signs in to `watcher`.
    pub fn new(
        registry: Arc<ProviderAccountRegistry>,
        legs: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
        publisher: Arc<dyn ProviderAccountNotificationPublisher>,
        watcher: Arc<dyn SignedInAccountWatcher>,
        home_lock: Arc<AccountHomeLock>,
    ) -> Self {
        Self {
            attempt: AttemptServices {
                registry,
                publisher,
                watcher,
                home_lock,
                attempts: Arc::new(Mutex::new(LiveAttempts::default())),
            },
            legs,
        }
    }

    /// Whether `account_id` has a sign-in in flight, from its start until it settles.
    pub fn is_signing_in(&self, account_id: &ProviderAccountId) -> bool {
        lock(&self.attempt.attempts).accounts.contains(account_id)
    }

    /// Starts the provider's own sign-in for `request`'s account, or for a new account whose id
    /// and home it mints, on the arm `origin` calls for, once the account's home is free, and
    /// answers what the person needs. Fails with
    /// [`ProviderSignInError::InFlight`] while the account has an attempt,
    /// [`ProviderSignInError::Unsupported`] for a provider with no legs, the registry's error for
    /// an account not registered or a home that cannot be made, the driver's where the flow does
    /// not start, and [`ProviderSignInError::StartEnded`] where the attempt's task ended first; a
    /// failed start leaves no minted home.
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
        let (answer, answered) = oneshot::channel();
        tokio::spawn(reservation.run_attempt(attempt_id, legs, origin, answer));
        answered
            .await
            .map_err(|_ended| ProviderSignInError::StartEnded)?
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

/// What an attempt reaches beyond its own flow: the registry, the notification publisher, the
/// watcher of a signed-in account, the lock on account homes and the broker's live attempts.
#[derive(Clone)]
struct AttemptServices {
    registry: Arc<ProviderAccountRegistry>,
    publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    watcher: Arc<dyn SignedInAccountWatcher>,
    home_lock: Arc<AccountHomeLock>,
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
            started_generation: None,
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
    // A registered account's credential generation as its flow started, which its end must
    // still find; `None` for a new account, whose home no one else knows.
    started_generation: Option<CredentialGeneration>,
}

impl Reservation {
    // Takes the account's home, notes a registered account's credential generation, starts the
    // flow in it, lets the home go and answers `answer` whether the flow started, then runs the
    // attempt to its end. A caller that stopped waiting before the home was free starts nothing;
    // one that stopped after leaves the started flow to run to its end.
    async fn run_attempt(
        mut self,
        attempt_id: AttemptId,
        legs: Arc<dyn ProviderSignInLegs>,
        origin: SignInOrigin,
        mut answer: oneshot::Sender<Result<ProviderAccountSignInResponse, ProviderSignInError>>,
    ) {
        let home_lock = Arc::clone(&self.services.home_lock);
        let hold = tokio::select! {
            hold = home_lock.hold(self.account_id.clone()) => hold,
            () = answer.closed() => return,
        };
        if self.minted.is_none() {
            let read = self.services.registry.read(self.account_id.clone()).await;
            match read {
                Ok(account) => self.started_generation = Some(account.credential_generation),
                Err(error) => {
                    drop(self);
                    drop(hold);
                    let _unheard = answer.send(Err(error.into()));
                    return;
                }
            }
        }
        let started = legs
            .start_sign_in(self.account_id.clone(), self.home.clone(), origin)
            .await;
        drop(hold);
        let ProviderSignInHandle {
            verification_uri,
            user_code,
            expires_at,
            code_prompts,
            input,
            completion,
        } = match started {
            Ok(handle) => handle,
            Err(error) => {
                // Freed first, so the caller finds no slot and no minted home left.
                drop(self);
                let _unheard = answer.send(Err(error.into()));
                return;
            }
        };
        let attempt = self.open(attempt_id.clone(), Arc::from(input));
        let publisher = Arc::clone(&attempt.reservation.services.publisher);
        let _unheard = answer.send(Ok(ProviderAccountSignInResponse {
            attempt_id,
            verification_uri,
            user_code,
            expires_at,
        }));
        let ended = attempt.run(legs, code_prompts, completion).await;
        publisher.publish(ended);
    }

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
    // Reports each wait for a code until the flow ends, then settles the account and answers the
    // end's notification.
    async fn run(
        mut self,
        legs: Arc<dyn ProviderSignInLegs>,
        mut code_prompts: BoxStream<'static, ()>,
        mut completion: BoxFuture<'static, ProviderSignInEnd>,
    ) -> ProviderAccountNotification {
        let end = loop {
            tokio::select! {
                biased;
                end = &mut completion => break end,
                Some(()) = code_prompts.next() => self.mark_waiting_for_code(),
            }
        };
        lock(&self.reservation.services.attempts)
            .attempts
            .remove(&self.attempt_id);
        let (outcome, failure_reason) = self.settle(legs.as_ref(), end).await;
        let Self {
            attempt_id,
            reservation,
        } = self;
        let account_id = reservation.account_id.clone();
        drop(reservation);
        ProviderAccountNotification::SignInCompleted {
            attempt_id,
            account_id,
            outcome,
            failure_reason: failure_reason.map(failure_reason_text),
        }
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

    // Reads who signed in and stores it under the home's hold: a new account's row only where the
    // provider named it, with billing `unknown` and the kind of sign-in read, and a registered
    // account's reading and kind always, unless its credential generation moved since the flow
    // started, publishing the row written. A written row takes the minted account, so its home
    // stays.
    async fn observe(
        &mut self,
        legs: &dyn ProviderSignInLegs,
    ) -> (ProviderSignInOutcome, Option<&'static str>) {
        let reservation = &mut self.reservation;
        let home_lock = Arc::clone(&reservation.services.home_lock);
        let hold = home_lock.hold(reservation.account_id.clone()).await;
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
        if let Some(started_generation) = reservation.started_generation {
            match registry.read(reservation.account_id.clone()).await {
                Ok(account) if account.credential_generation == started_generation => {}
                Ok(_) => {
                    return (
                        ProviderSignInOutcome::Failed,
                        Some("The account changed during the sign-in"),
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "a signed-in account was not read before its sign-in was saved"
                    );
                    return (
                        ProviderSignInOutcome::Failed,
                        Some("The account could not be saved after the sign-in"),
                    );
                }
            }
        }
        let written = match &reservation.minted {
            Some(_) if !observation.is_account_named => None,
            Some(minted) => Some(
                registry
                    .admit(
                        minted,
                        &AccountAdmission {
                            display_label: None,
                            billing_mode: BillingMode::Unknown,
                            health: Some(observation.health),
                            observed_auth_mode: observation.observed_auth_mode,
                        },
                    )
                    .await
                    .map(|_| ()),
            ),
            None => Some(
                registry
                    .record_sign_in(
                        &reservation.account_id,
                        &observation.health,
                        observation.observed_auth_mode,
                    )
                    .await
                    .map(|_| ()),
            ),
        };
        drop(hold);
        let changed = match &written {
            Some(Ok(())) => {
                if observation.is_account_named {
                    reservation.minted = None;
                }
                match registry.read(reservation.account_id.clone()).await {
                    Ok(account) => Some(account),
                    Err(error) => {
                        tracing::warn!(
                            error = &error as &(dyn Error + 'static),
                            "a signed-in account was not read, so it is not published or observed \
                             until the next start"
                        );
                        None
                    }
                }
            }
            Some(Err(_)) | None => None,
        };
        if let Some(account) = &changed {
            reservation
                .services
                .publisher
                .publish(ProviderAccountNotification::AccountChanged {
                    account: account.to_provider_account(),
                });
        }
        match written {
            Some(Ok(())) if observation.is_account_named => {
                if let Some(account) = &changed {
                    reservation.services.watcher.watch_signed_in(account);
                }
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

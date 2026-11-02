//! The sign-in broker: runs a provider's own interactive sign-in in one account's home through
//! that provider's sign-in legs, and settles every attempt in exactly one end.
//!
//! - One attempt per account at a time, and one per provider of those that hold what the machine
//!   has only one of, such as a fixed callback port; a start refused for an open attempt names it.
//!   The account's home is held only while the flow starts and while the status read after it is
//!   stored, never across the person's round trip. A new account's id and home are minted at the
//!   start and held in memory; its row is written only once the status read after the flow names
//!   who signed in, with billing `unknown` and the kind of sign-in the read reports. Any other end
//!   removes the minted home and writes no row. A sign-in on a registered account keeps its row
//!   whatever the end, storing the status read it took and its kind of sign-in, unless the home's
//!   sign-in changed since the flow started (a reset or another credential), which fails the
//!   attempt with nothing written. A row written goes out as `accountChanged` before the attempt's
//!   end.
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
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderAccountSignInInFlightDetails,
    ProviderAccountSignInRequest, ProviderAccountSignInResponse, ProviderSignInCancelStatus,
    ProviderSignInCodeSubmitStatus,
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

/// The accounts with a sign-in, a switch onto them or a home's reset in flight, each from its start
/// until it settles, one act per account at a time: the broker, a switch and a reset each begin in
/// the same step that finds the account free, so none of them starts in a home another is using,
/// and the observer reads none of them.
#[derive(Default)]
pub struct AccountsInFlight(Mutex<HashSet<ProviderAccountId>>);

impl AccountsInFlight {
    /// Whether `account_id` has a sign-in, a switch onto it or its home's reset in flight.
    pub fn is_in_flight(&self, account_id: &ProviderAccountId) -> bool {
        lock(&self.0).contains(account_id)
    }

    /// Puts `account_id` in flight until the answered guard is dropped; `None` where it is in
    /// flight already, by a sign-in, a switch onto it or its home's reset.
    pub fn begin(self: &Arc<Self>, account_id: ProviderAccountId) -> Option<InFlightGuard> {
        if !lock(&self.0).insert(account_id.clone()) {
            return None;
        }
        Some(InFlightGuard {
            accounts: Arc::clone(self),
            account_id,
        })
    }
}

/// One account's place in [`AccountsInFlight`], held by the act that began it and let go when
/// dropped.
pub struct InFlightGuard {
    accounts: Arc<AccountsInFlight>,
    account_id: ProviderAccountId,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        lock(&self.accounts.0).remove(&self.account_id);
    }
}

/// Why a sign-in start, a code submit or a cancel failed; a failed start leaves no attempt, no
/// row and no minted home behind.
#[derive(Debug, thiserror::Error)]
pub enum ProviderSignInError {
    /// The account has a switch onto it or its home's reset in flight, which no attempt names.
    #[error("a sign-in, a switch or a reset is already in flight for the provider account")]
    InFlight,
    /// A sign-in of the account is open, or one of another account holds what the machine has
    /// only one of; the refusal names that attempt and the account it signs in.
    #[error("another sign-in is open for the provider account or on this machine")]
    AttemptOpen {
        /// The account the open attempt signs in.
        account_id: ProviderAccountId,
        /// The open attempt.
        attempt_id: AttemptId,
    },
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
    /// An open attempt in the way refuses `provider.account.signInInFlight` with details naming
    /// it and its account, and a switch or a reset in flight refuses it with none; a provider
    /// with no legs refuses `provider.account.signInUnsupported`; the registry's and the driver's
    /// failures answer as their own conversions say, and a failed mint is the daemon's.
    fn from(error: ProviderSignInError) -> Self {
        match error {
            ProviderSignInError::InFlight => Self::Refused(DomainError::new(
                "A sign-in, a switch or a reset is already in flight for the provider account",
                RefusalCode::ProviderAccountSignInInFlight,
            )),
            ProviderSignInError::AttemptOpen {
                account_id,
                attempt_id,
            } => Self::Refused(
                DomainError::new(
                    "Another sign-in is open for the provider account or on this machine",
                    RefusalCode::ProviderAccountSignInInFlight,
                )
                .with_detail(ProviderAccountSignInInFlightDetails {
                    account_id,
                    attempt_id,
                }),
            ),
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
    /// `legs` and storing its end under the account's hold on `home_lock`, holding each account in
    /// `accounts_in_flight` while its attempt runs, sending its notifications to `publisher` and
    /// each account it signs in to `watcher`.
    pub fn new(
        registry: Arc<ProviderAccountRegistry>,
        legs: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
        publisher: Arc<dyn ProviderAccountNotificationPublisher>,
        watcher: Arc<dyn SignedInAccountWatcher>,
        home_lock: Arc<AccountHomeLock>,
        accounts_in_flight: Arc<AccountsInFlight>,
    ) -> Self {
        Self {
            attempt: AttemptServices {
                registry,
                publisher,
                watcher,
                home_lock,
                accounts_in_flight,
                attempts: Arc::new(Mutex::new(LiveAttempts::default())),
            },
            legs,
        }
    }

    /// Starts the provider's own sign-in for `request`'s account, or for a new account whose id
    /// and home it mints, on the arm `origin` calls for, once the account's home is free, and
    /// answers what the person needs. Fails with [`ProviderSignInError::AttemptOpen`] while the
    /// account has an open attempt, or while the start holds what the machine has only one of and
    /// another of the provider's open attempts holds it; [`ProviderSignInError::InFlight`] while
    /// the account has a switch onto it or its home's reset in flight;
    /// [`ProviderSignInError::Unsupported`] for a provider with no legs, the registry's error for
    /// an account not registered or a home that cannot be made, the driver's where the flow does
    /// not start, and [`ProviderSignInError::StartEnded`] where the attempt's task ended first; a
    /// failed start leaves no minted home.
    pub async fn start(
        &self,
        request: ProviderAccountSignInRequest,
        origin: SignInOrigin,
    ) -> Result<ProviderAccountSignInResponse, ProviderSignInError> {
        let attempt_id = mint_attempt_id()?;
        let (legs, reservation) = match request {
            ProviderAccountSignInRequest::Registered(registered) => {
                let account = self.attempt.registry.read(registered.account_id).await?;
                let legs = self.legs_of(&account.provider)?;
                let reservation = self
                    .attempt
                    .reserve(
                        attempt_id,
                        account.provider,
                        legs.is_one_per_machine(origin),
                        account.account_id,
                        account.credential_home,
                        None,
                    )
                    .await?;
                (legs, reservation)
            }
            ProviderAccountSignInRequest::New(new) => {
                let legs = self.legs_of(&new.provider)?;
                let is_one_per_machine = legs.is_one_per_machine(origin);
                // The machine's one slot is checked before a home is minted, so a start it
                // refuses makes none; the reservation checks it again in the same hold it lists.
                if let Some(refusal) = lock(&self.attempt.attempts)
                    .open_attempt_on_machine(&new.provider, is_one_per_machine)
                {
                    return Err(refusal);
                }
                let minted = self.attempt.registry.mint(new.provider.clone())?;
                let reservation = self
                    .attempt
                    .reserve(
                        attempt_id,
                        new.provider,
                        is_one_per_machine,
                        minted.account_id().clone(),
                        minted.home().clone(),
                        Some(minted),
                    )
                    .await?;
                (legs, reservation)
            }
        };
        let (answer, answered) = oneshot::channel();
        tokio::spawn(reservation.run_attempt(legs, origin, answer));
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
                Some(LiveAttempt {
                    input: Some(input),
                    is_waiting_for_code,
                    ..
                }) if *is_waiting_for_code => {
                    *is_waiting_for_code = false;
                    Arc::clone(input)
                }
                Some(_) | None => return Ok(ProviderSignInCodeSubmitStatus::NotFound),
            }
        };
        input.write_code(code).await?;
        Ok(ProviderSignInCodeSubmitStatus::Submitted)
    }

    /// Cancels attempt `attempt_id` through its provider's own cancel; its end then settles as
    /// canceled. An attempt whose flow has not started, an ended one or an unknown one answers
    /// `notFound`, no refusal. Fails with the driver's error where the cancel could not be sent.
    pub async fn cancel(
        &self,
        attempt_id: &AttemptId,
    ) -> Result<ProviderSignInCancelStatus, ProviderSignInError> {
        let input = match lock(&self.attempt.attempts).attempts.get(attempt_id) {
            Some(LiveAttempt {
                input: Some(input), ..
            }) => Arc::clone(input),
            Some(_) | None => return Ok(ProviderSignInCancelStatus::NotFound),
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
/// watcher of a signed-in account, the lock on account homes, the accounts in flight and the
/// broker's live attempts.
#[derive(Clone)]
struct AttemptServices {
    registry: Arc<ProviderAccountRegistry>,
    publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    watcher: Arc<dyn SignedInAccountWatcher>,
    home_lock: Arc<AccountHomeLock>,
    accounts_in_flight: Arc<AccountsInFlight>,
    attempts: Arc<Mutex<LiveAttempts>>,
}

impl AttemptServices {
    // Lists attempt `attempt_id` of `provider` on `account_id` and holds the account in flight
    // until the attempt settles or its start fails, in one hold of the live attempts: refused
    // while an open attempt is on the account, or while this start `is_one_per_machine` and an
    // open one of the provider is too, and while a switch or a reset holds the account. A refused
    // start's minted home is removed once the hold is let go.
    async fn reserve(
        &self,
        attempt_id: AttemptId,
        provider: ProviderId,
        is_one_per_machine: bool,
        account_id: ProviderAccountId,
        home: CredentialHome,
        minted: Option<MintedAccount>,
    ) -> Result<Reservation, ProviderSignInError> {
        let reserved = {
            let mut live = lock(&self.attempts);
            match live.open_attempt_in_the_way(&account_id, &provider, is_one_per_machine) {
                Some(refusal) => Err(refusal),
                None => match self.accounts_in_flight.begin(account_id.clone()) {
                    Some(in_flight_guard) => {
                        live.attempts.insert(
                            attempt_id.clone(),
                            LiveAttempt {
                                account_id: account_id.clone(),
                                provider,
                                is_one_per_machine,
                                input: None,
                                is_waiting_for_code: false,
                            },
                        );
                        Ok(in_flight_guard)
                    }
                    None => Err(ProviderSignInError::InFlight),
                },
            }
        };
        let in_flight_guard = match reserved {
            Ok(in_flight_guard) => in_flight_guard,
            Err(refusal) => {
                if let Some(minted) = minted {
                    abandon(Arc::clone(&self.registry), minted).await;
                }
                return Err(refusal);
            }
        };
        Ok(Reservation {
            _in_flight_guard: in_flight_guard,
            services: self.clone(),
            attempt_id,
            account_id,
            home,
            minted,
            started_generation: None,
        })
    }
}

/// The attempts in flight, by id.
#[derive(Default)]
struct LiveAttempts {
    attempts: HashMap<AttemptId, LiveAttempt>,
}

impl LiveAttempts {
    // The open attempt a new start on `account_id` meets, as the refusal naming it: the
    // account's own, else, for a start that holds what the machine has only one of, the
    // provider's open attempt that holds it too.
    fn open_attempt_in_the_way(
        &self,
        account_id: &ProviderAccountId,
        provider: &ProviderId,
        is_one_per_machine: bool,
    ) -> Option<ProviderSignInError> {
        self.attempts
            .iter()
            .find(|(_, attempt)| attempt.account_id == *account_id)
            .map(attempt_open)
            .or_else(|| self.open_attempt_on_machine(provider, is_one_per_machine))
    }

    // The provider's open attempt holding what the machine has only one of, as the refusal naming
    // it, for a start that `is_one_per_machine`.
    fn open_attempt_on_machine(
        &self,
        provider: &ProviderId,
        is_one_per_machine: bool,
    ) -> Option<ProviderSignInError> {
        self.attempts
            .iter()
            .find(|(_, attempt)| {
                is_one_per_machine && attempt.is_one_per_machine && attempt.provider == *provider
            })
            .map(attempt_open)
    }
}

// The refusal naming the open attempt a start meets.
fn attempt_open((attempt_id, attempt): (&AttemptId, &LiveAttempt)) -> ProviderSignInError {
    ProviderSignInError::AttemptOpen {
        account_id: attempt.account_id.clone(),
        attempt_id: attempt_id.clone(),
    }
}

/// One attempt in flight, listed from its reservation: the account it signs in, its provider,
/// whether it holds what the machine has only one of, the flow's input once the flow has started,
/// and whether it waits for a pasted code.
struct LiveAttempt {
    account_id: ProviderAccountId,
    provider: ProviderId,
    is_one_per_machine: bool,
    input: Option<Arc<dyn ProviderSignInInput>>,
    is_waiting_for_code: bool,
}

/// An account's sign-in slot and its listed attempt, held from the start until the attempt
/// settles. Dropped, it unlists the attempt, frees the slot and removes a minted home no row took,
/// so a failed or abandoned start leaves none of them.
struct Reservation {
    _in_flight_guard: InFlightGuard,
    services: AttemptServices,
    attempt_id: AttemptId,
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
                    self.release().await;
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
            browser_opened_by_provider,
            code_prompts,
            input,
            completion,
        } = match started {
            Ok(handle) => handle,
            Err(error) => {
                // Freed first, so the caller finds no slot and no minted home left.
                self.release().await;
                let _unheard = answer.send(Err(error.into()));
                return;
            }
        };
        let attempt = self.open(Arc::from(input));
        let publisher = Arc::clone(&attempt.reservation.services.publisher);
        let _unheard = answer.send(Ok(ProviderAccountSignInResponse {
            attempt_id: attempt.reservation.attempt_id.clone(),
            verification_uri,
            user_code,
            expires_at,
            browser_opened_by_provider,
        }));
        let ended = attempt.run(legs, code_prompts, completion).await;
        publisher.publish(ended);
    }

    // Removes the minted home no row took, then unlists the attempt and frees the slot.
    async fn release(mut self) {
        if let Some(minted) = self.minted.take() {
            abandon(Arc::clone(&self.services.registry), minted).await;
        }
    }

    // Hands the listed attempt its flow's input, so a code submit and a cancel reach it.
    fn open(self, input: Arc<dyn ProviderSignInInput>) -> Attempt {
        lock(&self.services.attempts)
            .attempts
            .get_mut(&self.attempt_id)
            .expect("an attempt listed at its reservation stays listed until its flow ends")
            .input = Some(input);
        Attempt { reservation: self }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        lock(&self.services.attempts)
            .attempts
            .remove(&self.attempt_id);
        if let Some(minted) = self.minted.take() {
            tokio::spawn(abandon(Arc::clone(&self.services.registry), minted));
        }
    }
}

/// An open attempt, run to its one end on its own task; its reservation frees the account's slot
/// once the attempt has settled.
struct Attempt {
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
        // Unlisted at the flow's end, so no code submit or cancel reaches it, and a start the
        // attempt was in the way of need not wait for the status read.
        lock(&self.reservation.services.attempts)
            .attempts
            .remove(&self.reservation.attempt_id);
        let (outcome, failure_reason) = self.settle(legs.as_ref(), end).await;
        let Self { reservation } = self;
        let attempt_id = reservation.attempt_id.clone();
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
        let attempt_id = &self.reservation.attempt_id;
        let is_live = match lock(&services.attempts).attempts.get_mut(attempt_id) {
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
                    attempt_id: attempt_id.clone(),
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
            abandon(Arc::clone(&self.reservation.services.registry), minted).await;
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

// Removes, on a blocking thread, the home of an account no sign-in admitted, keeping the failure
// in the service log.
async fn abandon(registry: Arc<ProviderAccountRegistry>, minted: MintedAccount) {
    let removed = tokio::task::spawn_blocking(move || registry.abandon(minted)).await;
    let error: Box<dyn Error + Send + Sync> = match removed {
        Ok(Ok(())) => return,
        Ok(Err(error)) => Box::new(error),
        Err(error) => Box::new(error),
    };
    tracing::warn!(
        error = &*error as &(dyn Error + 'static),
        "a sign-in's minted home was not removed"
    );
}

fn mint_attempt_id() -> Result<AttemptId, ProviderSignInError> {
    let id = random_hex(ATTEMPT_ID_BYTES).map_err(ProviderSignInError::Mint)?;
    Ok(AttemptId::new(id).expect("a hexadecimal id of a fixed length is an attempt id"))
}

fn failure_reason_text(reason: &'static str) -> FailureReason {
    FailureReason::new(reason.to_owned()).expect("a fixed failure reason is within its cap")
}

#[cfg(test)]
pub(crate) mod tests;

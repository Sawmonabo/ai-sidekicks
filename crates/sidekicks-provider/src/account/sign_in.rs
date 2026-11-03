//! The sign-in broker: runs a provider's own interactive sign-in in one account's home through
//! that provider's sign-in legs, and settles every attempt in exactly one end.
//!
//! - The arm is the one the request names, else the browser arm at this machine and the
//!   device-code arm from another device, whose browser cannot reach a callback here; another
//!   device naming the browser arm is refused.
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
//!   `signInCompleted`. No line of a provider's stream reaches a caller; a provider's own words
//!   leave only bounded, as a refused start's failure detail or a failed end's reason.
//! - A pasted code goes to the input of the attempt that waits for one and nowhere else.
//! - The registry stays un-evented: completion is a wire notification, never a session event.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN, PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN,
    ProviderAccountId, ProviderAccountNotification,
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
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use self::arm::resolve_sign_in_arm;
use self::attempt::{Reservation, abandon};
use crate::account::credential_home::CredentialHome;
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{MintedAccount, ProviderAccountRegistry, RegisteredAccount};
use crate::driver::contract::account::{ProviderSignInInput, ProviderSignInLegs};
use crate::driver::contract::error::DriverError;

/// One sign-in attempt's daemon-minted id.
type AttemptId = FreeFormText<PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN>;

/// The text a failed attempt's notification carries for the person.
type FailureReason = FreeFormText<PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN>;

// The random bytes of a minted attempt id, written as hexadecimal.
const ATTEMPT_ID_BYTES: usize = 16;

/// Where a sign-in was started, which bounds the arm it may run on: a browser on another device
/// cannot reach a provider's callback on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInOrigin {
    /// This machine's own client.
    ThisMachine,
    /// A linked device.
    AnotherDevice,
}

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
    /// The account signs in with a pasted key or token, which only a new one pasted replaces.
    #[error("the provider account's pasted key or token is replaced by pasting a new one")]
    PastedCredential,
    /// A sign-in from another device named the browser arm, whose callback that device's browser
    /// cannot reach.
    #[error("a browser sign-in cannot be finished from another device")]
    BrowserFromAnotherDevice,
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
    /// with no legs, the browser arm from another device and an account with a pasted key or token
    /// refuse `provider.account.signInUnsupported`; the registry's and the driver's
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
            ProviderSignInError::PastedCredential => Self::Refused(DomainError::new(
                "This account uses a pasted key or token; paste a new one to replace it",
                RefusalCode::ProviderAccountSignInUnsupported,
            )),
            ProviderSignInError::BrowserFromAnotherDevice => Self::Refused(DomainError::new(
                "A browser sign-in cannot be finished from another device; sign in with a device \
                 code instead",
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
/// memory and run on its own tracked tasks on the current tokio runtime, so it must run inside
/// one, and the daemon's stop ends them through [`Self::stop`].
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
                tasks: TaskTracker::new(),
                stopping: CancellationToken::new(),
            },
            legs,
        }
    }

    /// Starts the provider's own sign-in for `request`'s account, or for a new account whose id
    /// and home it mints, on the arm `request` names or, naming none, the one `origin` calls for,
    /// once the account's home is free, and answers what the person needs. Fails with
    /// [`ProviderSignInError::BrowserFromAnotherDevice`], before anything is read or minted, where
    /// another device names the browser arm; [`ProviderSignInError::PastedCredential`], nothing
    /// reserved or started, for an account with a pasted key or token;
    /// [`ProviderSignInError::AttemptOpen`] while the
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
        let requested_arm = match &request {
            ProviderAccountSignInRequest::Registered(registered) => registered.arm,
            ProviderAccountSignInRequest::New(new) => new.arm,
        };
        let arm = resolve_sign_in_arm(requested_arm, origin)?;
        let attempt_id = mint_attempt_id()?;
        let (legs, reservation) = match request {
            ProviderAccountSignInRequest::Registered(registered) => {
                let account = self.attempt.registry.read(registered.account_id).await?;
                if account.has_pasted_credential() {
                    return Err(ProviderSignInError::PastedCredential);
                }
                let legs = self.legs_of(&account.provider)?;
                let reservation = self
                    .attempt
                    .reserve(
                        attempt_id,
                        account.provider,
                        legs.is_one_per_machine(arm),
                        account.account_id,
                        account.credential_home,
                        None,
                    )
                    .await?;
                (legs, reservation)
            }
            ProviderAccountSignInRequest::New(new) => {
                let legs = self.legs_of(&new.provider)?;
                let is_one_per_machine = legs.is_one_per_machine(arm);
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
        self.attempt
            .tasks
            .spawn(reservation.run_attempt(legs, arm, answer));
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
            match live
                .attempts
                .get_mut(attempt_id)
                .map(|attempt| &mut attempt.stage)
            {
                Some(AttemptStage::Open {
                    input,
                    is_waiting_for_code,
                }) if *is_waiting_for_code => {
                    *is_waiting_for_code = false;
                    Arc::clone(input)
                }
                Some(
                    AttemptStage::Starting { .. }
                    | AttemptStage::Open { .. }
                    | AttemptStage::Settling,
                )
                | None => return Ok(ProviderSignInCodeSubmitStatus::NotFound),
            }
        };
        input.write_code(code).await?;
        Ok(ProviderSignInCodeSubmitStatus::Submitted)
    }

    /// Cancels attempt `attempt_id` through its provider's own cancel; its end then settles as
    /// canceled. An attempt whose flow is still starting is canceled as soon as it has started.
    /// An ended attempt, an unknown one, or one whose flow had already ended on its own answers
    /// `notFound`, no refusal. Fails with the driver's error where the cancel could not be sent.
    pub async fn cancel(
        &self,
        attempt_id: &AttemptId,
    ) -> Result<ProviderSignInCancelStatus, ProviderSignInError> {
        let input = {
            let mut live = lock(&self.attempt.attempts);
            match live
                .attempts
                .get_mut(attempt_id)
                .map(|attempt| &mut attempt.stage)
            {
                Some(AttemptStage::Starting { is_cancel_asked }) => {
                    *is_cancel_asked = true;
                    return Ok(ProviderSignInCancelStatus::Canceled);
                }
                Some(AttemptStage::Open { input, .. }) => Arc::clone(input),
                Some(AttemptStage::Settling) | None => {
                    return Ok(ProviderSignInCancelStatus::NotFound);
                }
            }
        };
        Ok(input.cancel().await?)
    }

    /// Ends every attempt, as the daemon's stop does: one still waiting for its account's home
    /// starts nothing, and an open flow is canceled through its provider's own cancel and settles
    /// as canceled, a new account's minted home removed; then waits up to `bound` for every
    /// attempt to settle, answering whether all did.
    pub async fn stop(&self, bound: Duration) -> bool {
        self.attempt.stopping.cancel();
        self.attempt.tasks.close();
        tokio::time::timeout(bound, self.attempt.tasks.wait())
            .await
            .is_ok()
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
/// watcher of a signed-in account, the lock on account homes, the accounts in flight, the
/// broker's live attempts, the tasks they run on and the broker's stop.
#[derive(Clone)]
struct AttemptServices {
    registry: Arc<ProviderAccountRegistry>,
    publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    watcher: Arc<dyn SignedInAccountWatcher>,
    home_lock: Arc<AccountHomeLock>,
    accounts_in_flight: Arc<AccountsInFlight>,
    attempts: Arc<Mutex<LiveAttempts>>,
    tasks: TaskTracker,
    stopping: CancellationToken,
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
                                stage: AttemptStage::Starting {
                                    is_cancel_asked: false,
                                },
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
            signing_in: None,
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

/// One attempt in flight, listed from its reservation until it settles: the account it signs in,
/// its provider, whether it holds what the machine has only one of, and how far it has come.
struct LiveAttempt {
    account_id: ProviderAccountId,
    provider: ProviderId,
    is_one_per_machine: bool,
    stage: AttemptStage,
}

/// How far a listed attempt has come.
enum AttemptStage {
    /// Its flow is starting; a cancel asked meanwhile is sent once it has started.
    Starting {
        /// Whether a cancel was asked before the flow started.
        is_cancel_asked: bool,
    },
    /// Its flow runs, taking a pasted code or a cancel through its input.
    Open {
        /// The flow's input.
        input: Arc<dyn ProviderSignInInput>,
        /// Whether the flow waits for a pasted code.
        is_waiting_for_code: bool,
    },
    /// Its flow has ended and its status read is being stored; a start on its account still meets
    /// it by name, and nothing else reaches it.
    Settling,
}

fn mint_attempt_id() -> Result<AttemptId, ProviderSignInError> {
    let id = random_hex(ATTEMPT_ID_BYTES).map_err(ProviderSignInError::Mint)?;
    Ok(AttemptId::new(id).expect("a hexadecimal id of a fixed length is an attempt id"))
}

fn failure_reason_text(reason: &'static str) -> FailureReason {
    FailureReason::new(reason.to_owned()).expect("a fixed failure reason is within its cap")
}

mod arm;
mod attempt;
#[cfg(test)]
pub(crate) mod tests;

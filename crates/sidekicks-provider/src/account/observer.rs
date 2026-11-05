//! The background observer of provider accounts: every account read every five minutes through
//! its provider's own limits read, run in the account's home, with what the read answered stored
//! as the account's health.
//!
//! - A read runs under the account's home lock and joins the read in flight on the account, so no
//!   two reads run in one home, and none while a reset or a sign-in holds the home; it never runs
//!   while a turn is live on the account, since the turn brings its own figures, nor while a
//!   sign-in is in flight on it, whose save a crossing read would fail; the next pass reads it.
//! - A provider whose reads each start a process reads one account at a time.
//! - `Check now` answers the last read while it is under a minute old, and a hold's end while the
//!   throttle ladder holds the account; the opt-out stops every read but `Check now`.
//! - An answer with figures records its quota windows as the account's whole set, or as a partial
//!   set where a pasted token's turn read them, and the identity and sign-in renewal the provider
//!   reported with it on the account's row.
//! - The stored health: an answer with figures reads signed in and takes the account off the
//!   ladder; a sign-in gone reads `reauthRequired`; a refused read climbs the ladder; a sign-in
//!   refused on the way to the answer, or the second read in a row with no answer, reads
//!   `indeterminate`; anything else stores nothing, so no failed read reads as a reading.
//! - Only `Check now` writes as the probe; every other read writes as the background observer,
//!   which never moves the generation, and a read that cannot tell never does either.
//! - Each read that rewrote the account's row publishes the account as it now reads.
//! - A turn-end read restarts the account's interval only once it answers figures; one asked
//!   while a turn on the account still reads as live, as a provider's last usage comes before its
//!   run ends, is owed and runs once a turn closes.
//! - A pasted token whose own scope cannot read its limits is read by a turn instead, and each
//!   account's closed usage windows are started by one, each turn written as a usage row of its
//!   own.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId, ProviderAccountNotification,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::WallClock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::{ScheduleError, Scheduler};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::{AccountHomeActEnded, AccountHomeFlights, AccountHomeLock};
use crate::account::observer::schedule::ObservationSchedule;
use crate::account::observer::window_start::{WindowStartTimers, WindowStartWakes};
use crate::account::registry::{
    HealthObservation, HealthObserver, ProviderAccountRegistry, RegisteredAccount,
};
use crate::account::sign_in::{
    AccountsInFlight, ProviderAccountNotificationPublisher, SignedInAccountWatcher,
};
use crate::account::token_custody::{ProviderTokenCustody, TokenCustodyError};
use crate::account::wake_helper::MachineWakeHelper;
use crate::driver::contract::account::{
    ProviderObservation, ProviderObserveLegs, ProviderTokenLimitsLegs, ProviderWindowTurnLegs,
};
use crate::driver::contract::error::DriverError;
use crate::driver::ports::RequestHeldListener;
use crate::driver::{AccountFoldersError, ProviderAccountFolders, ProviderAccountReader};
use crate::port::usage_sink::UsageSink;

mod figures;
mod ladder;
mod schedule;
mod token_read;
mod window_start;
pub mod window_store;

// How long a read may take before it counts as one with no answer; the legs set no bound.
const READ_BOUND: Duration = Duration::from_mins(1);

// How old the last read may be for `Check now` to answer it rather than read again.
const CHECK_NOW_FLOOR: jiff::SignedDuration = jiff::SignedDuration::from_mins(1);

// Reads in a row with no answer after which the account reads as not told.
const UNANSWERED_BEFORE_INDETERMINATE: u32 = 2;

/// The turns live on an account, read through the bindings the daemon keeps.
pub trait AccountLiveTurns: Send + Sync {
    /// The sessions with a turn live on `provider_account_id`'s account now, each once; empty
    /// when none is.
    fn sessions_with_live_turns(&self, provider_account_id: &ProviderAccountId) -> Vec<SessionId>;
}

/// What the observer is built over.
pub struct ProviderAccountObserverDeps {
    /// The accounts, their stored health and their place on the throttle ladder.
    pub registry: Arc<ProviderAccountRegistry>,
    /// Each account's folders, the home its read runs in.
    pub account_reader: Arc<dyn ProviderAccountReader>,
    /// Each provider's limits read; an account of a provider with none is not observed.
    pub legs: HashMap<ProviderId, Arc<dyn ProviderObserveLegs>>,
    /// Each provider's smallest turn; an account of a provider with none starts no window.
    pub window_turn_legs: HashMap<ProviderId, Arc<dyn ProviderWindowTurnLegs>>,
    /// Each provider's read of a pasted token's limits by a turn; a pasted token of a provider
    /// with none is read as any sign-in is.
    pub token_limits_legs: HashMap<ProviderId, Arc<dyn ProviderTokenLimitsLegs>>,
    /// The sealed pasted tokens, one of which a turn that reads its limits is handed.
    pub token_custody: Arc<ProviderTokenCustody>,
    /// The daemon's read connections, which read each account's windows.
    pub database_reads: Arc<DatabaseReadPool>,
    /// The daemon's database writer, which writes each turn's usage row and what a read reported
    /// of the account.
    pub database_writer: Arc<DatabaseWriter>,
    /// The usage record, which takes each read's whole set of quota windows.
    pub usage: Arc<dyn UsageSink>,
    /// Whether a turn is live on an account.
    pub live_turns: Arc<dyn AccountLiveTurns>,
    /// The accounts with a sign-in, a switch onto them or a home's reset in flight, which no read
    /// runs on.
    pub accounts_in_flight: Arc<AccountsInFlight>,
    /// The lock every act in an account's home takes.
    pub home_lock: Arc<AccountHomeLock>,
    /// The daemon's scheduler, which runs each account's job and tells each wake.
    pub scheduler: Arc<Scheduler>,
    /// The clock a reading's time, the minute's floor and a hold's end are read on.
    pub wall_clock: Arc<dyn WallClock>,
    /// The machine's wake helper, which wakes it for a window reset on an account whose wake
    /// switch is on; `None` on a system with none.
    pub wake_helper: Option<Arc<dyn MachineWakeHelper>>,
    /// Where each account a read rewrote goes out as changed.
    pub publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    /// The repricing's intake, the registration the drivers hand their held requests to, which
    /// takes each window-start turn's row once written; while unregistered the row waits for the
    /// next start.
    pub request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
}

/// One read of an account and when it was taken.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountReading {
    /// What the provider answered; `None` when the read could not start, failed or took too long.
    pub observation: Option<ProviderObservation>,
    /// When the read was taken.
    pub read_at: WireInstant,
}

/// What asking for an account's read answers.
#[derive(Clone, Debug, PartialEq)]
pub enum AccountReadAnswer {
    /// The read taken, joined in flight, or, for `Check now`, the last one while under a minute
    /// old.
    Read(AccountReading),
    /// The throttle ladder holds the account's reads until this instant.
    Held {
        /// When the hold ends.
        until: WireInstant,
    },
    /// No read may run now: the account is opted out, a turn or a sign-in is live on it, or
    /// another act holds its home; the last read, `None` before the first.
    NotNow {
        /// The last read taken.
        last: Option<AccountReading>,
    },
}

/// Why an account could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ProviderAccountObserverError {
    /// The account could not be read or its reading not stored.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
    /// The account's provider has no limits read.
    #[error("the account's provider has no limits read")]
    ProviderUnobserved,
    /// The account's home could not be resolved.
    #[error("the account's folders could not be resolved")]
    Folders(#[source] AccountFoldersError),
    /// The read in flight on the account failed.
    #[error("the account's read failed")]
    ReadFailed(#[source] Arc<ProviderAccountObserverError>),
    /// The window start in flight on the account failed.
    #[error("the account's window start failed")]
    WindowStartFailed(#[source] Arc<ProviderAccountObserverError>),
    /// The account's pasted token could not be read.
    #[error(transparent)]
    Token(#[from] TokenCustodyError),
    /// The read in flight ended without an answer.
    #[error(transparent)]
    ReadEnded(#[from] AccountHomeActEnded),
    /// The account's job could not be scheduled.
    #[error(transparent)]
    Schedule(#[from] ScheduleError),
    /// The read's quota windows could not be recorded.
    #[error("the account's quota windows could not be recorded")]
    WindowsNotRecorded(#[source] Box<dyn std::error::Error + Send + Sync>),
}

impl From<ProviderAccountObserverError> for HandlerError {
    /// An account not registered or whose home cannot be used refuses as the registry and the
    /// folders' read answer it, and a pasted token as its custody does; every other failure is
    /// the daemon's own.
    fn from(error: ProviderAccountObserverError) -> Self {
        match error {
            ProviderAccountObserverError::Registry(failure) => failure.into(),
            ProviderAccountObserverError::Folders(failure) => DriverError::from(failure).into(),
            ProviderAccountObserverError::Token(failure) => failure.into(),
            error @ (ProviderAccountObserverError::ProviderUnobserved
            | ProviderAccountObserverError::ReadFailed(_)
            | ProviderAccountObserverError::WindowStartFailed(_)
            | ProviderAccountObserverError::ReadEnded(_)
            | ProviderAccountObserverError::Schedule(_)
            | ProviderAccountObserverError::WindowsNotRecorded(_)) => {
                Self::Internal(Box::new(error))
            }
        }
    }
}

// Who asked for a read: it decides the opt-out, the minute's floor and the stored writer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadAsker {
    Cadence,
    TurnEnd,
    Dictation,
    CheckNow,
}

impl ReadAsker {
    fn writer(self) -> HealthObserver {
        match self {
            Self::CheckNow => HealthObserver::Probe,
            Self::Cadence | Self::TurnEnd | Self::Dictation => HealthObserver::Background,
        }
    }
}

// What the observer remembers of an account between reads.
#[derive(Default)]
struct AccountMemory {
    last: Option<AccountReading>,
    unanswered_in_a_row: u32,
}

// A read's answer to every asker joined on it; `None` where a sign-in on the account kept it from
// running.
type SharedReading = Result<Option<AccountReading>, Arc<ProviderAccountObserverError>>;

type SharedWindowStart = Result<(), Arc<ProviderAccountObserverError>>;

/// The background observer; see the module doc.
pub struct ProviderAccountObserver {
    shared: Arc<ObserverShared>,
}

struct ObserverShared {
    registry: Arc<ProviderAccountRegistry>,
    account_reader: Arc<dyn ProviderAccountReader>,
    legs: HashMap<ProviderId, Arc<dyn ProviderObserveLegs>>,
    window_turn_legs: HashMap<ProviderId, Arc<dyn ProviderWindowTurnLegs>>,
    token_limits_legs: HashMap<ProviderId, Arc<dyn ProviderTokenLimitsLegs>>,
    token_custody: Arc<ProviderTokenCustody>,
    database_reads: Arc<DatabaseReadPool>,
    database_writer: Arc<DatabaseWriter>,
    usage: Arc<dyn UsageSink>,
    publisher: Arc<dyn ProviderAccountNotificationPublisher>,
    request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    // One per provider whose reads run one at a time; its window turns take it too.
    one_reader_at_a_time: HashMap<ProviderId, Arc<tokio::sync::Mutex<()>>>,
    live_turns: Arc<dyn AccountLiveTurns>,
    accounts_in_flight: Arc<AccountsInFlight>,
    scheduler: Arc<Scheduler>,
    wall_clock: Arc<dyn WallClock>,
    reads: AccountHomeFlights<SharedReading>,
    window_starts: AccountHomeFlights<SharedWindowStart>,
    accounts: Mutex<HashMap<ProviderAccountId, AccountMemory>>,
    // The accounts whose turn-end read a live turn turned away, read again once a turn closes.
    turn_end_reads_owed: Mutex<HashSet<ProviderAccountId>>,
    schedule: ObservationSchedule,
    window_timers: WindowStartTimers,
    window_wakes: WindowStartWakes,
    wake_watch: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ProviderAccountObserver {
    /// An observer over `deps` that schedules nothing until [`ProviderAccountObserver::start`].
    pub fn new(deps: ProviderAccountObserverDeps) -> Self {
        let one_reader_at_a_time = deps
            .legs
            .iter()
            .filter(|(_, legs)| legs.reads_one_at_a_time())
            .map(|(provider, _)| (provider.clone(), Arc::default()))
            .collect();
        let shared = Arc::new_cyclic(|this: &Weak<ObserverShared>| {
            let (read_due, window_due) = (this.clone(), this.clone());
            ObserverShared {
                registry: deps.registry,
                account_reader: deps.account_reader,
                legs: deps.legs,
                window_turn_legs: deps.window_turn_legs,
                token_limits_legs: deps.token_limits_legs,
                token_custody: deps.token_custody,
                database_reads: deps.database_reads,
                database_writer: deps.database_writer,
                usage: deps.usage,
                publisher: deps.publisher,
                request_held: deps.request_held,
                one_reader_at_a_time,
                live_turns: deps.live_turns,
                accounts_in_flight: deps.accounts_in_flight,
                scheduler: Arc::clone(&deps.scheduler),
                wall_clock: deps.wall_clock,
                reads: AccountHomeFlights::new(Arc::clone(&deps.home_lock)),
                window_starts: AccountHomeFlights::new(deps.home_lock),
                accounts: Mutex::default(),
                turn_end_reads_owed: Mutex::default(),
                schedule: ObservationSchedule::new(
                    Arc::clone(&deps.scheduler),
                    Arc::new(move |account_id| {
                        if let Some(shared) = read_due.upgrade() {
                            shared.spawn_read(account_id, ReadAsker::Cadence);
                        }
                    }),
                ),
                window_timers: WindowStartTimers::new(
                    deps.scheduler,
                    Arc::new(move |account_id| {
                        if let Some(shared) = window_due.upgrade() {
                            shared.spawn_window_start(account_id);
                        }
                    }),
                ),
                window_wakes: WindowStartWakes::new(deps.wake_helper),
                wake_watch: Mutex::default(),
            }
        });
        Self { shared }
    }

    /// Schedules every registered account of an observed provider, each provider's first reads
    /// spread across the interval, looks at every account's windows now and at each wake. Fails
    /// when the accounts cannot be listed or the scheduler has stopped.
    pub async fn start(&self) -> Result<(), ProviderAccountObserverError> {
        let mut by_provider: HashMap<ProviderId, Vec<ProviderAccountId>> = HashMap::new();
        for account in self.shared.registry.list(None).await? {
            if self.shared.legs.contains_key(&account.provider) {
                by_provider
                    .entry(account.provider)
                    .or_default()
                    .push(account.account_id);
            }
        }
        for accounts in by_provider.into_values() {
            let delays = ObservationSchedule::spread_first_delays(accounts.len());
            for (account_id, first_delay) in accounts.into_iter().zip(delays) {
                self.shared.schedule.watch(account_id, first_delay)?;
            }
        }
        if let Some(replaced) =
            lock(&self.shared.wake_watch).replace(self.shared.spawn_wake_watch())
        {
            replaced.abort();
        }
        Arc::clone(&self.shared).spawn_every_window_start();
        Ok(())
    }

    /// Schedules `account`, newly signed in, its first read a whole interval away, since its
    /// sign-in just read it, and looks at its windows now; an account of a provider with no limits
    /// read is not scheduled. Refused once the scheduler has stopped.
    pub fn watch(&self, account: &RegisteredAccount) -> Result<(), ProviderAccountObserverError> {
        if self.shared.legs.contains_key(&account.provider) {
            self.shared
                .schedule
                .watch(account.account_id.clone(), schedule::OBSERVATION_INTERVAL)?;
        }
        Arc::clone(&self.shared).spawn_window_start(account.account_id.clone());
        Ok(())
    }

    /// Stops observing `provider_account_id`, removed, forgets its last read and cancels the wake
    /// booked for its reset in a task of its own.
    pub fn forget(&self, provider_account_id: &ProviderAccountId) {
        self.shared.schedule.forget(provider_account_id);
        self.shared.window_timers.forget(provider_account_id);
        lock(&self.shared.accounts).remove(provider_account_id);
        lock(&self.shared.turn_end_reads_owed).remove(provider_account_id);
        Arc::clone(&self.shared).spawn_wake_cancel(provider_account_id.clone());
    }

    /// Looks at `provider_account_id`'s windows again in a task of its own, after its window
    /// start or wake switch changed, so its timer and its booked wake follow the switches.
    pub fn look_at_windows(&self, provider_account_id: ProviderAccountId) {
        Arc::clone(&self.shared).spawn_window_start(provider_account_id);
    }

    /// Stops every account's job, timer and the wake watch; a read or turn under way finishes.
    pub fn stop(&self) {
        self.shared.schedule.forget_all();
        self.shared.window_timers.forget_all();
        if let Some(wake_watch) = lock(&self.shared.wake_watch).take() {
            wake_watch.abort();
        }
    }

    /// `Check now`: the last read while under a minute old, else a read now, written as the probe
    /// and taken even with the opt-out on; the hold's end while the ladder holds the account.
    /// Fails as [`ProviderAccountObserverError`] says.
    pub async fn check_now(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> Result<AccountReadAnswer, ProviderAccountObserverError> {
        self.shared
            .read(provider_account_id, ReadAsker::CheckNow)
            .await
    }

    /// The read a recording runs on an account whose sign-in is about to expire, so the provider
    /// renews it: the read in flight joined, else one taken now. A pasted token is never renewed
    /// this way, so its account is not asked. Fails as [`ProviderAccountObserverError`] says.
    pub async fn read_for_dictation(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> Result<AccountReadAnswer, ProviderAccountObserverError> {
        self.shared
            .read(provider_account_id, ReadAsker::Dictation)
            .await
    }
}

/// What a metered turn's end and a run's end are handed to; the background observer takes them,
/// each inside a tokio runtime.
pub trait AccountTurnObserver {
    /// A turn metered on `provider_account_id`'s account ended.
    fn turn_ended(&self, provider_account_id: ProviderAccountId);
    /// A run ended on some account.
    fn turn_closed(&self);
}

impl AccountTurnObserver for ProviderAccountObserver {
    /// Where the account's provider reads at a turn's end, the account is read in a task of its
    /// own, and its interval starts again from that read once the read answers figures; a read
    /// refused or with no answer leaves the interval as it was. While a turn on the account still
    /// reads as live the read is owed to the next run's end.
    fn turn_ended(&self, provider_account_id: ProviderAccountId) {
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move {
            if let Err(error) = shared.read_at_turn_end(provider_account_id).await {
                log_read_failure(&error);
            }
        });
    }

    /// Each turn-end read a live turn turned away is asked again in a task of its own, and is owed
    /// again while a turn on its account still reads as live.
    fn turn_closed(&self) {
        if lock(&self.shared.turn_end_reads_owed).is_empty() {
            return;
        }
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move { shared.read_owed_turn_end_reads().await });
    }
}

impl SignedInAccountWatcher for ProviderAccountObserver {
    /// Watches the account as [`ProviderAccountObserver::watch`] does, its failure logged: it fails
    /// only once the scheduler has stopped, which the daemon's stop does.
    fn watch_signed_in(&self, account: &RegisteredAccount) {
        if let Err(error) = self.watch(account) {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a signed-in account is not observed"
            );
        }
    }
}

impl ObserverShared {
    // The turn-end read of an account whose provider reads at a turn's end, and the restart of
    // its interval from a read that answered figures, so a read a held home turned away never
    // pushes the next one back; while a turn reads as live the read is owed, not taken.
    async fn read_at_turn_end(
        self: &Arc<Self>,
        provider_account_id: ProviderAccountId,
    ) -> Result<(), ProviderAccountObserverError> {
        let provider = self
            .registry
            .read(provider_account_id.clone())
            .await?
            .provider;
        if !self
            .legs
            .get(&provider)
            .is_some_and(|legs| legs.reads_at_turn_end())
        {
            return Ok(());
        }
        {
            // Held across the check and the mark, so a run's end that takes the owed reads either
            // comes first, its turn already read as ended here, or finds this one owed.
            let mut owed = lock(&self.turn_end_reads_owed);
            if !self
                .live_turns
                .sessions_with_live_turns(&provider_account_id)
                .is_empty()
            {
                owed.insert(provider_account_id);
                return Ok(());
            }
        }
        let answer = self
            .read(provider_account_id.clone(), ReadAsker::TurnEnd)
            .await?;
        if let AccountReadAnswer::Read(AccountReading {
            observation: Some(ProviderObservation::Figures(_)),
            ..
        }) = answer
        {
            self.schedule.restart(&provider_account_id)?;
        }
        Ok(())
    }

    // Asks each owed turn-end read again, one after another, each failure written to the service
    // log.
    async fn read_owed_turn_end_reads(self: &Arc<Self>) {
        let owed = std::mem::take(&mut *lock(&self.turn_end_reads_owed));
        for provider_account_id in owed {
            if let Err(error) = self.read_at_turn_end(provider_account_id).await {
                log_read_failure(&error);
            }
        }
    }

    // Runs a read no caller waits on, its failure written to the service log.
    fn spawn_read(self: Arc<Self>, provider_account_id: ProviderAccountId, asker: ReadAsker) {
        tokio::spawn(async move {
            if let Err(error) = self.read(provider_account_id, asker).await {
                log_read_failure(&error);
            }
        });
    }

    async fn read(
        self: &Arc<Self>,
        provider_account_id: ProviderAccountId,
        asker: ReadAsker,
    ) -> Result<AccountReadAnswer, ProviderAccountObserverError> {
        let account = self.registry.read(provider_account_id.clone()).await?;
        let last = lock(&self.accounts)
            .get(&provider_account_id)
            .and_then(|memory| memory.last.clone());
        if asker != ReadAsker::CheckNow && !account.probe_enabled {
            return Ok(AccountReadAnswer::NotNow { last });
        }
        if asker == ReadAsker::CheckNow
            && let Some(last) = last.as_ref().filter(|last| self.is_under_floor(last))
        {
            return Ok(AccountReadAnswer::Read(last.clone()));
        }
        if !self
            .live_turns
            .sessions_with_live_turns(&provider_account_id)
            .is_empty()
        {
            return Ok(AccountReadAnswer::NotNow { last });
        }
        let now = self.wall_clock.now();
        if let Some(until) =
            ladder::hold_in_force(&self.registry, &provider_account_id, now).await?
        {
            return Ok(AccountReadAnswer::Held { until });
        }
        let legs = self
            .legs
            .get(&account.provider)
            .cloned()
            .ok_or(ProviderAccountObserverError::ProviderUnobserved)?;
        let shared = Arc::clone(self);
        let answer = self
            .reads
            .run_if_free(provider_account_id.clone(), move || {
                async move {
                    // Read under the home's hold: a sign-in puts its account in flight before it
                    // holds the home to note the generation its save compares, so a read either
                    // finds it in flight or is stored before that note.
                    if shared.accounts_in_flight.is_in_flight(&account.account_id) {
                        return Ok(None);
                    }
                    shared
                        .take_reading(account, legs, asker.writer())
                        .await
                        .map(Some)
                        .map_err(Arc::new)
                }
                .boxed()
            })
            .await?;
        match answer {
            None | Some(Ok(None)) => Ok(AccountReadAnswer::NotNow { last }),
            Some(Ok(Some(reading))) => {
                Arc::clone(self).spawn_window_start(provider_account_id);
                Ok(AccountReadAnswer::Read(reading))
            }
            Some(Err(error)) => Err(ProviderAccountObserverError::ReadFailed(error)),
        }
    }

    fn is_under_floor(&self, reading: &AccountReading) -> bool {
        let now = ladder::timestamp(self.wall_clock.now());
        reading
            .read_at
            .timestamp()
            .is_some_and(|read_at| now.duration_since(read_at) < CHECK_NOW_FLOOR)
    }

    // The read itself, run under the home's hold: the provider's one reader at a time where its
    // reads each start a process, the answer bounded, then stored.
    async fn take_reading(
        &self,
        account: RegisteredAccount,
        legs: Arc<dyn ProviderObserveLegs>,
        writer: HealthObserver,
    ) -> Result<AccountReading, ProviderAccountObserverError> {
        let one_at_a_time = self.one_reader_at_a_time.get(&account.provider).cloned();
        let _reader_turn = match &one_at_a_time {
            Some(one_at_a_time) => Some(one_at_a_time.lock().await),
            None => None,
        };
        let folders = self
            .account_reader
            .resolve_account_folders(account.account_id.clone())
            .await
            .map_err(ProviderAccountObserverError::Folders)?;
        let observation = if let Some(token_limits) = self.token_limits_legs_of(&account) {
            self.read_token_limits(&account, token_limits, folders)
                .await?
        } else {
            self.observe(&account, &*legs, folders).await
        };
        let now = self.wall_clock.now();
        let reading = AccountReading {
            observation,
            read_at: ladder::wire_instant(now),
        };
        self.store(&account, &reading, writer).await?;
        Ok(reading)
    }

    // The provider's limits read, bounded; `None` where it failed or took too long.
    async fn observe(
        &self,
        account: &RegisteredAccount,
        legs: &dyn ProviderObserveLegs,
        folders: ProviderAccountFolders,
    ) -> Option<ProviderObservation> {
        match tokio::time::timeout(
            READ_BOUND,
            legs.observe(account.account_id.clone(), folders),
        )
        .await
        {
            Ok(Ok(observation)) => Some(observation),
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an account's limits read failed"
                );
                None
            }
            Err(_elapsed) => {
                tracing::warn!("an account's limits read took too long");
                None
            }
        }
    }

    // Stores what `reading` says of the account: its figures, its health and its place on the
    // ladder.
    async fn store(
        &self,
        account: &RegisteredAccount,
        reading: &AccountReading,
        writer: HealthObserver,
    ) -> Result<(), ProviderAccountObserverError> {
        let account_id = &account.account_id;
        let now = self.wall_clock.now();
        let unanswered_before = lock(&self.accounts)
            .get(account_id)
            .map_or(0, |memory| memory.unanswered_in_a_row);
        let (stored, unanswered_in_a_row) = match &reading.observation {
            Some(ProviderObservation::Figures(figures)) => {
                self.store_figures(account, figures, &reading.read_at)
                    .await?;
                self.registry.clear_read_hold(account_id).await?;
                (Some((ProviderAccountHealthState::Authenticated, writer)), 0)
            }
            Some(ProviderObservation::SignInGone) => (
                Some((ProviderAccountHealthState::ReauthRequired, writer)),
                0,
            ),
            Some(ProviderObservation::OutOfScope) => (None, 0),
            Some(ProviderObservation::RefusedInBand) => {
                let hold = ladder::climb(&self.registry, account_id, now).await?;
                let in_a_row = (unanswered_before + 1).max(hold.rung);
                (indeterminate_after(in_a_row), in_a_row)
            }
            Some(ProviderObservation::SignInRefusedBeforeAnswer) => {
                ladder::climb(&self.registry, account_id, now).await?;
                (
                    Some((
                        ProviderAccountHealthState::Indeterminate,
                        HealthObserver::Background,
                    )),
                    unanswered_before + 1,
                )
            }
            Some(ProviderObservation::Unanswered) | None => {
                let in_a_row = unanswered_before + 1;
                (indeterminate_after(in_a_row), in_a_row)
            }
        };
        let is_rewritten = stored.is_some()
            || matches!(reading.observation, Some(ProviderObservation::Figures(_)));
        if let Some((state, writer)) = stored {
            let observation = HealthObservation {
                state,
                observed_at: reading.read_at.clone(),
            };
            self.registry
                .record_health(account_id, &observation, writer)
                .await?;
        }
        {
            let mut accounts = lock(&self.accounts);
            let memory = accounts.entry(account_id.clone()).or_default();
            memory.last = Some(reading.clone());
            memory.unanswered_in_a_row = unanswered_in_a_row;
        }
        if is_rewritten {
            let account = self.registry.read(account_id.clone()).await?;
            self.publisher
                .publish(ProviderAccountNotification::AccountChanged {
                    account: account.to_provider_account(),
                });
        }
        Ok(())
    }
}

// `indeterminate` from the second read in a row with no answer, written as the background
// observer, since not telling is never a crossing that moves the generation.
fn indeterminate_after(in_a_row: u32) -> Option<(ProviderAccountHealthState, HealthObserver)> {
    (in_a_row >= UNANSWERED_BEFORE_INDETERMINATE).then_some((
        ProviderAccountHealthState::Indeterminate,
        HealthObserver::Background,
    ))
}

fn log_read_failure(error: &ProviderAccountObserverError) {
    tracing::warn!(
        error = error as &(dyn std::error::Error + 'static),
        "an account could not be observed"
    );
}

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;

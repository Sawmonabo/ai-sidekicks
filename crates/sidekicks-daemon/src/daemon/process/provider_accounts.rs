//! The provider account plane at the daemon's start: the account registry, the accounts reader the
//! drivers resolve folders through, the token custody and its sweep of what a stop left, the sweep
//! of what each provider's stopped sign-in move left, the background sweep of the homes a stop left
//! minted for new accounts, the background observer over each provider's own legs, the sign-in
//! broker and the sources the `provider.account.*` methods act through, the current-account switch,
//! and the machine's wake helper where the system has one; and, once the recovery pass has run, the
//! observer's schedule, its follow of each metered turn and each run's end, the publishing of each
//! quota reading the window projection keeps, and the move of each session a stop left on another
//! account than its provider's current one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize as _;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::{
    UsageRateLimitUpdatedPayload, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::provider::account::record::{
    PROVIDER_QUOTA_DEFAULT_LIMIT_ID, ProviderAccountNotification,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::transcript::run_facts::RunStateEventType;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_platforms::{Spawner, WallClock, wake_helper};
use sidekicks_provider::account::credential_home::ACCOUNT_SIGN_OUT_BOUND;
use sidekicks_provider::account::errors::ProviderAccountRegistryError;
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::window_store::read_usage_windows;
use sidekicks_provider::account::observer::{
    AccountLiveTurns, AccountTurnObserver, ProviderAccountObserver, ProviderAccountObserverDeps,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::account::sign_in::{
    AccountsInFlight, ProviderAccountNotificationPublisher, ProviderSignInBroker,
    SignedInAccountWatcher,
};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::account::wake_helper::{MachineWakeHelper, SystemWakeHelper};
use sidekicks_provider::driver::ProviderAccountReader;
use sidekicks_provider::driver::contract::account::{
    ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObserveLegs, ProviderSignInLegs,
    ProviderSwitchLegs, ProviderTokenLimitsLegs, ProviderTokenStatusLegs, ProviderWindowTurnLegs,
};
use sidekicks_provider::driver::ports::RequestHeldListener;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_recovery::account_homes::LeftoverMintedHomes;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::usage_record::UsageRecord;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::followers::{
    CommittedEvent, FollowerAttachment, SessionEventFollowers,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::runtime::Handle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::daemon::process::start::error::DaemonStartError;
use crate::daemon::process::stop::{DaemonStopFailure, end_start_tasks};
use crate::ipc::handlers::provider_account::ProviderAccountMethodSources;
use crate::ipc::handlers::provider_account::notifications::ProviderAccountNotifications;
use crate::orchestration::account_switch::{
    AccountSwitch, AccountSwitchDeps, SessionAccountMoveRecord,
};

// What the background sweep of new accounts' homes does, as a stop that ends it names it.
const MINTED_HOME_SWEEP_TASK: &str = "sweep of the homes a stop left minted for new accounts";

// The wake helper's program, which the service ships beside its own.
const WAKE_HELPER_PROGRAM_NAME: &str = "sidekicks-wake-helper";

/// What the account plane is built from.
pub(crate) struct ProviderAccountPlaneStart<'start> {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one database writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The daemon's data folder, absolute, where each account's home is minted.
    pub(crate) data_folder: &'start Path,
    /// The daemon's keychain service for provider tokens.
    pub(crate) provider_tokens: Arc<dyn SecretKeychain>,
    /// Every driver, whose account legs the plane acts through.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The usage record, which takes each limits read's quota windows.
    pub(crate) usage: Arc<UsageRecord>,
    /// Each run's binding cursors, which tell the runs live on an account.
    pub(crate) binding_cursors: Arc<RunBindingCursors>,
    /// The daemon's one scheduler, which runs the observer's reads and window starts.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The daemon's wall clock.
    pub(crate) clock: Arc<dyn WallClock>,
    /// This machine's own device, whose sign-in may take the provider's callback here.
    pub(crate) machine_device_id: DeviceId,
    /// The thread every child starts on, the wake helper's administrator prompt among them.
    pub(crate) spawner: Spawner,
    /// The daemon's own program, beside which the wake helper's program is shipped.
    pub(crate) daemon_program: &'start Path,
    /// The sessions' provider processes, whose level control a switch moves a level through.
    pub(crate) provider_sessions: Arc<ProviderSessions>,
    /// Where a switch's settlements are appended.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The last good point of each session whose history is damaged.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The drivers' registration of the repricing's intake, which the observer hands each
    /// window-start turn to.
    pub(crate) request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    /// The daemon's start in its stored form, which the observer's window-start rows record.
    pub(crate) daemon_started_at: WireInstant,
}

/// The account plane, built before the socket serves.
pub(crate) struct ProviderAccountPlane {
    /// The accounts reader, which the drivers' port takes.
    pub(crate) reader: Arc<dyn ProviderAccountReader>,
    /// The account registry, which the drivers' account legs take through their port.
    pub(crate) registry: Arc<ProviderAccountRegistry>,
    /// The record of each session a driver moves onto another account outside a switch, which
    /// the drivers' port takes.
    pub(crate) account_move_record: Arc<SessionAccountMoveRecord>,
    /// The one lock on account homes every act in a home holds, which the drivers' port takes.
    pub(crate) home_lock: Arc<AccountHomeLock>,
    /// What the `provider.account.*` methods act through.
    pub(crate) methods: ProviderAccountMethodSources,
    /// The background observer, started once the recovery pass has run.
    pub(crate) observation: ProviderAccountObservation,
}

/// Builds the account plane over `start` and sweeps the provider tokens a stop left, then what
/// each provider's stopped sign-in move left, and begins in the background the sweep of the homes
/// a stop left minted for new accounts, which the start never waits on; a failed sweep is logged,
/// and the next start sweeps what it left. Runs inside the daemon's runtime.
pub(crate) async fn build_provider_account_plane(
    start: ProviderAccountPlaneStart<'_>,
) -> ProviderAccountPlane {
    let ProviderAccountPlaneStart {
        reads,
        writer,
        data_folder,
        provider_tokens,
        providers,
        usage,
        binding_cursors,
        scheduler,
        clock,
        machine_device_id,
        spawner,
        daemon_program,
        provider_sessions,
        appender,
        read_damaged_from_sequence,
        request_held,
        daemon_started_at,
    } = start;
    let wake_helper = wake_helper().map(|helper| {
        Arc::new(SystemWakeHelper::new(
            helper,
            spawner,
            daemon_program.with_file_name(WAKE_HELPER_PROGRAM_NAME),
        )) as Arc<dyn MachineWakeHelper>
    });
    let registry = Arc::new(ProviderAccountRegistry::new(
        Arc::clone(&reads),
        Arc::clone(&writer),
        data_folder.to_path_buf(),
    ));
    let reader: Arc<dyn ProviderAccountReader> = Arc::new(ProviderAccounts::new(
        Arc::clone(&reads),
        Arc::clone(&provider_tokens),
        registry.observed_auth_modes(),
    ));
    let ProviderAccountLegSet {
        account: account_legs,
        observe: observe_legs,
        memory_import: memory_import_legs,
        switch: switch_legs,
        window_turn: window_turn_legs,
        token_limits: token_limits_legs,
        sign_in: sign_in_legs,
        token_status: token_status_legs,
    } = collect_provider_account_legs(&providers);
    let token_custody = Arc::new(ProviderTokenCustody::new(
        Arc::clone(&registry),
        provider_tokens,
        token_status_legs,
    ));
    if let Err(error) = token_custody.sweep().await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "the provider tokens a stop left were not all swept; the next start sweeps the rest"
        );
    }
    remove_sign_in_move_leftovers(&account_legs, &registry).await;
    let minted_home_sweep = start_minted_home_sweep(
        &registry,
        &account_legs,
        data_folder.to_path_buf(),
        ACCOUNT_SIGN_OUT_BOUND,
    )
    .await;
    let home_lock = Arc::new(AccountHomeLock::default());
    let accounts_in_flight = Arc::new(AccountsInFlight::default());
    let live_turns: Arc<dyn AccountLiveTurns> = Arc::clone(&binding_cursors) as _;
    let publisher = Arc::new(ProviderAccountNotifications::new());
    let observer = Arc::new(ProviderAccountObserver::new(ProviderAccountObserverDeps {
        registry: Arc::clone(&registry),
        account_reader: Arc::clone(&reader),
        legs: observe_legs,
        window_turn_legs,
        token_limits_legs,
        token_custody: Arc::clone(&token_custody),
        database_reads: Arc::clone(&reads),
        database_writer: writer,
        usage,
        live_turns: Arc::clone(&live_turns),
        accounts_in_flight: Arc::clone(&accounts_in_flight),
        home_lock: Arc::clone(&home_lock),
        scheduler,
        wall_clock: clock,
        wake_helper: wake_helper.clone(),
        publisher: Arc::clone(&publisher) as _,
        request_held,
        daemon_started_at,
    }));
    let sign_in = Arc::new(ProviderSignInBroker::new(
        Arc::clone(&registry),
        sign_in_legs,
        account_legs.clone(),
        Arc::clone(&publisher) as _,
        Arc::clone(&observer) as Arc<dyn SignedInAccountWatcher>,
        Arc::clone(&home_lock),
        Arc::clone(&accounts_in_flight),
    ));
    let account_switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
        accounts: Arc::clone(&registry),
        accounts_in_flight: Arc::clone(&accounts_in_flight),
        account_reader: Arc::clone(&reader),
        switch_legs,
        providers: Arc::clone(&providers),
        level_moves: provider_sessions,
        appender,
        reads: Arc::clone(&reads),
        read_damaged_from_sequence,
    }));
    let account_move_record = Arc::new(SessionAccountMoveRecord::new(
        &account_switch,
        machine_device_id.clone(),
    ));
    ProviderAccountPlane {
        methods: ProviderAccountMethodSources {
            accounts: Arc::clone(&registry),
            providers,
            sign_in: Arc::clone(&sign_in),
            accounts_in_flight,
            token_custody,
            observer: Arc::clone(&observer),
            account_reader: Arc::clone(&reader),
            account_legs,
            memory_import_legs,
            home_lock: Arc::clone(&home_lock),
            live_turns,
            publisher: Arc::clone(&publisher),
            database_reads: Arc::clone(&reads),
            machine_device_id: machine_device_id.clone(),
            wake_helper,
            account_switch: Arc::clone(&account_switch),
        },
        reader,
        registry,
        account_move_record,
        home_lock,
        observation: ProviderAccountObservation {
            observer,
            usage_events: None,
            sign_in,
            account_switch,
            machine_device_id,
            reads,
            publisher,
            minted_home_sweep: Some(minted_home_sweep),
        },
    }
}

/// Reads the homes a stop left minted for new accounts before any sign-in can mint another, then
/// signs out and removes on a task of its own those no row took, each sign-out within `bound`, so
/// the start never waits on a provider's sign-out. Answers that task.
pub(super) async fn start_minted_home_sweep(
    registry: &ProviderAccountRegistry,
    account_legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>,
    data_folder: PathBuf,
    bound: Duration,
) -> JoinHandle<()> {
    let leftovers = LeftoverMintedHomes::read(registry, data_folder).await;
    let account_legs = account_legs.clone();
    tokio::spawn(async move { leftovers.remove_unadmitted(&account_legs, bound).await })
}

// Removes what each provider's stopped sign-in move left beside its accounts, logging each
// leftover not removed and each provider whose sweep could not run; the next start sweeps again.
async fn remove_sign_in_move_leftovers(
    account_legs: &HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>,
    registry: &ProviderAccountRegistry,
) {
    for (provider, legs) in account_legs {
        match legs.remove_sign_in_move_leftovers(registry).await {
            Ok(unremoved) => {
                for failure in unremoved {
                    tracing::warn!(
                        provider = provider.as_str(),
                        error = &failure as &(dyn std::error::Error + 'static),
                        "a stopped sign-in move's leftover stays until the next start sweeps it"
                    );
                }
            }
            Err(error) => tracing::warn!(
                provider = provider.as_str(),
                error = &error as &(dyn std::error::Error + 'static),
                "a stopped sign-in move's leftovers were not swept; the next start sweeps them"
            ),
        }
    }
}

/// Each provider's account legs, and each act they offer, by provider.
#[derive(Default)]
pub(super) struct ProviderAccountLegSet {
    /// Every provider's account legs.
    pub(super) account: HashMap<ProviderId, Arc<dyn ProviderAccountLegs>>,
    /// The limits reads the providers offer.
    pub(super) observe: HashMap<ProviderId, Arc<dyn ProviderObserveLegs>>,
    /// The memory imports the providers offer.
    pub(super) memory_import: HashMap<ProviderId, Arc<dyn ProviderMemoryImportLegs>>,
    /// The moves of running sessions onto another account the providers offer.
    pub(super) switch: HashMap<ProviderId, Arc<dyn ProviderSwitchLegs>>,
    /// The throwaway window-start turns the providers offer.
    pub(super) window_turn: HashMap<ProviderId, Arc<dyn ProviderWindowTurnLegs>>,
    /// The pasted-token limits reads by a turn the providers offer.
    pub(super) token_limits: HashMap<ProviderId, Arc<dyn ProviderTokenLimitsLegs>>,
    /// The interactive sign-ins the providers offer.
    pub(super) sign_in: HashMap<ProviderId, Arc<dyn ProviderSignInLegs>>,
    /// The pasted-token status reads the providers offer.
    pub(super) token_status: HashMap<ProviderId, Arc<dyn ProviderTokenStatusLegs>>,
}

/// Asks each driver in `providers` for its account legs and for each act they offer.
pub(super) fn collect_provider_account_legs(providers: &ProviderRegistry) -> ProviderAccountLegSet {
    let mut legs_set = ProviderAccountLegSet::default();
    for (provider, driver) in providers.drivers() {
        let legs = driver.account_legs();
        if let Some(observe) = Arc::clone(&legs).observe_legs() {
            legs_set.observe.insert(provider.clone(), observe);
        }
        if let Some(memory_import) = Arc::clone(&legs).memory_import_legs() {
            legs_set
                .memory_import
                .insert(provider.clone(), memory_import);
        }
        if let Some(switch) = Arc::clone(&legs).switch_legs() {
            legs_set.switch.insert(provider.clone(), switch);
        }
        if let Some(window_turn) = Arc::clone(&legs).window_turn_legs() {
            legs_set.window_turn.insert(provider.clone(), window_turn);
        }
        if let Some(token_limits) = Arc::clone(&legs).token_limits_legs() {
            legs_set.token_limits.insert(provider.clone(), token_limits);
        }
        if let Some(sign_in) = Arc::clone(&legs).sign_in_legs() {
            legs_set.sign_in.insert(provider.clone(), sign_in);
        }
        if let Some(token_status) = Arc::clone(&legs).token_status_legs() {
            legs_set.token_status.insert(provider.clone(), token_status);
        }
        legs_set.account.insert(provider.clone(), legs);
    }
    legs_set
}

/// The background observer, and its follow of each metered turn and each quota reading once
/// started, beside the sign-ins and the sweep of new accounts' homes the stop ends and the switch
/// that moves the sessions a stop left behind.
pub(crate) struct ProviderAccountObservation {
    observer: Arc<ProviderAccountObserver>,
    usage_events: Option<FollowerAttachment>,
    sign_in: Arc<ProviderSignInBroker>,
    account_switch: Arc<AccountSwitch>,
    machine_device_id: DeviceId,
    // The window projection's reads, and where each reading it keeps goes out.
    reads: Arc<DatabaseReadPool>,
    publisher: Arc<ProviderAccountNotifications>,
    // The start's sweep of the homes a stop left minted for new accounts, until the stop ends it.
    minted_home_sweep: Option<JoinHandle<()>>,
}

impl ProviderAccountObservation {
    /// Moves each session a stop left on another account than its provider's current one onto
    /// it, schedules every registered account's reads and window starts, has each turn metered
    /// on an account end that account's turn and each run's end ask the turn-end reads a live turn
    /// turned away, and publishes each quota reading a turn pushed as the window projection keeps
    /// it, the observer publishing what its own reads keep. Fails when those sessions or the
    /// accounts cannot be read or the scheduler has stopped. Runs inside the daemon's runtime,
    /// which each turn's end and each reading is read on.
    pub(crate) async fn start(
        &mut self,
        followers: &Arc<SessionEventFollowers>,
    ) -> Result<(), DaemonStartError> {
        // Before the start admits the runs the stop left waiting, so none begins on the old
        // account.
        self.account_switch
            .follow_current_accounts(&self.machine_device_id)
            .await
            .map_err(DaemonStartError::AccountFollow)?;
        self.observer.start().await?;
        let observer = Arc::clone(&self.observer);
        let reads = Arc::clone(&self.reads);
        let publisher: Arc<dyn ProviderAccountNotificationPublisher> =
            Arc::clone(&self.publisher) as _;
        let runtime = Handle::current();
        // The binding cursors' follow, attached before this one, has recorded an ended run by the
        // time this hears it, so the run's turn no longer reads as live.
        self.usage_events = Some(followers.follow_all(move |event| {
            Ok(follow_usage_event(
                &*observer, &reads, &publisher, event, &runtime,
            )?)
        }));
        Ok(())
    }

    /// Cancels every sign-in under way and waits up to `bound` for each to settle, a new
    /// account's minted home signed out, where its provider ran there, and removed, answering
    /// whether all did.
    pub(crate) async fn end_sign_ins(&self, bound: Duration) -> bool {
        self.sign_in.stop(bound).await
    }

    /// Waits up to `bound` for the start's sweep of the homes a stop left minted for new accounts,
    /// ending it then; a home it did not reach stays marked for the next start. Answers the sweep
    /// when it ended abnormally or ran past the bound.
    pub(crate) async fn end_minted_home_sweep(
        &mut self,
        bound: Duration,
    ) -> Vec<DaemonStopFailure> {
        end_start_tasks(
            self.minted_home_sweep
                .take()
                .map(|sweep| (MINTED_HOME_SWEEP_TASK, sweep)),
            bound,
        )
        .await
    }

    /// A subscription to the account notices, reading every one published from this call on.
    pub(crate) fn account_notices(&self) -> broadcast::Receiver<ProviderAccountNotification> {
        self.publisher.subscribe()
    }

    /// Ends the follow and every account's job, timer and the wake watch; a read under way
    /// finishes.
    pub(crate) fn stop(&mut self) {
        self.usage_events = None;
        self.observer.stop();
    }
}

/// The follow of each committed `event` once the observer has started, run on the writer's pump,
/// so it only reads the event and hands it on inside `runtime`: a metered turn's end or a run's
/// end to `observer`, and a quota reading a turn pushed to `publisher` as the window projection
/// over `reads` keeps it. Fails as the event's payload does not read.
pub(super) fn follow_usage_event(
    observer: &dyn AccountTurnObserver,
    reads: &Arc<DatabaseReadPool>,
    publisher: &Arc<dyn ProviderAccountNotificationPublisher>,
    event: &CommittedEvent,
    runtime: &Handle,
) -> Result<(), serde_json::Error> {
    if hand_turn_end(observer, event, runtime)? {
        return Ok(());
    }
    if event.envelope.event_type() == SessionEventType::UsageRateLimitUpdated {
        let updated = UsageRateLimitUpdatedPayload::deserialize(event.envelope.payload())?;
        // A limits read's whole set goes out from the observer once the read's time is on the
        // account's row; only what a turn pushed goes out from here.
        if updated.whole_set.is_some() {
            return Ok(());
        }
        let (reads, publisher) = (Arc::clone(reads), Arc::clone(publisher));
        runtime.spawn(async move {
            if let Err(error) = publish_usage_window(&reads, &*publisher, &updated).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a quota reading was not published; the next list reads it"
                );
            }
        });
    }
    Ok(())
}

// Hands `observer`, inside `runtime`, the turn `event` metered as ended on its account, or the
// run whose terminal state it records as closed; answers whether `event` was either. Fails as a
// metered turn's payload does not read.
fn hand_turn_end(
    observer: &dyn AccountTurnObserver,
    event: &CommittedEvent,
    runtime: &Handle,
) -> Result<bool, serde_json::Error> {
    let event_type = event.envelope.event_type();
    if event_type == SessionEventType::UsageTokenCountRecorded {
        let recorded = UsageTokenCountRecordedPayload::deserialize(event.envelope.payload())?;
        let _runtime = runtime.enter();
        observer.turn_ended(recorded.provider_account_id);
        return Ok(true);
    }
    if RunStateEventType::try_from(event_type)
        .is_ok_and(|run_state| run_state.state().is_terminal())
    {
        let _runtime = runtime.enter();
        observer.turn_closed();
        return Ok(true);
    }
    Ok(false)
}

/// Publishes the window `updated` names as the window projection now keeps it, the newest reading
/// of that account, limit and length, or label where it has no length; nothing where the
/// projection keeps none, as for a reading it takes no row for. Fails when the stored readings
/// cannot be read.
pub(super) async fn publish_usage_window(
    reads: &DatabaseReadPool,
    publisher: &dyn ProviderAccountNotificationPublisher,
    updated: &UsageRateLimitUpdatedPayload,
) -> Result<(), ProviderAccountRegistryError> {
    let limit_id = updated
        .limit_id
        .as_ref()
        .map_or(PROVIDER_QUOTA_DEFAULT_LIMIT_ID, |limit_id| {
            limit_id.as_str()
        });
    let window = read_usage_windows(reads, Some(updated.provider.clone()))
        .await?
        .into_iter()
        .find(|window| {
            window.account_id == updated.provider_account_id
                && window.limit_id.as_str() == limit_id
                && window
                    .window_mins
                    .map(|window_mins| window_mins.get().cast_signed())
                    == updated.window_mins.map(SafeSignedInt::get)
                && window.label == updated.label
        });
    if let Some(window) = window {
        publisher.publish(ProviderAccountNotification::UsageWindowUpdated {
            account_id: window.account_id.clone(),
            window,
        });
    }
    Ok(())
}

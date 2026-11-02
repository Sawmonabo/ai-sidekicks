//! The provider account plane at the daemon's start: the account registry, the accounts reader the
//! drivers resolve folders through, the token custody and its sweep of what a stop left, the
//! background observer over each provider's own legs, the sign-in broker and the sources the
//! `provider.account.*` methods act through, the current-account switch, and the machine's wake
//! helper where the system has one; and, once the recovery pass has run, the observer's schedule,
//! its follow of each metered turn, and the move of each session a stop left on another account
//! than its provider's current one.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize as _;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::UsageTokenCountRecordedPayload;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_platforms::{Spawner, WallClock, wake_helper};
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::{
    AccountLiveTurns, ProviderAccountObserver, ProviderAccountObserverDeps,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::account::sign_in::{ProviderSignInBroker, SignedInAccountWatcher};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::account::wake_helper::{MachineWakeHelper, SystemWakeHelper};
use sidekicks_provider::driver::ProviderAccountReader;
use sidekicks_provider::driver::contract::account::{
    ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObserveLegs, ProviderSignInLegs,
    ProviderSwitchLegs, ProviderTokenStatusLegs, ProviderWindowTurnLegs,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::usage_record::UsageRecord;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::runtime::Handle;

use crate::daemon::process::start_error::DaemonStartError;
use crate::ipc::handlers::provider_account::ProviderAccountMethodSources;
use crate::ipc::handlers::provider_account::notifications::ProviderAccountNotifications;
use crate::orchestration::account_switch::{AccountSwitch, AccountSwitchDeps};

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
}

/// The account plane, built before the socket serves.
pub(crate) struct ProviderAccountPlane {
    /// The accounts reader, which the drivers' port takes.
    pub(crate) reader: Arc<dyn ProviderAccountReader>,
    /// The account registry, which the drivers' account legs take through their port.
    pub(crate) registry: Arc<ProviderAccountRegistry>,
    /// What the `provider.account.*` methods act through.
    pub(crate) methods: ProviderAccountMethodSources,
    /// The background observer, started once the recovery pass has run.
    pub(crate) observation: ProviderAccountObservation,
}

/// Builds the account plane over `start` and sweeps the provider tokens a stop left; a failed
/// sweep is logged, and the next start sweeps what it left. Runs inside the daemon's runtime.
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
    ));
    let ProviderAccountLegSet {
        account: account_legs,
        observe: observe_legs,
        memory_import: memory_import_legs,
        switch: switch_legs,
        window_turn: window_turn_legs,
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
    let home_lock = Arc::new(AccountHomeLock::default());
    let live_turns: Arc<dyn AccountLiveTurns> = binding_cursors;
    let observer = Arc::new(ProviderAccountObserver::new(ProviderAccountObserverDeps {
        registry: Arc::clone(&registry),
        account_reader: Arc::clone(&reader),
        legs: observe_legs,
        window_turn_legs,
        token_custody: Arc::clone(&token_custody),
        database_reads: Arc::clone(&reads),
        database_writer: writer,
        usage,
        live_turns: Arc::clone(&live_turns),
        home_lock: Arc::clone(&home_lock),
        scheduler,
        wall_clock: clock,
        wake_helper: wake_helper.clone(),
    }));
    let publisher = Arc::new(ProviderAccountNotifications::new());
    let sign_in = Arc::new(ProviderSignInBroker::new(
        Arc::clone(&registry),
        sign_in_legs,
        Arc::clone(&publisher) as _,
        Arc::clone(&observer) as Arc<dyn SignedInAccountWatcher>,
    ));
    let account_switch = Arc::new(AccountSwitch::new(AccountSwitchDeps {
        accounts: Arc::clone(&registry),
        account_reader: Arc::clone(&reader),
        switch_legs,
        providers: Arc::clone(&providers),
        level_moves: provider_sessions,
        appender,
        reads: Arc::clone(&reads),
        read_damaged_from_sequence,
    }));
    ProviderAccountPlane {
        methods: ProviderAccountMethodSources {
            accounts: Arc::clone(&registry),
            providers,
            sign_in,
            token_custody,
            observer: Arc::clone(&observer),
            account_reader: Arc::clone(&reader),
            account_legs,
            memory_import_legs,
            home_lock,
            live_turns,
            publisher,
            database_reads: reads,
            machine_device_id: machine_device_id.clone(),
            wake_helper,
            account_switch: Arc::clone(&account_switch),
        },
        reader,
        registry,
        observation: ProviderAccountObservation {
            observer,
            turn_ends: None,
            account_switch,
            machine_device_id,
        },
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
    /// The throwaway window and token-limits turns the providers offer.
    pub(super) window_turn: HashMap<ProviderId, Arc<dyn ProviderWindowTurnLegs>>,
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

/// The background observer, and its follow of each metered turn once started, beside the switch
/// that moves the sessions a stop left behind.
pub(crate) struct ProviderAccountObservation {
    observer: Arc<ProviderAccountObserver>,
    turn_ends: Option<FollowerAttachment>,
    account_switch: Arc<AccountSwitch>,
    machine_device_id: DeviceId,
}

impl ProviderAccountObservation {
    /// Moves each session a stop left on another account than its provider's current one onto
    /// it, schedules every registered account's reads and window starts, and has each turn metered
    /// on an account end that account's turn. Fails when those sessions or the accounts cannot be
    /// read or the scheduler has stopped. Runs inside the daemon's runtime, which each turn's end
    /// is read on.
    pub(crate) async fn start(
        &mut self,
        followers: &Arc<SessionEventFollowers>,
    ) -> Result<(), DaemonStartError> {
        // Before the start admits the runs the stop left waiting, so none begins on the old account.
        self.account_switch
            .follow_current_accounts(&self.machine_device_id)
            .await
            .map_err(DaemonStartError::AccountFollow)?;
        self.observer.start().await?;
        let observer = Arc::clone(&self.observer);
        let runtime = Handle::current();
        // Runs on the writer's pump, so it only reads the account and hands the end on.
        self.turn_ends = Some(followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::UsageTokenCountRecorded {
                let recorded =
                    UsageTokenCountRecordedPayload::deserialize(event.envelope.payload())?;
                let _runtime = runtime.enter();
                observer.turn_ended(recorded.provider_account_id);
            }
            Ok(())
        }));
        Ok(())
    }

    /// Ends the follow and every account's job, timer and the wake watch; a read under way
    /// finishes.
    pub(crate) fn stop(&mut self) {
        self.turn_ends = None;
        self.observer.stop();
    }
}

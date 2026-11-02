//! The provider account plane at the daemon's start: the account registry, the accounts reader the
//! drivers resolve folders through, the token custody and its sweep of what a stop left, the
//! background observer over each provider's own legs, the sign-in broker and the sources the
//! `provider.account.*` methods act through; and, once the recovery pass has run, the observer's
//! schedule and its follow of each metered turn.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize as _;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::UsageTokenCountRecordedPayload;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_platforms::WallClock;
use sidekicks_provider::account::home_lock::AccountHomeLock;
use sidekicks_provider::account::observer::{
    AccountLiveTurns, ProviderAccountObserver, ProviderAccountObserverDeps,
    ProviderAccountObserverError,
};
use sidekicks_provider::account::registry::ProviderAccountRegistry;
use sidekicks_provider::account::resolver::ProviderAccounts;
use sidekicks_provider::account::sign_in::{ProviderSignInBroker, SignedInAccountWatcher};
use sidekicks_provider::account::token_custody::ProviderTokenCustody;
use sidekicks_provider::driver::ProviderAccountReader;
use sidekicks_provider::driver::contract::account::{
    ProviderAccountLegs, ProviderMemoryImportLegs, ProviderObserveLegs,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::usage_record::UsageRecord;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use tokio::runtime::Handle;

use crate::ipc::handlers::provider_account::ProviderAccountMethodSources;
use crate::ipc::handlers::provider_account::notifications::ProviderAccountNotifications;

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
    } = start;
    let registry = Arc::new(ProviderAccountRegistry::new(
        Arc::clone(&reads),
        Arc::clone(&writer),
        data_folder.to_path_buf(),
    ));
    let reader: Arc<dyn ProviderAccountReader> = Arc::new(ProviderAccounts::new(
        Arc::clone(&reads),
        Arc::clone(&provider_tokens),
    ));
    // No provider's legs read a pasted token's status yet, so a token registration refuses.
    let token_custody = Arc::new(ProviderTokenCustody::new(
        Arc::clone(&registry),
        provider_tokens,
        HashMap::new(),
    ));
    if let Err(error) = token_custody.sweep().await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "the provider tokens a stop left were not all swept; the next start sweeps the rest"
        );
    }
    let mut account_legs: HashMap<ProviderId, Arc<dyn ProviderAccountLegs>> = HashMap::new();
    let mut observe_legs: HashMap<ProviderId, Arc<dyn ProviderObserveLegs>> = HashMap::new();
    let mut memory_import_legs: HashMap<ProviderId, Arc<dyn ProviderMemoryImportLegs>> =
        HashMap::new();
    for (provider, driver) in providers.drivers() {
        let legs = driver.account_legs();
        if let Some(observe) = Arc::clone(&legs).observe_legs() {
            observe_legs.insert(provider.clone(), observe);
        }
        if let Some(memory_import) = Arc::clone(&legs).memory_import_legs() {
            memory_import_legs.insert(provider.clone(), memory_import);
        }
        account_legs.insert(provider.clone(), legs);
    }
    let home_lock = Arc::new(AccountHomeLock::default());
    let live_turns: Arc<dyn AccountLiveTurns> = binding_cursors;
    let observer = Arc::new(ProviderAccountObserver::new(ProviderAccountObserverDeps {
        registry: Arc::clone(&registry),
        account_reader: Arc::clone(&reader),
        legs: observe_legs,
        window_turn_legs: HashMap::new(),
        token_custody: Arc::clone(&token_custody),
        database_reads: Arc::clone(&reads),
        database_writer: writer,
        usage,
        live_turns: Arc::clone(&live_turns),
        home_lock: Arc::clone(&home_lock),
        scheduler,
        wall_clock: clock,
    }));
    let publisher = Arc::new(ProviderAccountNotifications::new());
    // No provider's sign-in legs are built yet, so each sign-in refuses as unsupported.
    let sign_in = Arc::new(ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::new(),
        Arc::clone(&publisher) as _,
        Arc::clone(&observer) as Arc<dyn SignedInAccountWatcher>,
    ));
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
            machine_device_id,
        },
        reader,
        registry,
        observation: ProviderAccountObservation {
            observer,
            turn_ends: None,
        },
    }
}

/// The background observer, and its follow of each metered turn once started.
pub(crate) struct ProviderAccountObservation {
    observer: Arc<ProviderAccountObserver>,
    turn_ends: Option<FollowerAttachment>,
}

impl ProviderAccountObservation {
    /// Schedules every registered account's reads and window starts, and has each turn metered
    /// on an account end that account's turn. Fails when the accounts cannot be listed or the
    /// scheduler has stopped. Runs inside the daemon's runtime, which each turn's end is read on.
    pub(crate) async fn start(
        &mut self,
        followers: &Arc<SessionEventFollowers>,
    ) -> Result<(), ProviderAccountObserverError> {
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

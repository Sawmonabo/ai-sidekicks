//! The driver registry other areas' tests build on: the table's first providers answered by
//! stand-in drivers, and a run bound to the first one.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

use crate::database::writer::test_file::TestDatabase;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};

thread_local! {
    // The drivers the next registry this thread builds registers, in the table's order.
    static NEXT_DRIVERS: RefCell<VecDeque<Arc<dyn ProviderDriver>>> =
        const { RefCell::new(VecDeque::new()) };
}

// Hands the registry the next driver the test queued.
fn take_next_driver(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
    NEXT_DRIVERS
        .with_borrow_mut(VecDeque::pop_front)
        .expect("the registry is built right after its drivers are queued")
}

/// A registry holding only the table's first provider, answered by `driver`. Called on a tokio
/// runtime, which the spawner thread is started on.
pub(crate) fn registry_of_first_provider(driver: Arc<dyn ProviderDriver>) -> ProviderRegistry {
    registry_of_first_providers(vec![driver])
}

/// A registry holding the table's first providers in its order, one for each of `drivers`, each
/// answered by its driver. Called on a tokio runtime, which the spawner thread is started on.
pub(crate) fn registry_of_first_providers(
    drivers: Vec<Arc<dyn ProviderDriver>>,
) -> ProviderRegistry {
    let table: Vec<ProviderRegistration> = PROVIDERS[..drivers.len()]
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: take_next_driver,
        })
        .collect();
    NEXT_DRIVERS.with_borrow_mut(|next| *next = drivers.into());
    let services = DriverServices {
        spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
        data_folder: PathBuf::from("data"),
    };
    ProviderRegistry::register_from(&table, &services)
}

/// Binds `run_id` in `database` to the table's first provider, as a live runtime binding does.
pub(crate) fn bind_run_to_first_provider(database: &TestDatabase, run_id: RunId) {
    database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, created_at, updated_at)
             VALUES ('binding', ?1, ?2, '1.0.0', '1.0.0', '', '')",
            params![run_id.text().as_str(), PROVIDERS[0].id],
        )
        .expect("the test binds the run to its provider");
}

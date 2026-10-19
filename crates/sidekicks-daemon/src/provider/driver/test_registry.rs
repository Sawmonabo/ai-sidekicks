//! The driver registry other areas' tests build on: the table's first provider answered by a
//! stand-in driver, and a run bound to that provider.

use std::cell::RefCell;
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
    // The driver the next registry this thread builds registers for the table's first provider.
    static NEXT_DRIVER: RefCell<Option<Arc<dyn ProviderDriver>>> = const { RefCell::new(None) };
}

// Hands the registry the driver the test put in the slot.
fn take_next_driver(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
    NEXT_DRIVER
        .with_borrow_mut(Option::take)
        .expect("the registry is built right after its driver is set")
}

/// A registry holding only the table's first provider, answered by `driver`. Called on a tokio
/// runtime, which the spawner thread is started on.
pub(crate) fn registry_of_first_provider(driver: Arc<dyn ProviderDriver>) -> ProviderRegistry {
    NEXT_DRIVER.with_borrow_mut(|next| *next = Some(driver));
    let services = DriverServices {
        spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
        data_folder: PathBuf::from("data"),
    };
    ProviderRegistry::register_from(
        &[ProviderRegistration {
            descriptor: PROVIDERS[0],
            build: take_next_driver,
        }],
        &services,
    )
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

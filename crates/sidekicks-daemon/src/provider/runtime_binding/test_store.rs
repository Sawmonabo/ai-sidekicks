//! The runtime binding store's test store and the bindings tests record through it: a store on a
//! real writer, a binding input of a fresh run, and a session's stored leg.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Map;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::contract::{DriverCliVersionReport, SpawnedVersionBindingCarriers};
use crate::provider::runtime_binding::store::{
    CreateRuntimeBindingInput, RUNTIME_BINDING_STORE_STATEMENT_CAPACITY, RuntimeBindingSpawnConfig,
    RuntimeBindingStore,
};
use crate::session::run::engine::tests::insert_running_run;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The binding store on `database`, through a writer of its own that creates the daemon's schema.
pub(crate) async fn open_store(database: &TestDatabase) -> RuntimeBindingStore {
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let reads = DatabaseReadPool::new(database.path(), RUNTIME_BINDING_STORE_STATEMENT_CAPACITY);
    RuntimeBindingStore::new(Arc::new(reads), Arc::new(writer))
}

/// One spawned build's reading: its version and where it ran.
pub(crate) fn spawned_build(version: &str, path: &str) -> SpawnedVersionBindingCarriers {
    SpawnedVersionBindingCarriers {
        cli_version: DriverCliVersionReport {
            raw_version: version.to_owned(),
            parsed_version: Some(version.to_owned()),
        },
        resolved_executable_path: PathBuf::from(path),
    }
}

/// A binding of a fresh run on the table's first provider, on conversation `conversation-1`.
pub(crate) fn binding_input(
    spawn_config: RuntimeBindingSpawnConfig,
    spawned_version: SpawnedVersionBindingCarriers,
) -> CreateRuntimeBindingInput {
    CreateRuntimeBindingInput {
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        provider_name: ProviderId::new(PROVIDERS[0].id.to_owned())
            .expect("a table id is a provider id"),
        contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a contract version"),
        spawned_version,
        resume_handle: Some("conversation-1".to_owned()),
        spawn_config,
        runtime_metadata: Map::new(),
    }
}

/// Records the leg of a session that ran and now rests: a run of `session_id` whose binding names
/// conversation `resume_handle` on `provider_account_id`'s account.
pub(crate) async fn record_session_leg(
    database: &TestDatabase,
    session_id: SessionId,
    provider_account_id: ProviderAccountId,
    resume_handle: &str,
) {
    let mut input = binding_input(
        RuntimeBindingSpawnConfig {
            provider_account_id: Some(provider_account_id),
            ..RuntimeBindingSpawnConfig::default()
        },
        spawned_build("1.0.0", "/opt/provider/bin"),
    );
    insert_running_run(database, session_id, input.run_id);
    input.resume_handle = Some(resume_handle.to_owned());
    open_store(database)
        .await
        .create(input)
        .await
        .expect("the binding is recorded");
}

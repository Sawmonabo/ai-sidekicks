//! The runtime binding store's test store and the bindings tests record through it: a store on a
//! real writer, a binding input of a fresh run, a run's binding a resume brings back, and a
//! session's stored leg.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Map;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
#[cfg(test)]
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
#[cfg(test)]
use sidekicks_contracts::{
    free_form_string::FilesystemPath,
    machine::settings::ProviderRowValues,
    session::controls::methods::{PermissionLevel, SessionMode},
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use crate::driver::contract::params_and_results::{
    DriverCliVersionReport, SpawnedVersionBindingCarriers,
};
#[cfg(test)]
use crate::driver::session_control::{LiveRunResume, ResumeSessionParams};
use crate::driver::test_registry::first_provider;
#[cfg(test)]
use crate::driver::test_registry::new_agent_id;
#[cfg(test)]
use crate::port::run_host::test_host::RecordingRunEngine;
#[cfg(test)]
use crate::run::posture::compose_execution_posture;
#[cfg(test)]
use crate::runtime_binding::resume::compose_resume_session_params;
#[cfg(test)]
use crate::runtime_binding::store::RuntimeBinding;
use crate::runtime_binding::store::{
    CreateRuntimeBindingInput, RUNTIME_BINDING_STORE_STATEMENT_CAPACITY, RuntimeBindingSpawnConfig,
    RuntimeBindingStore, mint_runtime_binding_id,
};

/// The binding store on `database`, through a writer of its own that creates the daemon's schema.
pub async fn open_store(database: &TestDatabase) -> RuntimeBindingStore {
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let reads = DatabaseReadPool::new(database.path(), RUNTIME_BINDING_STORE_STATEMENT_CAPACITY);
    RuntimeBindingStore::new(Arc::new(reads), Arc::new(writer))
}

/// One spawned build's reading: its version and where it ran.
pub fn spawned_build(version: &str, path: &str) -> SpawnedVersionBindingCarriers {
    SpawnedVersionBindingCarriers {
        cli_version: DriverCliVersionReport {
            raw_version: version.to_owned(),
            parsed_version: Some(version.to_owned()),
        },
        resolved_executable_path: PathBuf::from(path),
    }
}

/// The account a test's bindings run on.
pub fn test_provider_account_id() -> ProviderAccountId {
    ProviderAccountId::new("account-1".to_owned()).expect("the test's account id is valid")
}

/// A spawn record on `provider_account_id`'s account with no other leg.
pub fn spawn_config_on(provider_account_id: ProviderAccountId) -> RuntimeBindingSpawnConfig {
    RuntimeBindingSpawnConfig {
        execution_posture: None,
        callback_tools: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id,
        output_speed: None,
        is_account_pinned: false,
    }
}

/// A binding of a fresh run on the table's first provider, on conversation `conversation-1`.
pub fn binding_input(
    spawn_config: RuntimeBindingSpawnConfig,
    spawned_version: SpawnedVersionBindingCarriers,
) -> CreateRuntimeBindingInput {
    CreateRuntimeBindingInput {
        id: mint_runtime_binding_id(),
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        provider_name: first_provider(),
        contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a contract version"),
        spawned_version,
        resume_handle: Some("conversation-1".to_owned()),
        spawn_config,
        runtime_metadata: Map::new(),
    }
}

/// A binding of `run_id` on `provider_name`, on the test's account, holding the conversation a
/// resume brings back.
pub fn resumable_binding_input(
    run_id: RunId,
    provider_name: ProviderId,
) -> CreateRuntimeBindingInput {
    CreateRuntimeBindingInput {
        run_id,
        provider_name,
        ..binding_input(
            spawn_config_on(test_provider_account_id()),
            spawned_build("1.0.0", "/opt/provider/bin"),
        )
    }
}

/// Records in `bindings` the [`resumable_binding_input`] of `run_id` on `provider_name`, and
/// answers its id.
pub async fn bind_resumable(
    bindings: &RuntimeBindingStore,
    run_id: RunId,
    provider_name: ProviderId,
) -> RuntimeBindingId {
    bindings
        .create(resumable_binding_input(run_id, provider_name))
        .await
        .expect("the run's binding is recorded")
        .id
}

/// The params resuming `binding` for `session_id` with `live_runs`, as a build session's resume on
/// the default model at the read-only level composes them. Panics where the binding names no
/// conversation.
#[cfg(test)]
pub(crate) fn compose_test_resume_params(
    session_id: SessionId,
    binding: &RuntimeBinding,
    live_runs: Vec<LiveRunResume>,
) -> ResumeSessionParams {
    compose_resume_session_params(
        session_id,
        new_agent_id(),
        binding,
        mint_runtime_binding_id(),
        FreeFormText::new("gpt-5".to_owned()).expect("a model"),
        None,
        SessionMode::Build,
        compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        ),
        Vec::new(),
        ProviderRowValues::default(),
        None,
        Vec::new(),
        live_runs,
    )
    .expect("the binding resumes")
}

/// Records the leg of a session that ran and now rests: a binding of a fresh run naming
/// conversation `resume_handle` on `provider_account_id`'s account, which `host` then answers as
/// `session_id`'s stored leg.
#[cfg(test)]
pub(crate) async fn record_session_leg(
    database: &TestDatabase,
    host: &RecordingRunEngine,
    session_id: SessionId,
    provider_account_id: ProviderAccountId,
    resume_handle: &str,
) {
    let mut input = binding_input(
        spawn_config_on(provider_account_id),
        spawned_build("1.0.0", "/opt/provider/bin"),
    );
    input.resume_handle = Some(resume_handle.to_owned());
    let leg = open_store(database)
        .await
        .create(input)
        .await
        .expect("the binding is recorded");
    host.set_session_leg(session_id, leg);
}

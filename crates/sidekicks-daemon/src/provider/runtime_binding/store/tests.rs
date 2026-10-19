//! The binding store's tests, on a real database and writer.

use std::error::Error;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use rstest::rstest;
use serde_json::Map;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{
    CreateRuntimeBindingInput, RUNTIME_BINDING_STORE_STATEMENT_CAPACITY, RuntimeBinding,
    RuntimeBindingPatch, RuntimeBindingRelaunch, RuntimeBindingSpawnConfig, RuntimeBindingStore,
    read_binding,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::contract::{
    DriverCliVersionReport, SessionToolServer, SpawnedVersionBindingCarriers, SubagentDefinition,
    SubagentPolicy,
};
use crate::provider::left_conversations::LeftConversation;
use crate::uuid_v7::mint_uuid_v7;

async fn open_store(database: &TestDatabase) -> RuntimeBindingStore {
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let reads = DatabaseReadPool::new(database.path(), RUNTIME_BINDING_STORE_STATEMENT_CAPACITY);
    RuntimeBindingStore::new(Arc::new(reads), Arc::new(writer))
}

fn token(text: &str) -> ProviderToken {
    FreeFormText::new(text.to_owned()).expect("the test's token is valid text")
}

// One spawned build's reading: its version and where it ran.
fn spawned_build(version: &str, path: &str) -> SpawnedVersionBindingCarriers {
    SpawnedVersionBindingCarriers {
        cli_version: DriverCliVersionReport {
            raw_version: version.to_owned(),
            parsed_version: Some(version.to_owned()),
        },
        resolved_executable_path: PathBuf::from(path),
    }
}

// A binding of a fresh run on the table's first provider, on conversation `conversation-1`.
fn binding_input(
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

async fn create(
    store: &RuntimeBindingStore,
    spawn_config: RuntimeBindingSpawnConfig,
) -> RuntimeBinding {
    store
        .create(binding_input(
            spawn_config,
            spawned_build("2.0.0", "/opt/provider/2.0.0/bin"),
        ))
        .await
        .expect("the binding is recorded")
}

#[tokio::test]
async fn a_relaunch_records_its_own_build_and_keeps_the_predecessors_legs() {
    let database = TestDatabase::new();
    let store = open_store(&database).await;
    let predecessor = create(
        &store,
        RuntimeBindingSpawnConfig {
            output_speed: Some(token("fast")),
            ..RuntimeBindingSpawnConfig::default()
        },
    )
    .await;
    let relaunched_id =
        RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a UUID is a binding id");
    let new_build = spawned_build("2.1.0", "/opt/provider/2.1.0/bin");

    store
        .record_relaunch(RuntimeBindingRelaunch {
            predecessor_id: predecessor.id.clone(),
            binding_id: relaunched_id.clone(),
            resume_handle: "conversation-2".to_owned(),
            spawned_version: new_build.clone(),
            left_conversations: Vec::new(),
        })
        .await
        .expect("the relaunch is recorded");

    let relaunched = read_binding(&database.reader(), &relaunched_id)
        .expect("the relaunched binding reads")
        .expect("the relaunched binding has a row");
    assert_eq!(relaunched.cli_version, new_build.cli_version);
    assert_eq!(
        relaunched.resolved_executable_path,
        "/opt/provider/2.1.0/bin"
    );
    assert_eq!(relaunched.spawn_config, predecessor.spawn_config);
    assert_eq!(relaunched.run_id, predecessor.run_id);
    assert_eq!(relaunched.resume_handle.as_deref(), Some("conversation-2"));
}

#[tokio::test]
async fn an_update_records_the_left_conversation_in_its_own_write() {
    let database = TestDatabase::new();
    let store = open_store(&database).await;
    let binding = create(&store, RuntimeBindingSpawnConfig::default()).await;
    let left = LeftConversation {
        session_id: test_session_id(),
        provider_account_id: None,
        conversation_id: "conversation-1".to_owned(),
    };

    let updated = store
        .update(
            &binding.id,
            RuntimeBindingPatch {
                resume_handle: Some("conversation-2".to_owned()),
                ..RuntimeBindingPatch::default()
            },
            vec![left],
        )
        .await
        .expect("the update is written")
        .expect("the binding has a row");

    assert_eq!(updated.resume_handle.as_deref(), Some("conversation-2"));
    let recorded: (String, String) = database
        .reader()
        .query_row(
            "SELECT provider_name, left_at FROM left_conversations WHERE conversation_id = ?",
            ["conversation-1"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the left conversation is recorded");
    assert_eq!(
        recorded,
        (
            binding.provider_name.as_str().to_owned(),
            updated.updated_at
        )
    );
}

// Text a stored value holds that no read's error may repeat, put where a case says `{marker}`.
const STORED_MARKER: &str = "stored-marker-text";

// Fails when a stored column that does not read passes, or when the error, through every cause,
// repeats what the column holds, which a parser's message quotes.
#[rstest]
#[case::a_member_no_leg_names("spawn_config = json_set(spawn_config, '$.{marker}', 1)")]
#[case::a_leg_of_the_wrong_type(
    "spawn_config = json_set(spawn_config, '$.toolServers', '{marker}')"
)]
#[case::recovery_data_not_an_object("runtime_metadata = json_quote('{marker}')")]
#[tokio::test]
async fn a_stored_column_that_does_not_read_fails_the_read_without_its_value(#[case] change: &str) {
    let database = TestDatabase::new();
    let store = open_store(&database).await;
    let binding = create(&store, RuntimeBindingSpawnConfig::default()).await;
    let connection = database.reader();
    connection
        .execute(
            &format!(
                "UPDATE runtime_bindings SET {} WHERE id = ?",
                change.replace("{marker}", STORED_MARKER)
            ),
            [binding.id.as_str()],
        )
        .expect("the test damages the stored row");

    let read = read_binding(&connection, &binding.id);

    let error = read.expect_err("the damaged row fails the read");
    assert!(matches!(
        error,
        rusqlite::Error::FromSqlConversionFailure(..)
    ));
    let mut message = String::new();
    let mut cause: Option<&(dyn Error + 'static)> = Some(&error);
    while let Some(current) = cause {
        writeln!(message, "{current} / {current:?}").expect("a string takes any text");
        cause = current.source();
    }
    assert!(message.contains(binding.id.as_str()), "{message}");
    assert!(!message.contains(STORED_MARKER), "{message}");
}

#[tokio::test]
async fn a_binding_with_helpers_and_tool_servers_reads_back_as_recorded() {
    let database = TestDatabase::new();
    let store = open_store(&database).await;
    let helper = SubagentDefinition {
        name: "reviewer".to_owned(),
        prompt: "Review the change.".to_owned(),
        description: "Reviews a finished change.".to_owned(),
        model: Some(token("model-a")),
        tools: Some(vec!["Read".to_owned()]),
        effort: Some(token("high")),
        max_turns: Some(SafeInt::new(5).expect("5 is a safe integer")),
    };
    let created = create(
        &store,
        RuntimeBindingSpawnConfig {
            subagent_policy: Some(SubagentPolicy::Enabled {
                helpers_at_once: Some(SafeInt::new(2).expect("2 is a safe integer")),
                definitions: vec![helper],
            }),
            tool_servers: Some(vec![SessionToolServer {
                server_name: FreeFormText::new("docs".to_owned()).expect("a server name"),
                is_enabled: true,
            }]),
            provider_account_id: Some(
                ProviderAccountId::new("account-1".to_owned()).expect("an account id"),
            ),
            ..RuntimeBindingSpawnConfig::default()
        },
    )
    .await;

    let read = read_binding(&database.reader(), &created.id)
        .expect("the binding reads")
        .expect("the binding has a row");
    assert_eq!(read, created);
}

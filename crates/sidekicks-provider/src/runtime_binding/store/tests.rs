//! The binding store's tests, on a real database and writer.

use std::error::Error;
use std::fmt::Write as _;

use rstest::rstest;
use serde_json::Map;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};

use super::{
    RuntimeBinding, RuntimeBindingPatch, RuntimeBindingRelaunch, RuntimeBindingSpawnConfig,
    RuntimeBindingStore, mint_runtime_binding_id, read_binding,
};
use crate::driver::PROVIDERS;
use crate::driver::registry::test_token;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::SessionToolServer;
use crate::left_conversations::LeftConversation;
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use crate::runtime_binding::writer::RuntimeBindingWriter;

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
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let predecessor = create(
        &store,
        RuntimeBindingSpawnConfig {
            output_speed: Some(test_token("fast")),
            ..spawn_config_on(test_provider_account_id())
        },
    )
    .await;
    let relaunched_id = mint_runtime_binding_id();
    let new_build = spawned_build("2.1.0", "/opt/provider/2.1.0/bin");

    store
        .record_relaunch(
            RuntimeBindingRelaunch {
                predecessor_id: predecessor.id.clone(),
                binding_id: relaunched_id.clone(),
                resume_handle: "conversation-2".to_owned(),
                spawned_version: new_build.clone(),
                left_conversations: Vec::new(),
            },
            Vec::new(),
        )
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

// An update that leaves a conversation records it in its own write, at the update's time with the
// leg's recovery data, over the row an undo wrote when it moved the session onto that fork.
// Killed by a left row written insert-or-ignore (the undo's time and recovery data stay).
#[tokio::test]
async fn an_update_records_the_left_conversation_in_its_own_write() {
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let binding = create(&store, spawn_config_on(test_provider_account_id())).await;
    let session_id = test_session_id();
    let mut leg_data = Map::new();
    leg_data.insert("leg".to_owned(), "fork".into());
    let left = LeftConversation {
        session_id,
        provider_account_id: test_provider_account_id(),
        conversation_id: "conversation-1".to_owned(),
        runtime_metadata: leg_data.clone(),
    };
    database
        .reader()
        .execute(
            "INSERT INTO left_conversations (session_id, provider_name, provider_account_id,
               conversation_id, left_at, runtime_metadata)
             VALUES (?, ?, ?, 'conversation-1', '2000-01-01T00:00:00.000Z',
               '{\"leg\":\"source\"}')",
            [
                session_id.text().as_str(),
                binding.provider_name.as_str(),
                test_provider_account_id().as_str(),
            ],
        )
        .expect("the undo's row for the fork is written");

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
    let recorded: (String, String, String) = database
        .reader()
        .query_row(
            "SELECT provider_name, left_at, runtime_metadata FROM left_conversations
              WHERE conversation_id = ?",
            ["conversation-1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the left conversation is recorded");
    assert_eq!(
        recorded,
        (
            binding.provider_name.as_str().to_owned(),
            updated.updated_at,
            serde_json::Value::Object(leg_data).to_string()
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
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let binding = create(&store, spawn_config_on(test_provider_account_id())).await;
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
async fn a_binding_with_tool_servers_reads_back_as_recorded() {
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let created = create(
        &store,
        RuntimeBindingSpawnConfig {
            tool_servers: Some(vec![SessionToolServer {
                binding: McpServerBindingRef::User {
                    provider: ProviderId::new(PROVIDERS[0].id.to_owned())
                        .expect("a table id is a provider id"),
                    server_name: FreeFormText::new("docs".to_owned()).expect("a server name"),
                },
                is_enabled: true,
            }]),
            ..spawn_config_on(test_provider_account_id())
        },
    )
    .await;

    let read = read_binding(&database.reader(), &created.id)
        .expect("the binding reads")
        .expect("the binding has a row");
    assert_eq!(read, created);
}

// Fails when the set is stored as a quoted string, when the run's oldest resumable row is written,
// or when the write replaces the whole spawn record or touches another row.
#[tokio::test]
async fn a_tool_server_set_lands_as_a_list_on_the_runs_newest_resumable_row() {
    let database = TestDatabase::new(schema_parts());
    let store = open_store(&database).await;
    let older = create(
        &store,
        RuntimeBindingSpawnConfig {
            output_speed: Some(test_token("fast")),
            ..spawn_config_on(test_provider_account_id())
        },
    )
    .await;
    let newer_id = mint_runtime_binding_id();
    store
        .record_relaunch(
            RuntimeBindingRelaunch {
                predecessor_id: older.id.clone(),
                binding_id: newer_id.clone(),
                resume_handle: "conversation-2".to_owned(),
                spawned_version: spawned_build("2.1.0", "/opt/provider/2.1.0/bin"),
                left_conversations: Vec::new(),
            },
            Vec::new(),
        )
        .await
        .expect("the relaunch is recorded");
    let connection = database.reader();
    // Both rows can share one millisecond, so the older one is put plainly first.
    connection
        .execute(
            "UPDATE runtime_bindings SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
            [older.id.as_str()],
        )
        .expect("the test orders the rows");
    let read_row = |id: &str| -> (String, String) {
        connection
            .query_row(
                "SELECT spawn_config, updated_at FROM runtime_bindings WHERE id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the row reads")
    };
    let older_before = read_row(older.id.as_str());
    let tool_servers = vec![
        SessionToolServer {
            binding: McpServerBindingRef::User {
                provider: older.provider_name.clone(),
                server_name: FreeFormText::new("docs".to_owned()).expect("a server name"),
            },
            is_enabled: true,
        },
        SessionToolServer {
            binding: McpServerBindingRef::User {
                provider: older.provider_name.clone(),
                server_name: FreeFormText::new("tickets".to_owned()).expect("a server name"),
            },
            is_enabled: false,
        },
    ];

    RuntimeBindingWriter::replace_tool_servers(&store, older.run_id, tool_servers.clone())
        .await
        .expect("the set is written");

    let stored_type: String = connection
        .query_row(
            "SELECT json_type(spawn_config, '$.toolServers') FROM runtime_bindings WHERE id = ?",
            [newer_id.as_str()],
            |row| row.get(0),
        )
        .expect("the newer row reads");
    assert_eq!(stored_type, "array");
    let newer = read_binding(&connection, &newer_id)
        .expect("the newer binding reads")
        .expect("the newer binding has a row");
    assert_eq!(newer.spawn_config.tool_servers, Some(tool_servers));
    assert_eq!(newer.spawn_config.output_speed, Some(test_token("fast")));
    assert_eq!(newer.resolved_executable_path, "/opt/provider/2.1.0/bin");
    assert_eq!(read_row(older.id.as_str()), older_before);
}

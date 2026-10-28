//! The binding store: each MCP server binding's governance row, keyed by the binding's whole
//! identity, written when a binding is first observed.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use sidekicks_contracts::mcp::server::{McpBindingScope, McpServerBindingRef};
use sidekicks_contracts::place::WslPlace;
use sidekicks_ipc::stream::latest_value::{KeyedLatestValueFeed, KeyedLatestValueOutlet};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// A binding's whole identity as the store keys it: provider, scope, the scope's reference and the
/// distribution a project root is in (each `''` where the scope has none), and the server's name.
/// One path in two distributions is two keys, and same-named servers in two scopes stay two keys.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct McpBindingKey {
    /// The provider's id, as written.
    pub(crate) provider: String,
    /// The binding's scope.
    pub(crate) scope: McpBindingScope,
    /// The project root, the plugin's name or the provider account's id; `''` for `user` and
    /// `managed`.
    pub(crate) scope_ref: String,
    /// The WSL 2 distribution a `project` or `local` root is in; `''` elsewhere.
    pub(crate) scope_place: String,
    /// The server's name.
    pub(crate) server_name: String,
}

impl McpBindingKey {
    /// The key of `binding`.
    pub(crate) fn of(binding: &McpServerBindingRef) -> Self {
        let place_text = |place: Option<&WslPlace>| {
            place.map_or_else(String::new, |place| place.distro.as_str().to_owned())
        };
        let (provider, scope, scope_ref, scope_place, server_name) = match binding {
            McpServerBindingRef::User {
                provider,
                server_name,
            } => (
                provider,
                McpBindingScope::User,
                String::new(),
                String::new(),
                server_name,
            ),
            McpServerBindingRef::Project {
                provider,
                scope_ref,
                place,
                server_name,
            } => (
                provider,
                McpBindingScope::Project,
                scope_ref.as_str().to_owned(),
                place_text(place.as_ref()),
                server_name,
            ),
            McpServerBindingRef::Local {
                provider,
                scope_ref,
                place,
                server_name,
            } => (
                provider,
                McpBindingScope::Local,
                scope_ref.as_str().to_owned(),
                place_text(place.as_ref()),
                server_name,
            ),
            McpServerBindingRef::Plugin {
                provider,
                scope_ref,
                server_name,
            } => (
                provider,
                McpBindingScope::Plugin,
                scope_ref.as_str().to_owned(),
                String::new(),
                server_name,
            ),
            McpServerBindingRef::Connector {
                provider,
                scope_ref,
                server_name,
            } => (
                provider,
                McpBindingScope::Connector,
                scope_ref.as_str().to_owned(),
                String::new(),
                server_name,
            ),
            McpServerBindingRef::Managed {
                provider,
                server_name,
            } => (
                provider,
                McpBindingScope::Managed,
                String::new(),
                String::new(),
                server_name,
            ),
        };
        Self {
            provider: provider.as_str().to_owned(),
            scope,
            scope_ref,
            scope_place,
            server_name: server_name.as_str().to_owned(),
        }
    }
}

/// Why a binding's first observation was not recorded.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the first-observation drain records each binding through it"
    )
)]
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpBindingStoreError {
    /// The row's write failed.
    #[error("the MCP binding's first observation could not be recorded")]
    Write(#[source] WriteError),
}

// A row already present is left as it is, its switch and baseline kept.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the first-observation drain records each binding through it"
    )
)]
static RECORD_FIRST_OBSERVATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO mcp_server_bindings
  (provider, scope, scope_ref, scope_place, server_name, first_observed_at, updated_at)
  VALUES (@provider, @scope, @scope_ref, @scope_place, @server_name, {DATABASE_NOW_SQL},
    {DATABASE_NOW_SQL})
  ON CONFLICT DO NOTHING"
    )
});

/// Writes the bindings' governance rows.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the first-observation drain records each binding through it"
    )
)]
pub(crate) struct McpBindingStore {
    /// The writer every row goes through.
    writer: Arc<DatabaseWriter>,
}

impl McpBindingStore {
    /// A store writing through `writer`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the first-observation drain records each binding through it"
        )
    )]
    pub(crate) fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self { writer }
    }

    /// Records `binding`'s row the first time it is observed; a binding that already has a row
    /// keeps it untouched. Fails with [`McpBindingStoreError::Write`] as the write fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the first-observation drain records each binding through it"
        )
    )]
    pub(crate) async fn record_first_observation(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<(), McpBindingStoreError> {
        let key = McpBindingKey::of(binding);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_FIRST_OBSERVATION_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@provider", &key.provider),
                    text_binding("@scope", <&'static str>::from(key.scope)),
                    text_binding("@scope_ref", &key.scope_ref),
                    text_binding("@scope_place", &key.scope_place),
                    text_binding("@server_name", &key.server_name),
                ]),
                expected_row_count: None,
            }])
            .await
            .map_err(McpBindingStoreError::Write)?;
        Ok(())
    }
}

/// Opens the drain that records each binding the status core observes for the first time in this
/// process: answers the outlet the core is built with and the drain's run, which writes each
/// binding's row through `store` and ends once the core, holding the outlet, is dropped. A
/// binding whose write fails is logged and left without a row until the next start observes it.
#[expect(
    dead_code,
    reason = "the daemon's start builds the status core over it and spawns the run"
)]
pub(crate) async fn open_first_observation_drain(
    store: McpBindingStore,
) -> (
    KeyedLatestValueOutlet<McpBindingKey, McpServerBindingRef>,
    impl Future<Output = ()> + Send,
) {
    let mut outlet = None;
    let feed = KeyedLatestValueFeed::open(|source| {
        outlet = Some(source);
        async { Ok(|| {}) }
    })
    .await;
    let (Some(outlet), Ok(mut feed)) = (outlet, feed) else {
        unreachable!("the drain's follow takes its outlet and never fails");
    };
    let run = async move {
        // The outlet never fails, so the feed ends only with `None` once the core is gone.
        while let Ok(Some(binding)) = feed.recv().await {
            if let Err(error) = store.record_first_observation(&binding).await {
                tracing::error!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP binding's first observation was not recorded"
                );
            }
        }
    };
    (outlet, run)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::McpBindingStore;
    use crate::schema::schema_parts;

    // A second observation of a recorded binding adds no row and keeps the switch set on it.
    #[tokio::test]
    async fn a_binding_recorded_again_keeps_its_one_row_and_its_switch() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let store = McpBindingStore::new(Arc::new(writer));
        let binding = McpServerBindingRef::User {
            provider: ProviderId::new("claude".to_owned()).expect("a provider id"),
            server_name: McpServerName::new("github".to_owned()).expect("a server name"),
        };

        store
            .record_first_observation(&binding)
            .await
            .expect("the first observation is recorded");
        database
            .reader()
            .execute("UPDATE mcp_server_bindings SET enabled_override = 0", [])
            .expect("the test switches the binding off");
        store
            .record_first_observation(&binding)
            .await
            .expect("the second observation is recorded");

        let rows: Vec<Option<i64>> = database
            .reader()
            .prepare("SELECT enabled_override FROM mcp_server_bindings")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()
            })
            .expect("the test reads the bindings");
        assert_eq!(rows, vec![Some(0)]);
    }
}

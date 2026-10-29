//! The binding store: each MCP server binding's governance row, keyed by the binding's whole
//! identity, written when a binding is first observed and read with its switch and tool overrides.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::inventory::McpToolOverride;
use sidekicks_contracts::mcp::server::{
    McpBindingScope, McpServerBindingId, McpServerBindingRef, McpServerName, McpToolName,
};
use sidekicks_contracts::place::{DistroName, PlacedPath, WslPlace};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::stream::latest_value::{KeyedLatestValueFeed, KeyedLatestValueOutlet};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// The distinct statements the binding store keeps prepared on each read connection.
pub const MCP_BINDING_STORE_STATEMENT_CAPACITY: usize = 3;

/// The scopes of a server the provider brings itself, a connector and an organization's server,
/// whose per-project switch the daemon keeps in `mcp_project_server_switches`.
pub(crate) const PROJECT_SWITCH_SCOPES: [McpBindingScope; 2] =
    [McpBindingScope::Connector, McpBindingScope::Managed];

/// A binding's whole identity as the store keys it: provider, scope, the scope's reference and the
/// distribution a project root is in (each `''` where the scope has none), and the server's name.
/// One path in two distributions is two keys, and same-named servers in two scopes stay two keys.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct McpBindingKey {
    /// The provider's id.
    pub(crate) provider: ProviderId,
    /// The binding's scope.
    pub(crate) scope: McpBindingScope,
    /// The project root, the plugin's name or the provider account's id; `''` for `user` and
    /// `managed`.
    pub(crate) scope_ref: String,
    /// The WSL 2 distribution a `project` or `local` root is in; `''` elsewhere.
    pub(crate) scope_place: String,
    /// The server's name.
    pub(crate) server_name: McpServerName,
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
            provider: provider.clone(),
            scope,
            scope_ref,
            scope_place,
            server_name: server_name.clone(),
        }
    }

    /// The binding's id on the wire: the lowercase hex of a `blake3` hash over the key's parts,
    /// each after its length so no two keys share one, holding no path and the same in every run.
    pub(crate) fn server_binding_id(&self) -> McpServerBindingId {
        let mut hasher = blake3::Hasher::new();
        for part in [
            self.provider.as_str(),
            <&'static str>::from(self.scope),
            &self.scope_ref,
            &self.scope_place,
            self.server_name.as_str(),
        ] {
            hasher.update(&(part.len() as u64).to_le_bytes());
            hasher.update(part.as_bytes());
        }
        McpServerBindingId::new(hasher.finalize().to_hex().to_string())
            .expect("a blake3 hash's hex is 64 lowercase hex digits")
    }
}

/// Why the binding store did not record a binding's first observation or answer a read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpBindingStoreError {
    /// The row's write failed.
    #[error("the MCP binding's first observation could not be recorded")]
    Write(#[source] WriteError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the MCP binding rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// What the store keeps for one binding: the daemon's switch, the person's tool overrides and the
/// projects the daemon's per-project switch keeps it out of.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct McpStoredBinding {
    /// The daemon's switch over the binding; `None` where the provider's own value stands.
    pub(crate) enabled_override: Option<bool>,
    /// The tool overrides, in tool-name order.
    pub(crate) tool_overrides: Vec<McpToolOverride>,
    /// The project roots a server the provider brings itself is switched off for, in root order.
    pub(crate) switched_off_in: Vec<PlacedPath>,
}

/// What the store keeps for one provider's bindings.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct McpStoredBindings {
    /// Each binding with a row, by its key.
    pub(crate) bindings: HashMap<McpBindingKey, McpStoredBinding>,
    /// Each `local` binding with a row, in the store's order.
    pub(crate) local_bindings: Vec<McpServerBindingRef>,
}

static PROVIDER_BINDINGS_SQL: &str =
    "SELECT scope, scope_ref, scope_place, server_name, enabled_override
  FROM mcp_server_bindings
  WHERE provider = @provider
  ORDER BY scope, scope_ref, scope_place, server_name";

static PROVIDER_TOOL_OVERRIDES_SQL: &str =
    "SELECT scope, scope_ref, scope_place, server_name, tool_name, enabled, approval_mode,
    idempotency_class
  FROM mcp_tool_overrides
  WHERE provider = @provider
  ORDER BY scope, scope_ref, scope_place, server_name, tool_name";

static PROVIDER_PROJECT_SWITCHES_SQL: &str =
    "SELECT scope, scope_ref, scope_place, server_name, project_root, project_place
  FROM mcp_project_server_switches
  WHERE provider = @provider
  ORDER BY scope, scope_ref, scope_place, server_name, project_root, project_place";

// A row already present is left as it is, its switch and baseline kept.
static RECORD_FIRST_OBSERVATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO mcp_server_bindings
  (provider, scope, scope_ref, scope_place, server_name, first_observed_at, updated_at)
  VALUES (@provider, @scope, @scope_ref, @scope_place, @server_name, {DATABASE_NOW_SQL},
    {DATABASE_NOW_SQL})
  ON CONFLICT DO NOTHING"
    )
});

/// Writes the bindings' governance rows and reads them back.
#[derive(Clone)]
pub struct McpBindingStore {
    /// The writer every row goes through.
    writer: Arc<DatabaseWriter>,
    /// The read pool every read borrows a connection from.
    reads: Arc<DatabaseReadPool>,
}

impl McpBindingStore {
    /// A store writing through `writer` and reading on `reads`.
    pub fn new(writer: Arc<DatabaseWriter>, reads: Arc<DatabaseReadPool>) -> Self {
        Self { writer, reads }
    }

    /// Reads every row `provider`'s bindings hold: each binding's switch, its tool overrides, the
    /// projects it is switched off for and the `local` bindings, in one short read. Fails with
    /// [`McpBindingStoreError::Database`] or [`McpBindingStoreError::Pool`] as the read fails.
    pub(crate) async fn read_provider_bindings(
        &self,
        provider: &ProviderId,
    ) -> Result<McpStoredBindings, McpBindingStoreError> {
        let provider = provider.clone();
        self.reads
            .read(ReadLength::Short, move |connection| {
                let mut stored = McpStoredBindings::default();
                let mut statement = connection.prepare_cached(PROVIDER_BINDINGS_SQL)?;
                let mut rows = statement.query(named_params! { "@provider": provider.as_str() })?;
                while let Some(row) = rows.next()? {
                    let key = read_key(&provider, row)?;
                    if key.scope == McpBindingScope::Local {
                        stored.local_bindings.push(McpServerBindingRef::Local {
                            provider: provider.clone(),
                            scope_ref: text_column(row, 1, FilesystemPath::new)?,
                            place: text_column(row, 2, read_place)?,
                            server_name: key.server_name.clone(),
                        });
                    }
                    let binding = McpStoredBinding {
                        enabled_override: row.get(4)?,
                        ..McpStoredBinding::default()
                    };
                    stored.bindings.insert(key, binding);
                }
                let mut statement = connection.prepare_cached(PROVIDER_TOOL_OVERRIDES_SQL)?;
                let mut rows = statement.query(named_params! { "@provider": provider.as_str() })?;
                while let Some(row) = rows.next()? {
                    let tool_override = McpToolOverride {
                        tool_name: text_column(row, 4, McpToolName::new)?,
                        enabled: row.get(5)?,
                        approval_mode: optional_text_column(row, 6, closed_word)?,
                        idempotency_class: optional_text_column(row, 7, closed_word)?,
                    };
                    // Every override row has its binding's row, which its foreign key holds.
                    stored
                        .bindings
                        .entry(read_key(&provider, row)?)
                        .or_default()
                        .tool_overrides
                        .push(tool_override);
                }
                let mut statement = connection.prepare_cached(PROVIDER_PROJECT_SWITCHES_SQL)?;
                let mut rows = statement.query(named_params! { "@provider": provider.as_str() })?;
                while let Some(row) = rows.next()? {
                    let project_root = PlacedPath {
                        path: text_column(row, 4, FilesystemPath::new)?,
                        place: text_column(row, 5, read_place)?,
                    };
                    // Every switch row has its binding's row, which its foreign key holds.
                    stored
                        .bindings
                        .entry(read_key(&provider, row)?)
                        .or_default()
                        .switched_off_in
                        .push(project_root);
                }
                Ok(stored)
            })
            .await
    }

    /// Records `binding`'s row the first time it is observed; a binding that already has a row
    /// keeps it untouched. Fails with [`McpBindingStoreError::Write`] as the write fails.
    pub(crate) async fn record_first_observation(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<(), McpBindingStoreError> {
        let key = McpBindingKey::of(binding);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_FIRST_OBSERVATION_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@provider", key.provider.as_str()),
                    text_binding("@scope", <&'static str>::from(key.scope)),
                    text_binding("@scope_ref", &key.scope_ref),
                    text_binding("@scope_place", &key.scope_place),
                    text_binding("@server_name", key.server_name.as_str()),
                ]),
                expected_row_count: None,
            }])
            .await
            .map_err(McpBindingStoreError::Write)?;
        Ok(())
    }
}

// The key the first four columns of a binding's or an override's row name.
fn read_key(provider: &ProviderId, row: &rusqlite::Row<'_>) -> rusqlite::Result<McpBindingKey> {
    Ok(McpBindingKey {
        provider: provider.clone(),
        scope: text_column(row, 0, closed_word)?,
        scope_ref: row.get(1)?,
        scope_place: row.get(2)?,
        server_name: text_column(row, 3, McpServerName::new)?,
    })
}

/// A stored distribution that is not a WSL distribution's name.
#[derive(Debug, thiserror::Error)]
#[error("a stored distribution is not a WSL distribution's name")]
struct StoredDistroNameFault;

// A stored distribution, `''` for a root outside one.
fn read_place(text: String) -> Result<Option<WslPlace>, StoredDistroNameFault> {
    if text.is_empty() {
        return Ok(None);
    }
    DistroName::new(text)
        .map(|distro| Some(WslPlace { distro }))
        .ok_or(StoredDistroNameFault)
}

/// Opens the drain that records each binding the status tracker hands it: answers the outlet the
/// tracker is built with and the drain's run, which writes each binding's row through `store` once
/// in this process and ends once the tracker, holding the outlet, is dropped. A binding whose
/// write fails is logged and not marked recorded, so its next reading, a leg's or the probe's,
/// tries again.
pub async fn open_first_observation_drain(
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
    let mut feed = feed.expect("the drain's follow never fails");
    let outlet = outlet.expect("the drain's follow takes its outlet");
    let run = async move {
        let mut recorded = HashSet::new();
        loop {
            let binding = match feed.recv().await {
                Ok(Some(binding)) => binding,
                // The tracker, holding the outlet, is gone.
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "the MCP first-observation drain stopped"
                    );
                    break;
                }
            };
            let key = McpBindingKey::of(&binding);
            if recorded.contains(&key) {
                continue;
            }
            match store.record_first_observation(&binding).await {
                Ok(()) => {
                    recorded.insert(key);
                }
                Err(error) => tracing::error!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an MCP binding's first observation was not recorded; its next reading tries \
                     again"
                ),
            }
        }
    };
    (outlet, run)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_contracts::mcp::server::McpServerStatus::Connected;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::mcp_server::status::{
        McpServerReading, McpServerStatusEmission,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use tokio::task::JoinHandle;

    use super::{
        MCP_BINDING_STORE_STATEMENT_CAPACITY, McpBindingStore, open_first_observation_drain,
    };
    use crate::schema::schema_parts;
    use crate::status::McpServerStatusTracker;
    use crate::status::notices::McpNoticeBoard;

    /// How long a test waits for the writer's next commit.
    const COMMIT_BOUND: Duration = Duration::from_secs(10);

    fn user_binding(server_name: &str) -> McpServerBindingRef {
        McpServerBindingRef::User {
            provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            server_name: McpServerName::new(server_name.to_owned()).expect("a server name"),
        }
    }

    /// A status tracker handing its bindings to a running drain over a fresh database, with the
    /// writer the drain records through.
    async fn tracker_over_a_drain() -> (
        TestDatabase,
        Arc<DatabaseWriter>,
        McpServerStatusTracker,
        JoinHandle<()>,
    ) {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let (outlet, run) = open_first_observation_drain(McpBindingStore::new(
            Arc::clone(&writer),
            reads(&database),
        ))
        .await;
        let tracker = McpServerStatusTracker::new(Arc::new(McpNoticeBoard::default()), outlet);
        (database, writer, tracker, tokio::spawn(run))
    }

    fn reads(database: &TestDatabase) -> Arc<DatabaseReadPool> {
        Arc::new(DatabaseReadPool::new(
            database.path(),
            MCP_BINDING_STORE_STATEMENT_CAPACITY,
        ))
    }

    /// The recorded bindings' server names, in name order.
    fn recorded_server_names(database: &TestDatabase) -> Vec<String> {
        database
            .reader()
            .prepare("SELECT server_name FROM mcp_server_bindings ORDER BY server_name")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()
            })
            .expect("the test reads the bindings")
    }

    /// A binding only the machine probe reads, with no session reporting it, gets its row. Killed
    /// by the probe's hand-off to the drain dropped.
    #[tokio::test]
    async fn a_binding_only_the_probe_reads_gets_its_row() {
        let (database, _writer, tracker, run) = tracker_over_a_drain().await;

        tracker.record_probe(&user_binding("docs"), Connected, None, Vec::new());
        // The drain ends once the tracker, holding its outlet, is gone and what waits is written.
        drop(tracker);
        run.await.expect("the drain's run ends");

        assert_eq!(recorded_server_names(&database), vec!["docs"]);
    }

    /// A first observation whose write fails is written at the binding's next reading: the
    /// probe's, a leg's repeat of the status it already reported, or a leg's repeated switch-off.
    /// Killed by the drain marking the binding recorded before its write, by a leg handing the
    /// binding over only on its first report of it, and by a leg handing it over only on an
    /// observed status.
    #[tokio::test]
    async fn a_failed_first_observation_is_recorded_at_the_next_observation() {
        let (database, writer, tracker, run) = tracker_over_a_drain().await;
        let tracker = Arc::new(tracker);
        database
            .reader()
            .execute_batch(
                "CREATE TRIGGER fail_writes BEFORE INSERT ON mcp_server_bindings
                   WHEN NEW.server_name IN ('docs', 'mail', 'news')
                   BEGIN SELECT RAISE(ABORT, 'the test fails this write'); END",
            )
            .expect("the test fails the bindings' writes");
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let sink = tracker.open_leg(
            session_id,
            RuntimeBindingId::new("leg-a".to_owned()).expect("a binding id"),
        );
        let leg_reports_docs = || {
            sink.observe(
                &user_binding("docs"),
                McpServerStatusEmission::new(
                    McpServerName::new("docs".to_owned()).expect("a server name"),
                    McpServerReading::Observed(Connected),
                    None,
                ),
            );
        };
        // The leg's first report of `news` is a switch-off.
        let leg_switches_off_news = || {
            sink.observe(
                &user_binding("news"),
                McpServerStatusEmission::new(
                    McpServerName::new("news".to_owned()).expect("a server name"),
                    McpServerReading::SwitchedOff,
                    None,
                ),
            );
        };
        let mut commits = writer.follow_commits();

        leg_reports_docs();
        leg_switches_off_news();
        tracker.record_probe(&user_binding("mail"), Connected, None, Vec::new());
        // The drain writes one binding at a time in order, and a failed write commits nothing, so
        // the next commit is this binding's, after the failed ones.
        tracker.record_probe(&user_binding("github"), Connected, None, Vec::new());
        tokio::time::timeout(COMMIT_BOUND, commits.changed())
            .await
            .expect("the drain writes the third binding in time")
            .expect("the writer is open");
        assert_eq!(recorded_server_names(&database), vec!["github"]);
        database
            .reader()
            .execute_batch("DROP TRIGGER fail_writes")
            .expect("the test lets the bindings' writes through");
        // The leg's same status again: no longer its first report of the binding.
        leg_reports_docs();
        // The leg's switch-off again: no longer its first report of the binding.
        leg_switches_off_news();
        tracker.record_probe(&user_binding("mail"), Connected, None, Vec::new());
        // The sink holds the tracker, which holds the drain's outlet.
        drop(sink);
        drop(tracker);
        run.await.expect("the drain's run ends");

        assert_eq!(
            recorded_server_names(&database),
            vec!["docs", "github", "mail", "news"]
        );
    }

    // A second observation of a recorded binding adds no row and keeps the switch set on it.
    #[tokio::test]
    async fn a_binding_recorded_again_keeps_its_one_row_and_its_switch() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let store = McpBindingStore::new(Arc::new(writer), reads(&database));
        let binding = user_binding("github");

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

//! Which sign-in client each MCP server admitted, one row per canonical server address however
//! many bindings or providers name the server: the provider whose own client a completed provider
//! flow signed in with, and the mark that the daemon's own client's attempt did not finish (it ran
//! out, the daemon stopped, or the server sent the browser back with an error), which outlives a
//! restart so the next press goes to a provider's flow, and which clears where no provider's flow
//! admits the server or one ends without a sign-in. Neither is a credential, and a sign-out keeps
//! the row.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::optional_text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::sign_in::canonical_server_address;

/// The statements the store's reads run: the server's row.
pub const MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY: usize = 1;

const SELECT_ADMITTED_CLIENT_SQL: &str =
    "SELECT admitted_oauth_client, own_client_unfinished_at IS NOT NULL
  FROM mcp_server_admitted_clients WHERE server_address = @server_address";

// A provider's completed flow settles which client the server admits, so the mark goes.
const RECORD_ADMITTED_PROVIDER_SQL: &str = "INSERT INTO mcp_server_admitted_clients
    (server_address, admitted_oauth_client, own_client_unfinished_at)
  VALUES (@server_address, @provider, NULL)
  ON CONFLICT (server_address) DO UPDATE SET
    admitted_oauth_client = excluded.admitted_oauth_client,
    own_client_unfinished_at = NULL";

// No provider's flow admitted the server, so the daemon's own client is the one to try again: a
// row that held only the mark goes, since a row holds a provider or the mark.
const DELETE_OWN_CLIENT_UNFINISHED_ONLY_SQL: &str = "DELETE FROM mcp_server_admitted_clients
  WHERE server_address = @server_address AND admitted_oauth_client IS NULL";
const CLEAR_OWN_CLIENT_UNFINISHED_SQL: &str = "UPDATE mcp_server_admitted_clients
  SET own_client_unfinished_at = NULL WHERE server_address = @server_address";

// The mark keeps any provider the server admitted before.
static MARK_OWN_CLIENT_UNFINISHED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO mcp_server_admitted_clients (server_address, own_client_unfinished_at)
  VALUES (@server_address, {DATABASE_NOW_SQL})
  ON CONFLICT (server_address) DO UPDATE SET
    own_client_unfinished_at = excluded.own_client_unfinished_at"
    )
});

/// What is known of the client a server admits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdmittedClient {
    /// The provider whose own client the server admitted, once that provider's flow completed.
    pub(crate) provider: Option<ProviderId>,
    /// Whether the daemon's own client's last attempt did not finish.
    pub(crate) is_own_client_unfinished: bool,
}

/// Why a server's admitted client was not read or recorded; a refused record keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AdmittedClientError {
    /// The writer did not keep the row.
    #[error("the MCP server's admitted client was not recorded")]
    Write(#[from] WriteError),
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("a read of an MCP server's admitted client failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

// A stored admitted client that is not a provider id.
#[derive(Debug, thiserror::Error)]
#[error("a stored admitted client is not a provider id")]
struct StoredProviderIdInvalid;

/// Holds each server's admitted client in `mcp_server_admitted_clients`, reading through the
/// daemon's read pool and writing through its writer, keyed by the server's canonical address.
pub struct AdmittedClientStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl AdmittedClientStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// What is known of the client the server at `address` admits, or `None` when nothing is.
    /// Fails with [`AdmittedClientError::Database`] or [`AdmittedClientError::Pool`] when the
    /// read does.
    pub(crate) async fn read(
        &self,
        address: &McpServerAddress,
    ) -> Result<Option<AdmittedClient>, AdmittedClientError> {
        let server_address = canonical_server_address(address);
        self.pool
            .read(ReadLength::Short, move |connection| {
                let admitted_client = connection
                    .prepare_cached(SELECT_ADMITTED_CLIENT_SQL)?
                    .query_row(named_params! {"@server_address": server_address}, |row| {
                        Ok(AdmittedClient {
                            provider: optional_text_column(row, 0, |text| {
                                ProviderId::new(text).ok_or(StoredProviderIdInvalid)
                            })?,
                            is_own_client_unfinished: row.get(1)?,
                        })
                    })
                    .optional()?;
                Ok(admitted_client)
            })
            .await
    }

    /// Records that the server at `address` admitted `provider`'s own client, once that
    /// provider's flow completed, and clears the own client's mark. Fails with
    /// [`AdmittedClientError::Write`] when the write is not kept.
    pub(crate) async fn record_admitted_provider(
        &self,
        address: &McpServerAddress,
        provider: &ProviderId,
    ) -> Result<(), AdmittedClientError> {
        self.write(
            RECORD_ADMITTED_PROVIDER_SQL,
            vec![
                text_binding("@server_address", &canonical_server_address(address)),
                text_binding("@provider", provider.as_str()),
            ],
        )
        .await
    }

    /// Marks that the daemon's own client's attempt at `address` did not finish. Fails with
    /// [`AdmittedClientError::Write`] when the write is not kept.
    pub(crate) async fn mark_own_client_unfinished(
        &self,
        address: &McpServerAddress,
    ) -> Result<(), AdmittedClientError> {
        self.write(
            MARK_OWN_CLIENT_UNFINISHED_SQL.as_str(),
            vec![text_binding(
                "@server_address",
                &canonical_server_address(address),
            )],
        )
        .await
    }

    /// Clears the mark that the daemon's own client did not finish at `address`, once no
    /// provider's flow admits the server or one ended without a sign-in; a row that held only the
    /// mark is removed. Fails with [`AdmittedClientError::Write`] when the write is not kept.
    pub(crate) async fn clear_own_client_unfinished(
        &self,
        address: &McpServerAddress,
    ) -> Result<(), AdmittedClientError> {
        let bindings = vec![text_binding(
            "@server_address",
            &canonical_server_address(address),
        )];
        self.writer
            .write(vec![
                WriteStatement {
                    sql: Cow::Borrowed(DELETE_OWN_CLIENT_UNFINISHED_ONLY_SQL),
                    bindings: StatementBindings::Named(bindings.clone()),
                    expected_row_count: None,
                },
                WriteStatement {
                    sql: Cow::Borrowed(CLEAR_OWN_CLIENT_UNFINISHED_SQL),
                    bindings: StatementBindings::Named(bindings),
                    expected_row_count: None,
                },
            ])
            .await?;
        Ok(())
    }

    async fn write(
        &self,
        sql: &'static str,
        bindings: Vec<(Cow<'static, str>, rusqlite::types::Value)>,
    ) -> Result<(), AdmittedClientError> {
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Named(bindings),
                expected_row_count: None,
            }])
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{AdmittedClient, AdmittedClientStore, MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY};
    use crate::schema::schema_parts;

    fn address(text: &str) -> McpServerAddress {
        McpServerAddress::new(text).expect("a server address")
    }

    async fn open_store(database: &TestDatabase) -> AdmittedClientStore {
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        AdmittedClientStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
            )),
            Arc::new(writer),
        )
    }

    /// Two providers whose bindings name one server differently, each spelling its address its
    /// own way, keep one row: the mark one provider's attempt left and the client the other's flow
    /// admitted land on it, and either spelling reads it. Killed by keying the row by the provider
    /// or the binding's name, and by keying it by the address as spelled.
    #[tokio::test]
    async fn two_providers_naming_one_address_differently_read_one_row() {
        let database = TestDatabase::new(schema_parts());
        let store = open_store(&database).await;
        // provider-a's binding names the server `docs`, provider-b's `documentation`.
        let provider_a_address = address("https://docs.example.com/mcp");
        let provider_b_address = address("HTTPS://Docs.Example.com/mcp");
        let provider_b = ProviderId::new("provider-b".to_owned()).expect("a provider id");

        store
            .mark_own_client_unfinished(&provider_a_address)
            .await
            .expect("the mark is recorded");
        let marked = store
            .read(&provider_b_address)
            .await
            .expect("the row is read");
        store
            .record_admitted_provider(&provider_b_address, &provider_b)
            .await
            .expect("the admitted client is recorded");

        assert_eq!(
            marked,
            Some(AdmittedClient {
                provider: None,
                is_own_client_unfinished: true,
            })
        );
        assert_eq!(
            store
                .read(&provider_a_address)
                .await
                .expect("the row is read"),
            Some(AdmittedClient {
                provider: Some(provider_b),
                is_own_client_unfinished: false,
            })
        );
        let rows: i64 = database
            .reader()
            .query_row(
                "SELECT count(*) FROM mcp_server_admitted_clients",
                [],
                |row| row.get(0),
            )
            .expect("the test counts the rows");
        assert_eq!(rows, 1);
    }

    /// Clearing the mark keeps the provider a server admitted beside it, and forgets a server
    /// that held only the mark. Killed by the delete's `admitted_oauth_client IS NULL` guard
    /// dropped, which forgets the admitted provider.
    #[tokio::test]
    async fn clearing_the_mark_keeps_an_admitted_provider() {
        let database = TestDatabase::new(schema_parts());
        let store = open_store(&database).await;
        let admitted = address("https://docs.example.com/mcp");
        let marked_only = address("https://tracker.example.com/mcp");
        let provider = ProviderId::new("provider-a".to_owned()).expect("a provider id");
        store
            .record_admitted_provider(&admitted, &provider)
            .await
            .expect("the admitted client is recorded");
        for marked in [&admitted, &marked_only] {
            store
                .mark_own_client_unfinished(marked)
                .await
                .expect("the mark is recorded");
            store
                .clear_own_client_unfinished(marked)
                .await
                .expect("the mark is cleared");
        }

        assert_eq!(
            store.read(&admitted).await.expect("the row is read"),
            Some(AdmittedClient {
                provider: Some(provider),
                is_own_client_unfinished: false,
            })
        );
        assert_eq!(
            store.read(&marked_only).await.expect("the row is read"),
            None
        );
    }
}

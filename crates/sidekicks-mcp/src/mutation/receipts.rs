//! A governance mutation's receipt: the keyed digests that let a retry be told from another
//! request and a landed write from an unlanded one without keeping any config value, and the store
//! that writes each receipt `pending` before the provider is touched and commits it in the same
//! write as the mutation's own rows.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use rusqlite::types::Value as SqliteValue;
use secrecy::{ExposeSecret as _, SecretBox};
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::governance::McpServerEnabledUpdate;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, database_time_sql, text_binding,
};
use sidekicks_store::database::stored_column::{StoredJsonFault, closed_word, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::canonicalizer::{CanonicalizationRefusal, canonicalize_json};

use crate::binding::store::{McpBindingKey, read_key};
use crate::schema::McpMutationReceiptStatus;

/// The distinct statements the receipt store keeps prepared on each read connection.
pub(crate) const MCP_MUTATION_RECEIPTS_STATEMENT_CAPACITY: usize = 2;

/// The daemon's 32-byte key every receipt digest is keyed with, wiped when it drops.
pub(crate) struct McpReceiptKey(SecretBox<[u8; 32]>);

/// A keyed digest a receipt keeps in place of a request or a declaration. Two digests compare in
/// constant time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct McpReceiptDigest(blake3::Hash);

impl McpReceiptDigest {
    /// The digest whose 32 bytes are `bytes`, as a receipt row stores them.
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(blake3::Hash::from_bytes(bytes))
    }

    /// The digest's 32 bytes.
    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }
}

impl McpReceiptKey {
    /// The receipt key whose bytes are `key`.
    pub(crate) fn new(key: SecretBox<[u8; 32]>) -> Self {
        Self(key)
    }

    /// The digest of `request` spent under `idempotency_key` on the wire method `method`. Fails
    /// when the request has no canonical form.
    pub(crate) fn digest_request(
        &self,
        idempotency_key: &ClientUuid,
        method: &str,
        request: &Value,
    ) -> Result<McpReceiptDigest, CanonicalizationRefusal> {
        self.digest(&json!({
            "idempotencyKey": idempotency_key.as_str(),
            "method": method,
            "request": request,
        }))
    }

    /// The digest of `binding`'s declaration `entry` under `idempotency_key`, the binding taken
    /// from its key alone so a stored key digests as the live one does. Fails when the entry has
    /// no canonical form.
    pub(crate) fn digest_declaration(
        &self,
        idempotency_key: &ClientUuid,
        binding: &McpBindingKey,
        entry: &Map<String, Value>,
    ) -> Result<McpReceiptDigest, CanonicalizationRefusal> {
        self.digest(&json!({
            "idempotencyKey": idempotency_key.as_str(),
            "binding": {
                "provider": binding.provider.as_str(),
                "scope": <&'static str>::from(binding.scope),
                "scopeRef": binding.scope_ref,
                "scopePlace": binding.scope_place,
                "serverName": binding.server_name.as_str(),
            },
            "entry": entry,
        }))
    }

    // The keyed hash of `input`'s canonical bytes, so members in any order digest alike.
    fn digest(&self, input: &Value) -> Result<McpReceiptDigest, CanonicalizationRefusal> {
        let bytes = canonicalize_json(input)?;
        Ok(McpReceiptDigest(blake3::keyed_hash(
            self.0.expose_secret(),
            bytes.as_bytes(),
        )))
    }
}

/// A mutation's intent as its `pending` receipt keeps it: what it is, the binding it writes and
/// the digests its settle compares against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpIntentReceipt {
    /// The client's idempotency key, which names the mutation.
    pub(crate) idempotency_key: ClientUuid,
    /// The `mcp.*` method the key was spent on.
    pub(crate) operation: String,
    /// The binding the mutation writes.
    pub(crate) binding: McpBindingKey,
    /// The digest of the idempotency key, the method and the request.
    pub(crate) request_digest: McpReceiptDigest,
    /// The digest of the binding's declaration before the write; `None` where it had none.
    pub(crate) before_digest: Option<McpReceiptDigest>,
    /// The digest of the declaration the write leaves; `None` for a remove.
    pub(crate) after_digest: Option<McpReceiptDigest>,
    /// A switch's wanted state, or the daemon's switch an upsert of an emulated `local` server
    /// sets; `None` for every other mutation.
    pub(crate) wanted_enabled: Option<bool>,
}

impl McpIntentReceipt {
    /// Whether the receipt is a switch's, which settles by its wanted state.
    pub(crate) fn is_switch(&self) -> bool {
        self.operation == McpServerEnabledUpdate::DESCRIPTOR.method
    }
}

/// What an idempotency key's receipt says about a request made under it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum McpSavedCheck {
    /// The key has no receipt: the mutation runs.
    Fresh,
    /// The key's mutation finished: its saved response is the answer, nothing is run.
    Saved(Value),
    /// The key was spent on another request.
    Conflict,
    /// The key's mutation began and did not finish: it is settled before it answers.
    Pending(McpIntentReceipt),
}

/// Why the receipt store did not write a receipt or answer a read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpReceiptStoreError {
    /// The write failed or a statement's row count was not the one it expected; none of it was
    /// kept.
    #[error("the MCP mutation receipt could not be written")]
    Write(#[source] WriteError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the MCP mutation receipts could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

// The columns `read_intent` reads, the binding's key first as `read_key` reads it.
const INTENT_COLUMNS: &str = "scope, scope_ref, scope_place, server_name, provider, \
                              client_idempotency_key, operation, request_digest, before_digest, \
                              after_digest, wanted_enabled";

static SAVED_CHECK_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {INTENT_COLUMNS}, status, response_json
  FROM mcp_mutation_receipts
  WHERE client_idempotency_key = @key"
    )
});

static PENDING_RECEIPTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {INTENT_COLUMNS}
  FROM mcp_mutation_receipts
  WHERE status = '{}'
  ORDER BY created_at, client_idempotency_key",
        <&'static str>::from(McpMutationReceiptStatus::Pending)
    )
});

// A pending row is never pruned: the start settles it.
static PRUNE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM mcp_mutation_receipts
  WHERE status = '{}' AND created_at < {}",
        <&'static str>::from(McpMutationReceiptStatus::Committed),
        database_time_sql("'-1 day'")
    )
});

static BEGIN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO mcp_mutation_receipts (client_idempotency_key, operation, provider, scope,
    scope_ref, scope_place, server_name, request_digest, before_digest, after_digest,
    wanted_enabled, status, created_at)
  VALUES (@key, @operation, @provider, @scope, @scope_ref, @scope_place, @server_name,
    @request_digest, @before_digest, @after_digest, @wanted_enabled, '{}', {DATABASE_NOW_SQL})",
        <&'static str>::from(McpMutationReceiptStatus::Pending)
    )
});

static COMMIT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE mcp_mutation_receipts SET status = '{}', response_json = @response
  WHERE client_idempotency_key = @key AND status = '{}'",
        <&'static str>::from(McpMutationReceiptStatus::Committed),
        <&'static str>::from(McpMutationReceiptStatus::Pending)
    )
});

// The digests were taken under a key the daemon no longer holds, so none could match again.
static COMMIT_KEY_LOST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE mcp_mutation_receipts SET status = '{}', response_json = @response,
    request_digest = NULL, before_digest = NULL, after_digest = NULL
  WHERE client_idempotency_key = @key AND status = '{}'",
        <&'static str>::from(McpMutationReceiptStatus::Committed),
        <&'static str>::from(McpMutationReceiptStatus::Pending)
    )
});

static EXPIRE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM mcp_mutation_receipts
  WHERE client_idempotency_key = @key AND status = '{}'",
        <&'static str>::from(McpMutationReceiptStatus::Pending)
    )
});

/// Writes the governance mutations' receipts and reads them back.
#[derive(Clone)]
pub(crate) struct McpMutationReceipts {
    /// The writer every receipt goes through.
    writer: Arc<DatabaseWriter>,
    /// The read pool every read borrows a connection from.
    reads: Arc<DatabaseReadPool>,
}

impl McpMutationReceipts {
    /// A store writing through `writer` and reading on `reads`.
    pub(crate) fn new(writer: Arc<DatabaseWriter>, reads: Arc<DatabaseReadPool>) -> Self {
        Self { writer, reads }
    }

    /// What `idempotency_key`'s receipt says about a request whose digest is `request_digest`, in
    /// one short read. A row committed when the receipt key was lost answers its saved response
    /// under any request. Fails with [`McpReceiptStoreError::Database`] or
    /// [`McpReceiptStoreError::Pool`] as the read fails.
    pub(crate) async fn check_saved(
        &self,
        idempotency_key: &ClientUuid,
        request_digest: &McpReceiptDigest,
    ) -> Result<McpSavedCheck, McpReceiptStoreError> {
        let idempotency_key = idempotency_key.clone();
        let request_digest = *request_digest;
        self.reads
            .read(ReadLength::Short, move |connection| {
                let mut statement = connection.prepare_cached(SAVED_CHECK_SQL.as_str())?;
                let mut rows =
                    statement.query(named_params! { "@key": idempotency_key.as_str() })?;
                let Some(row) = rows.next()? else {
                    return Ok(McpSavedCheck::Fresh);
                };
                let status: McpMutationReceiptStatus = text_column(row, 11, |text| text.parse())?;
                match status {
                    McpMutationReceiptStatus::Committed => {
                        let stored_digest: Option<[u8; 32]> = row.get(7)?;
                        let matches = stored_digest.is_none_or(|stored| {
                            McpReceiptDigest::from_bytes(stored) == request_digest
                        });
                        if !matches {
                            return Ok(McpSavedCheck::Conflict);
                        }
                        let response = text_column(row, 12, |text| {
                            serde_json::from_str(&text).map_err(StoredJsonFault::from)
                        })?;
                        Ok(McpSavedCheck::Saved(response))
                    }
                    McpMutationReceiptStatus::Pending => {
                        let intent = read_intent(row)?;
                        if intent.request_digest == request_digest {
                            Ok(McpSavedCheck::Pending(intent))
                        } else {
                            Ok(McpSavedCheck::Conflict)
                        }
                    }
                }
            })
            .await
    }

    /// Records `intent` as a `pending` receipt in one write, first pruning the committed receipts
    /// older than a day. Fails with [`McpReceiptStoreError::Write`] as the write fails, a key that
    /// already has a receipt among the causes.
    pub(crate) async fn begin(
        &self,
        intent: &McpIntentReceipt,
    ) -> Result<(), McpReceiptStoreError> {
        let binding = &intent.binding;
        let prune = WriteStatement {
            sql: Cow::Borrowed(PRUNE_SQL.as_str()),
            bindings: StatementBindings::None,
            expected_row_count: None,
        };
        let insert = WriteStatement {
            sql: Cow::Borrowed(BEGIN_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@key", intent.idempotency_key.as_str()),
                text_binding("@operation", &intent.operation),
                text_binding("@provider", binding.provider.as_str()),
                text_binding("@scope", <&'static str>::from(binding.scope)),
                text_binding("@scope_ref", &binding.scope_ref),
                text_binding("@scope_place", &binding.scope_place),
                text_binding("@server_name", binding.server_name.as_str()),
                digest_binding("@request_digest", Some(&intent.request_digest)),
                digest_binding("@before_digest", intent.before_digest.as_ref()),
                digest_binding("@after_digest", intent.after_digest.as_ref()),
                (
                    Cow::Borrowed("@wanted_enabled"),
                    SqliteValue::from(intent.wanted_enabled),
                ),
            ]),
            expected_row_count: Some(1),
        };
        self.write(vec![prune, insert]).await
    }

    /// Commits `idempotency_key`'s `pending` receipt with `response` and runs `rows` after it, all
    /// in one write. Fails with [`McpReceiptStoreError::Write`] when the key has no `pending`
    /// receipt or any statement is refused; none of it is kept then.
    pub(crate) async fn commit(
        &self,
        idempotency_key: &ClientUuid,
        response: &Value,
        rows: Vec<WriteStatement>,
    ) -> Result<(), McpReceiptStoreError> {
        let mut statements = Vec::with_capacity(rows.len() + 1);
        statements.push(WriteStatement {
            sql: Cow::Borrowed(COMMIT_SQL.as_str()),
            bindings: committed_bindings(idempotency_key, response),
            expected_row_count: Some(1),
        });
        statements.extend(rows);
        self.write(statements).await
    }

    /// Deletes `idempotency_key`'s `pending` receipt, so a retry under the key runs fresh. Fails
    /// with [`McpReceiptStoreError::Write`] when the key has no `pending` receipt.
    pub(crate) async fn expire(
        &self,
        idempotency_key: &ClientUuid,
    ) -> Result<(), McpReceiptStoreError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(EXPIRE_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@key",
                idempotency_key.as_str(),
            )]),
            expected_row_count: Some(1),
        }])
        .await
    }

    /// Every `pending` receipt, oldest first, for the start to settle. Fails with
    /// [`McpReceiptStoreError::Database`] or [`McpReceiptStoreError::Pool`] as the read fails.
    pub(crate) async fn list_pending(&self) -> Result<Vec<McpIntentReceipt>, McpReceiptStoreError> {
        self.reads
            .read(ReadLength::Short, |connection| {
                let mut statement = connection.prepare_cached(PENDING_RECEIPTS_SQL.as_str())?;
                let intents = statement
                    .query_map([], read_intent)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(intents)
            })
            .await
    }

    /// The statement that commits `idempotency_key`'s `pending` receipt with `response` and clears
    /// its three digests, for a receipt key that was lost; the write it joins is refused when the
    /// key has no `pending` receipt.
    pub(crate) fn commit_key_lost_statement(
        idempotency_key: &ClientUuid,
        response: &Value,
    ) -> WriteStatement {
        WriteStatement {
            sql: Cow::Borrowed(COMMIT_KEY_LOST_SQL.as_str()),
            bindings: committed_bindings(idempotency_key, response),
            expected_row_count: Some(1),
        }
    }

    // Runs `statements` as one write.
    async fn write(&self, statements: Vec<WriteStatement>) -> Result<(), McpReceiptStoreError> {
        self.writer
            .write(statements)
            .await
            .map_err(McpReceiptStoreError::Write)?;
        Ok(())
    }
}

// The key and the response a statement committing a receipt binds.
fn committed_bindings(idempotency_key: &ClientUuid, response: &Value) -> StatementBindings {
    StatementBindings::Named(vec![
        text_binding("@key", idempotency_key.as_str()),
        text_binding("@response", &response.to_string()),
    ])
}

// A digest column's binding, `NULL` for none.
fn digest_binding(
    name: &'static str,
    digest: Option<&McpReceiptDigest>,
) -> (Cow<'static, str>, SqliteValue) {
    (
        Cow::Borrowed(name),
        digest.map_or(SqliteValue::Null, |digest| {
            SqliteValue::Blob(digest.as_bytes().to_vec())
        }),
    )
}

// A pending receipt's `INTENT_COLUMNS`; its request digest is never NULL.
fn read_intent(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpIntentReceipt> {
    let provider = text_column(row, 4, closed_word::<ProviderId>)?;
    let digest = |index: usize| {
        row.get::<_, Option<[u8; 32]>>(index)
            .map(|bytes| bytes.map(McpReceiptDigest::from_bytes))
    };
    Ok(McpIntentReceipt {
        binding: read_key(&provider, row)?,
        idempotency_key: text_column(row, 5, ClientUuid::new)?,
        operation: row.get(6)?,
        request_digest: McpReceiptDigest::from_bytes(row.get(7)?),
        before_digest: digest(8)?,
        after_digest: digest(9)?,
        wanted_enabled: row.get(10)?,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use rusqlite::params;
    use secrecy::SecretBox;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::mcp::server::{McpBindingScope, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::statement::{
        StatementBindings, WriteStatement, database_time_sql,
    };
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_store::events::canonicalizer::canonicalize_json;

    use super::{
        MCP_MUTATION_RECEIPTS_STATEMENT_CAPACITY, McpIntentReceipt, McpMutationReceipts,
        McpReceiptDigest, McpReceiptKey, McpSavedCheck,
    };
    use crate::binding::store::McpBindingKey;
    use crate::mutation::receipt_key::MCP_RECEIPT_KEY_STATEMENT_CAPACITY;
    use crate::schema::schema_parts;

    /// A receipt key whose 32 bytes are all `fill`.
    pub(in crate::mutation) fn receipt_key(fill: u8) -> McpReceiptKey {
        McpReceiptKey::new(SecretBox::new(Box::new([fill; 32])))
    }

    /// A fresh idempotency key.
    pub(crate) fn idempotency_key() -> ClientUuid {
        ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key")
    }

    /// A project binding in a distribution, so every part of the key is filled.
    pub(in crate::mutation) fn project_binding() -> McpBindingKey {
        McpBindingKey {
            provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            scope: McpBindingScope::Project,
            scope_ref: "/repo".to_owned(),
            scope_place: "Ubuntu".to_owned(),
            server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
        }
    }

    /// `value`'s members as a declaration entry.
    pub(in crate::mutation) fn entry(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).expect("the test's entry is an object")
    }

    fn digest_of(fill: u8) -> McpReceiptDigest {
        McpReceiptDigest::from_bytes([fill; 32])
    }

    fn intent(idempotency_key: &ClientUuid, request_digest: McpReceiptDigest) -> McpIntentReceipt {
        McpIntentReceipt {
            idempotency_key: idempotency_key.clone(),
            operation: "mcp.server.upsert".to_owned(),
            binding: project_binding(),
            request_digest,
            before_digest: Some(digest_of(2)),
            after_digest: Some(digest_of(3)),
            wanted_enabled: Some(false),
        }
    }

    /// A receipt store over a fresh database of the crate's schema, with the writer and the read
    /// pool it goes through, each prepared for the receipt key's statements too.
    pub(crate) async fn receipts_over_a_database() -> (
        TestDatabase,
        McpMutationReceipts,
        Arc<DatabaseWriter>,
        Arc<DatabaseReadPool>,
    ) {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            MCP_MUTATION_RECEIPTS_STATEMENT_CAPACITY + MCP_RECEIPT_KEY_STATEMENT_CAPACITY,
        ));
        let receipts = McpMutationReceipts::new(Arc::clone(&writer), Arc::clone(&reads));
        (database, receipts, writer, reads)
    }

    async fn check(
        receipts: &McpMutationReceipts,
        idempotency_key: &ClientUuid,
        request_digest: McpReceiptDigest,
    ) -> McpSavedCheck {
        receipts
            .check_saved(idempotency_key, &request_digest)
            .await
            .expect("the saved check reads")
    }

    fn count_bindings(database: &TestDatabase) -> i64 {
        database
            .reader()
            .query_row("SELECT count(*) FROM mcp_server_bindings", [], |row| {
                row.get(0)
            })
            .expect("the test counts the bindings")
    }

    /// A digest depends on the receipt key, the idempotency key, the method and every member's
    /// value, never on member order, and is no plain hash of what it covers. Killed by a digest
    /// with no receipt key, with no idempotency key or method in its input, or over the members
    /// in insertion order.
    #[test]
    fn a_digest_is_keyed_and_canonical() {
        let key = receipt_key(1);
        let (first, second) = (idempotency_key(), idempotency_key());
        let binding = project_binding();
        let declaration = entry(json!({ "command": "npx", "args": ["docs-server"] }));
        let digest = key
            .digest_declaration(&first, &binding, &declaration)
            .expect("the declaration digests");

        let under_second = key
            .digest_declaration(&second, &binding, &declaration)
            .expect("the declaration digests");
        let under_other_key = receipt_key(2)
            .digest_declaration(&first, &binding, &declaration)
            .expect("the declaration digests");
        assert_ne!(digest, under_second);
        assert_ne!(digest, under_other_key);

        let covered = json!({
            "idempotencyKey": first.as_str(),
            "binding": {
                "provider": "provider-a",
                "scope": "project",
                "scopeRef": "/repo",
                "scopePlace": "Ubuntu",
                "serverName": "docs",
            },
            "entry": declaration,
        });
        let canonical = canonicalize_json(&covered).expect("the covered value is canonical");
        assert_ne!(
            digest.as_bytes(),
            blake3::hash(canonical.as_bytes()).as_bytes()
        );
        assert_ne!(
            digest.as_bytes(),
            blake3::hash(covered.to_string().as_bytes()).as_bytes()
        );

        let mut reordered = Map::new();
        reordered.insert("args".to_owned(), json!(["docs-server"]));
        reordered.insert("command".to_owned(), json!("npx"));
        let reordered_digest = key
            .digest_declaration(&first, &binding, &reordered)
            .expect("the reordered declaration digests");
        assert_eq!(digest, reordered_digest);

        let request = json!({ "serverName": "docs" });
        let upsert = key.digest_request(&first, "mcp.server.upsert", &request);
        let delete = key.digest_request(&first, "mcp.server.delete", &request);
        assert_ne!(
            upsert.expect("the request digests"),
            delete.expect("the request digests")
        );
    }

    /// The saved check answers by status and digest: no row is fresh, a committed row of the
    /// same request is its saved response, a pending one of the same request is its intent with
    /// every field read back, and a row of another request conflicts. Killed by the compare
    /// dropped, by a pending row answered as saved, and by a field left unread.
    #[tokio::test]
    async fn the_saved_check_answers_by_status_and_digest() {
        let (_database, receipts, _writer, _reads) = receipts_over_a_database().await;
        let (committed_key, pending_key) = (idempotency_key(), idempotency_key());
        let response = json!({ "applied": true });

        assert_eq!(
            check(&receipts, &committed_key, digest_of(1)).await,
            McpSavedCheck::Fresh
        );
        receipts
            .begin(&intent(&committed_key, digest_of(1)))
            .await
            .expect("the intent begins");
        receipts
            .commit(&committed_key, &response, Vec::new())
            .await
            .expect("the receipt commits");
        let pending = intent(&pending_key, digest_of(4));
        receipts.begin(&pending).await.expect("the intent begins");

        assert_eq!(
            check(&receipts, &committed_key, digest_of(1)).await,
            McpSavedCheck::Saved(response)
        );
        assert_eq!(
            check(&receipts, &committed_key, digest_of(9)).await,
            McpSavedCheck::Conflict
        );
        assert_eq!(
            check(&receipts, &pending_key, digest_of(4)).await,
            McpSavedCheck::Pending(pending.clone())
        );
        assert_eq!(
            check(&receipts, &pending_key, digest_of(9)).await,
            McpSavedCheck::Conflict
        );
        assert_eq!(
            receipts
                .list_pending()
                .await
                .expect("the pending receipts read"),
            vec![pending]
        );
    }

    /// The commit's flip and the caller's rows are one write: a refused row keeps the receipt
    /// pending and writes none of the rows, and a receipt already committed is not committed
    /// again. Killed by the flip and the rows written apart, and by the flip without its row
    /// count.
    #[tokio::test]
    async fn a_commit_is_one_write_of_a_pending_receipt() {
        let (database, receipts, _writer, _reads) = receipts_over_a_database().await;
        let key = idempotency_key();
        receipts
            .begin(&intent(&key, digest_of(1)))
            .await
            .expect("the intent begins");
        let rows = vec![
            WriteStatement {
                sql: "INSERT INTO mcp_server_bindings (provider, scope, server_name,
                        first_observed_at, updated_at)
                      VALUES ('provider-a', 'user', 'docs', 't', 't')"
                    .into(),
                bindings: StatementBindings::None,
                expected_row_count: None,
            },
            WriteStatement {
                sql: "DELETE FROM mcp_server_bindings WHERE server_name = 'absent'".into(),
                bindings: StatementBindings::None,
                expected_row_count: Some(1),
            },
        ];

        let refused = receipts.commit(&key, &json!({}), rows).await;

        assert!(refused.is_err(), "the refused row fails the commit");
        assert!(matches!(
            check(&receipts, &key, digest_of(1)).await,
            McpSavedCheck::Pending(_)
        ));
        assert_eq!(count_bindings(&database), 0);
        receipts
            .commit(&key, &json!({}), Vec::new())
            .await
            .expect("the receipt commits");
        assert!(
            receipts
                .commit(&key, &json!({ "again": true }), Vec::new())
                .await
                .is_err(),
            "a committed receipt is not committed again"
        );
    }

    /// A begin prunes committed receipts older than a day and nothing else, and an expiry deletes
    /// only a pending receipt. Killed by pending receipts pruned, by no prune, by the age bound
    /// reversed, and by an expiry of a committed receipt.
    #[tokio::test]
    async fn a_begin_prunes_old_committed_receipts_and_an_expiry_only_pending_ones() {
        let (database, receipts, _writer, _reads) = receipts_over_a_database().await;
        let (old_committed, old_pending, recent_committed) =
            (idempotency_key(), idempotency_key(), idempotency_key());
        let reader = database.reader();
        for (key, status, response, age) in [
            (&old_committed, "committed", Some("{}"), "-25 hours"),
            (&old_pending, "pending", None, "-25 hours"),
            (&recent_committed, "committed", Some("{}"), "-23 hours"),
        ] {
            reader
                .execute(
                    &format!(
                        "INSERT INTO mcp_mutation_receipts (client_idempotency_key, operation,
                           provider, scope, server_name, request_digest, status, response_json,
                           created_at)
                         VALUES (?1, 'mcp.server.upsert', 'provider-a', 'user', 'docs',
                           zeroblob(32), ?2, ?3, {})",
                        database_time_sql("?4")
                    ),
                    params![key.as_str(), status, response, age],
                )
                .expect("the aged receipt is stored");
        }
        let fresh = idempotency_key();

        receipts
            .begin(&intent(&fresh, digest_of(1)))
            .await
            .expect("the intent begins");

        assert_eq!(
            check(&receipts, &old_committed, digest_of(0)).await,
            McpSavedCheck::Fresh
        );
        assert!(matches!(
            check(&receipts, &old_pending, digest_of(0)).await,
            McpSavedCheck::Pending(_)
        ));
        assert_eq!(
            check(&receipts, &recent_committed, digest_of(0)).await,
            McpSavedCheck::Saved(json!({}))
        );

        receipts
            .expire(&fresh)
            .await
            .expect("the pending receipt expires");
        assert_eq!(
            check(&receipts, &fresh, digest_of(1)).await,
            McpSavedCheck::Fresh
        );
        assert!(
            receipts.expire(&recent_committed).await.is_err(),
            "a committed receipt does not expire"
        );
        assert_eq!(
            check(&receipts, &recent_committed, digest_of(0)).await,
            McpSavedCheck::Saved(json!({}))
        );
    }
}

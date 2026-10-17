//! The account's SQLite store: the hosted account's one schema, built whole on an empty database,
//! and the calls every reader of it makes. On the Workers relay the store is the account object's
//! SQLite storage; on the Compose relay it is the relay's SQLite file, which only its process opens.

use serde::de::DeserializeOwned;

/// The whole schema, every table the account keeps. Times are Unix seconds, except the sign-in
/// routes' counted requests, whose window frees to the millisecond.
const SCHEMA: &str = "
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  display_name    TEXT NOT NULL,
  identity_ref    TEXT NOT NULL UNIQUE
) STRICT;

CREATE INDEX idx_users_identity ON users(identity_ref);

CREATE TABLE webauthn_credentials (
  user_id           TEXT NOT NULL REFERENCES users(id),
  credential_id     TEXT PRIMARY KEY,
  public_key        BLOB NOT NULL,
  aaguid            TEXT NOT NULL,
  signature_counter INTEGER NOT NULL DEFAULT 0,
  transports        TEXT,
  registered_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at      INTEGER
) STRICT;

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE webauthn_challenges (
  challenge       TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL UNIQUE,
  user_id         TEXT REFERENCES users(id),
  ceremony        TEXT NOT NULL CHECK (ceremony IN ('registration','authentication')),
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE revoked_jtis (
  jti              TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  family_id        TEXT NOT NULL,
  revoked_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('signOut', 'refreshReuse', 'deviceRevoked', 'accountDeleted')),
  expires_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_revoked_jtis_user ON revoked_jtis(user_id);
CREATE INDEX idx_revoked_jtis_family ON revoked_jtis(family_id);
CREATE INDEX idx_revoked_jtis_expires ON revoked_jtis(expires_at);

CREATE TABLE revoked_token_families (
  family_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  revoked_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('signOut', 'refreshReuse', 'deviceRevoked', 'accountDeleted'))
) STRICT;

CREATE INDEX idx_revoked_families_user ON revoked_token_families(user_id);

CREATE TABLE refresh_token_families (
  family_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cnf_jkt          TEXT NOT NULL,
  current_jti      TEXT NOT NULL,
  issued_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_traded_at   INTEGER
) STRICT;

CREATE INDEX idx_refresh_token_families_user ON refresh_token_families(user_id);

CREATE TABLE dpop_proof_jtis (
  jti              TEXT PRIMARY KEY,
  expires_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_dpop_proof_jtis_expires ON dpop_proof_jtis(expires_at);

CREATE TABLE authorization_requests (
  request_uri          TEXT PRIMARY KEY,
  code_challenge       TEXT NOT NULL,
  state                TEXT NOT NULL,
  redirect_uri         TEXT NOT NULL,
  dpop_jkt             TEXT NOT NULL,
  machine_id           TEXT NOT NULL,
  identity_public_key  BLOB NOT NULL,
  channel_public_key   BLOB NOT NULL,
  machine_name         TEXT NOT NULL,
  platform             TEXT NOT NULL,
  service_version      TEXT NOT NULL,
  expires_at           INTEGER NOT NULL,
  approved_user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  authorization_code   TEXT UNIQUE,
  code_expires_at      INTEGER,
  issued_family_id     TEXT,
  pending_identity_ref TEXT,
  pending_display_name TEXT,
  first_passkey_proof  TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX idx_authorization_requests_expires ON authorization_requests(expires_at);

CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  public_key       BLOB NOT NULL,
  key_algorithm    TEXT NOT NULL CHECK(key_algorithm IN ('p256', 'ed25519')),
  kind             TEXT NOT NULL,
  platform         TEXT NOT NULL,
  name             TEXT NOT NULL,
  app_version      TEXT,
  linked_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at     INTEGER,
  revoked_at       INTEGER,
  push_platform    TEXT CHECK(push_platform IN ('apns', 'webPush')),
  push_address     TEXT
) STRICT;

CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE machines (
  machine_id         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  public_key         BLOB NOT NULL,
  key_algorithm      TEXT NOT NULL CHECK(key_algorithm = 'ed25519'),
  name               TEXT NOT NULL,
  platform           TEXT NOT NULL,
  service_version    TEXT NOT NULL,
  registered_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_connected_at  INTEGER
) STRICT;

CREATE INDEX idx_machines_user ON machines(user_id);

CREATE TABLE trust_statements (
  statement_hash   TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  previous_hash    TEXT,
  kind             TEXT NOT NULL
                   CHECK(kind IN ('device.linked', 'device.renamed', 'device.revoked',
                                  'account.passkey.added', 'account.passkey.removed',
                                  'machine.added', 'machine.renamed', 'machine.removed')),
  statement        BLOB NOT NULL,
  received_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, previous_hash)
) STRICT;

-- One row per request a sign-in route counted, kept until it leaves its window.
CREATE TABLE counted_requests (
  endpoint_group   TEXT NOT NULL,
  identity         TEXT NOT NULL,
  expires_at_ms    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_counted_requests_window
  ON counted_requests(endpoint_group, identity, expires_at_ms);
CREATE INDEX idx_counted_requests_expires ON counted_requests(expires_at_ms);
";

/// A value bound to a statement's numbered `?` parameter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqlValue {
    /// An `INTEGER`.
    Integer(i64),
    /// A `TEXT`.
    Text(String),
}

/// A statement the account store refused or a row it could not read; the store's own error is
/// kept as the cause.
#[derive(Debug, thiserror::Error)]
pub enum AccountStoreError {
    /// The Compose relay's SQLite file refused the statement.
    #[cfg(not(target_arch = "wasm32"))]
    #[error("the account's SQLite file refused a statement")]
    File(#[from] rusqlite::Error),
    /// The account object's SQLite storage refused the statement.
    #[cfg(target_arch = "wasm32")]
    #[error("the account object's SQLite storage refused a statement")]
    Object(#[from] worker::Error),
    /// A row did not read as the columns its reader names.
    #[error("a row of the account store did not read as its columns")]
    Row(#[from] serde_json::Error),
}

/// The account's SQLite database, reached through its one writer, which runs one request's
/// statements at a time, so a read and the write that depends on it see no other request between.
pub trait AccountStore {
    /// Runs `script`, statements with no parameters, in one call with nothing awaited between.
    fn run_script(&self, script: &str) -> Result<(), AccountStoreError>;

    /// Runs one statement that returns no rows, with its parameters.
    fn execute(&self, statement: &str, parameters: &[SqlValue]) -> Result<(), AccountStoreError>;

    /// Runs one statement and reads each row it returns as `T`, its fields named by column.
    fn query<T: DeserializeOwned>(
        &self,
        statement: &str,
        parameters: &[SqlValue],
    ) -> Result<Vec<T>, AccountStoreError>;
}

/// Builds the whole schema in one transaction when the database holds none; a database that
/// holds it is left as it is.
pub(crate) fn apply_schema<S: AccountStore>(store: &S) -> Result<(), AccountStoreError> {
    #[derive(serde::Deserialize)]
    struct Probe {
        present: i64,
    }

    // The script's last object stands for the whole schema, so a script cut short reads as unbuilt.
    let probe: Vec<Probe> = store.query(
        "SELECT COUNT(*) AS present FROM sqlite_schema \
         WHERE type = 'index' AND name = 'idx_counted_requests_expires'",
        &[],
    )?;
    if probe.iter().any(|row| row.present > 0) {
        return Ok(());
    }
    store.run_script(SCHEMA)
}

#[cfg(not(target_arch = "wasm32"))]
mod file {
    //! The Compose relay's account store: one SQLite file its process alone opens.

    use std::path::Path;

    use rusqlite::types::{ToSqlOutput, Value, ValueRef};
    use rusqlite::{Connection, ToSql, params_from_iter};
    use serde::de::DeserializeOwned;

    use super::{AccountStore, AccountStoreError, SqlValue, apply_schema};

    /// SQLite's page cache for the account file, in KiB.
    const CACHE_KIB: i64 = 2048;

    /// Opens the account's SQLite file, creating it when absent, with every `REFERENCES` enforced,
    /// and builds the schema when the file holds none.
    pub fn open_account_file(path: &Path) -> Result<Connection, AccountStoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "cache_size", -CACHE_KIB)?;
        apply_schema(&connection)?;
        Ok(connection)
    }

    impl ToSql for SqlValue {
        fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
            Ok(match self {
                Self::Integer(value) => ToSqlOutput::Borrowed(ValueRef::Integer(*value)),
                Self::Text(value) => ToSqlOutput::Borrowed(ValueRef::Text(value.as_bytes())),
            })
        }
    }

    impl AccountStore for Connection {
        fn run_script(&self, script: &str) -> Result<(), AccountStoreError> {
            let transaction = self.unchecked_transaction()?;
            transaction.execute_batch(script)?;
            transaction.commit()?;
            Ok(())
        }

        fn execute(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<(), AccountStoreError> {
            self.prepare_cached(statement)?
                .execute(params_from_iter(parameters))?;
            Ok(())
        }

        fn query<T: DeserializeOwned>(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<Vec<T>, AccountStoreError> {
            let mut prepared = self.prepare_cached(statement)?;
            let columns: Vec<String> = prepared
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let mut rows = prepared.query(params_from_iter(parameters))?;
            let mut read = Vec::new();
            while let Some(row) = rows.next()? {
                let mut fields = serde_json::Map::with_capacity(columns.len());
                for (index, column) in columns.iter().enumerate() {
                    fields.insert(column.clone(), convert_to_json_value(row.get(index)?));
                }
                read.push(serde_json::from_value(serde_json::Value::Object(fields))?);
            }
            Ok(read)
        }
    }

    // A column's value as the JSON a row's reader takes; a blob reads as its bytes.
    fn convert_to_json_value(value: Value) -> serde_json::Value {
        match value {
            Value::Null => serde_json::Value::Null,
            Value::Integer(integer) => integer.into(),
            Value::Real(real) => real.into(),
            Value::Text(text) => text.into(),
            Value::Blob(bytes) => bytes.into(),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use file::open_account_file;

#[cfg(target_arch = "wasm32")]
mod object {
    //! The Workers relay's account store: the account object's SQLite storage.

    use serde::de::DeserializeOwned;
    use worker::{SqlStorage, SqlStorageValue};

    use super::{AccountStore, AccountStoreError, SqlValue};

    fn convert_to_storage_values(parameters: &[SqlValue]) -> Vec<SqlStorageValue> {
        parameters
            .iter()
            .map(|parameter| match parameter {
                SqlValue::Integer(value) => SqlStorageValue::Integer(*value),
                SqlValue::Text(value) => SqlStorageValue::String(value.clone()),
            })
            .collect()
    }

    impl AccountStore for SqlStorage {
        // The object commits the writes of one call together; `apply_schema` reads the script's
        // last object, so a script cut short reads as unbuilt.
        fn run_script(&self, script: &str) -> Result<(), AccountStoreError> {
            self.exec(script, None)?;
            Ok(())
        }

        fn execute(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<(), AccountStoreError> {
            self.exec(statement, convert_to_storage_values(parameters))?;
            Ok(())
        }

        fn query<T: DeserializeOwned>(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<Vec<T>, AccountStoreError> {
            Ok(self
                .exec(statement, convert_to_storage_values(parameters))?
                .to_array()?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AccountStore, SqlValue, open_account_file};

    #[test]
    fn the_schema_is_built_once_and_its_references_hold() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("account.sqlite");
        let connection = open_account_file(&path).unwrap();
        AccountStore::execute(
            &connection,
            "INSERT INTO users (id, display_name, identity_ref) VALUES (?1, ?2, ?3)",
            &[
                SqlValue::Text("first".to_owned()),
                SqlValue::Text("Sam".to_owned()),
                SqlValue::Text("handle".to_owned()),
            ],
        )
        .unwrap();
        drop(connection);

        // Opening a file that holds the schema keeps its rows.
        let connection = open_account_file(&path).unwrap();
        let users: Vec<serde_json::Value> = connection.query("SELECT id FROM users", &[]).unwrap();
        assert_eq!(users, vec![serde_json::json!({ "id": "first" })]);

        let orphan = AccountStore::execute(
            &connection,
            "INSERT INTO machines (machine_id, user_id, public_key, key_algorithm, name, platform, \
             service_version) VALUES ('m', 'nobody', x'00', 'ed25519', 'Desk', 'darwin', '1.0.0')",
            &[],
        );
        assert!(orphan.is_err(), "a machine of no user is refused");
    }
}

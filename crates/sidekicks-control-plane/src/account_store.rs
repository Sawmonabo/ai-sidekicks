//! The account's SQLite store: the hosted account's one schema, built whole on an empty database,
//! and the calls every reader of it makes. On the Workers relay the store is the account object's
//! SQLite storage; on the Compose relay it is the relay's SQLite file, which only its process opens.

use std::future::Future;

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

/// A value bound to a statement's numbered `?` parameter. There is no boolean: the account
/// object's storage binds none, so a flag is an `INTEGER`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqlValue {
    /// `NULL`.
    Null,
    /// An `INTEGER`.
    Integer(i64),
    /// A `TEXT`.
    Text(String),
    /// A `BLOB`, which a row's reader takes through `serde_with::Bytes`.
    Blob(Vec<u8>),
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
    /// The Compose relay's blocking task that ran the step ended before it answered.
    #[cfg(not(target_arch = "wasm32"))]
    #[error("the account step's task ended before it answered")]
    Task(#[from] tokio::task::JoinError),
}

/// The account's SQLite database, reached through its one writer, which runs one request's
/// statements at a time. A read and the write that depends on it run inside one [`write_step`]
/// with nothing awaited between them, so no other request sees or changes the rows between.
///
/// [`write_step`]: AccountStore::write_step
pub trait AccountStore {
    /// Runs `script`, statements with no parameters, each at once; inside a step it commits or
    /// rolls back with the step.
    fn run_script(&self, script: &str) -> Result<(), AccountStoreError>;

    /// Runs one statement that returns no rows, with its parameters.
    fn execute(&self, statement: &str, parameters: &[SqlValue]) -> Result<(), AccountStoreError>;

    /// Runs one statement and reads each row it returns as `T`, its fields named by column.
    fn query<T: DeserializeOwned>(
        &self,
        statement: &str,
        parameters: &[SqlValue],
    ) -> Result<Vec<T>, AccountStoreError>;

    /// Runs `step` as one transaction: every write it made commits when it returns `Ok`, and none
    /// does when it returns `Err` or the store fails, whose error is returned. A step never
    /// awaits, and never opens a step inside itself.
    fn write_step<R, E: From<AccountStoreError>>(
        &self,
        step: impl FnOnce(&Self) -> Result<R, E>,
    ) -> Result<R, E>;
}

/// The account store a router's handlers share. A step runs on it as on the store itself, one at
/// a time; on the Compose relay it runs on the blocking pool and waits there for the file, which
/// one lock guards, so no runtime thread waits on SQLite.
pub trait SharedAccountStore: Clone + Send + Sync + 'static {
    /// The store a step runs on.
    type Store: AccountStore;

    /// Runs `step` as [`AccountStore::write_step`] does; a step whose task ends before it
    /// answers fails with [`AccountStoreError`].
    fn run_step<R, E, F>(&self, step: F) -> impl Future<Output = Result<R, E>> + Send
    where
        R: Send + 'static,
        E: From<AccountStoreError> + Send + 'static,
        F: FnOnce(&Self::Store) -> Result<R, E> + Send + 'static;
}

/// Builds the whole schema in one step when the database holds none; a database that holds it is
/// left as it is.
pub(crate) fn apply_schema<S: AccountStore>(store: &S) -> Result<(), AccountStoreError> {
    #[derive(serde::Deserialize)]
    struct Probe {
        present: i64,
    }

    store.write_step(|store| {
        // The script runs in this one step, which commits whole or not at all, so the last object
        // it creates tells a built database from an empty one.
        let probe: Vec<Probe> = store.query(
            "SELECT COUNT(*) AS present FROM sqlite_schema \
             WHERE type = 'index' AND name = 'idx_counted_requests_expires'",
            &[],
        )?;
        if probe.iter().any(|row| row.present > 0) {
            return Ok(());
        }
        store.run_script(SCHEMA)
    })
}

#[cfg(not(target_arch = "wasm32"))]
mod file {
    //! The Compose relay's account store: one SQLite file its process alone opens.

    use std::future::Future;
    use std::path::Path;
    use std::sync::{Arc, Mutex, PoisonError};

    use rusqlite::types::{ToSqlOutput, Value, ValueRef};
    use rusqlite::{Connection, ToSql, params_from_iter};
    use serde::de::DeserializeOwned;

    use super::{AccountStore, AccountStoreError, SharedAccountStore, SqlValue, apply_schema};

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
                Self::Null => ToSqlOutput::Borrowed(ValueRef::Null),
                Self::Integer(value) => ToSqlOutput::Borrowed(ValueRef::Integer(*value)),
                Self::Text(value) => ToSqlOutput::Borrowed(ValueRef::Text(value.as_bytes())),
                Self::Blob(value) => ToSqlOutput::Borrowed(ValueRef::Blob(value)),
            })
        }
    }

    impl AccountStore for Connection {
        fn run_script(&self, script: &str) -> Result<(), AccountStoreError> {
            self.execute_batch(script)?;
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

        fn write_step<R, E: From<AccountStoreError>>(
            &self,
            step: impl FnOnce(&Self) -> Result<R, E>,
        ) -> Result<R, E> {
            let transaction = self
                .unchecked_transaction()
                .map_err(AccountStoreError::from)?;
            // Dropping the transaction on `Err` rolls it back.
            let outcome = step(&transaction)?;
            transaction.commit().map_err(AccountStoreError::from)?;
            Ok(outcome)
        }
    }

    impl SharedAccountStore for Arc<Mutex<Connection>> {
        type Store = Connection;

        fn run_step<R, E, F>(&self, step: F) -> impl Future<Output = Result<R, E>> + Send
        where
            R: Send + 'static,
            E: From<AccountStoreError> + Send + 'static,
            F: FnOnce(&Connection) -> Result<R, E> + Send + 'static,
        {
            let file = Arc::clone(self);
            async move {
                tokio::task::spawn_blocking(move || {
                    // A step that panicked rolled its transaction back as it unwound, so the file
                    // is whole.
                    let connection = file.lock().unwrap_or_else(PoisonError::into_inner);
                    connection.write_step(step)
                })
                .await
                .map_err(AccountStoreError::from)?
            }
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
pub(crate) use object::AccountObjectStore;

#[cfg(target_arch = "wasm32")]
mod object {
    //! The Workers relay's account store: the account object's SQLite storage. A step runs in the
    //! storage's `transactionSync`, a savepoint rolled back when the step throws; writes left to
    //! the object's own coalescing would commit on the next turn whatever the step answered.

    use std::future::Future;

    use serde::de::DeserializeOwned;
    use worker::send::SendWrapper;
    use worker::wasm_bindgen::JsCast;
    use worker::wasm_bindgen::prelude::*;
    use worker::{SqlStorage, SqlStorageValue, Storage};

    use super::{AccountStore, AccountStoreError, SharedAccountStore, SqlValue};

    #[wasm_bindgen]
    extern "C" {
        /// The object's `DurableObjectStorage`, read for the one call `worker` does not bind.
        #[derive(Clone)]
        type TransactionalStorage;

        /// Runs `step` in a savepoint: released when it returns, rolled back when it throws.
        #[wasm_bindgen(method, catch, js_name = transactionSync)]
        fn transaction_sync(
            this: &TransactionalStorage,
            step: &mut dyn FnMut() -> Result<JsValue, JsValue>,
        ) -> Result<JsValue, JsValue>;
    }

    /// The account object's store: its SQL storage, and the storage handle its steps run in.
    #[derive(Clone)]
    pub(crate) struct AccountObjectStore {
        sql: SqlStorage,
        storage: SendWrapper<TransactionalStorage>,
    }

    impl AccountObjectStore {
        /// The store over `storage`, the account object's own.
        pub(crate) fn new(storage: &Storage) -> Self {
            Self {
                sql: storage.sql(),
                storage: SendWrapper::new(
                    storage
                        .as_raw()
                        .unchecked_ref::<TransactionalStorage>()
                        .clone(),
                ),
            }
        }
    }

    impl SharedAccountStore for AccountObjectStore {
        type Store = Self;

        fn run_step<R, E, F>(&self, step: F) -> impl Future<Output = Result<R, E>> + Send
        where
            R: Send + 'static,
            E: From<AccountStoreError> + Send + 'static,
            F: FnOnce(&Self) -> Result<R, E> + Send + 'static,
        {
            // The object runs one request's step at a time on its one thread.
            std::future::ready(self.write_step(step))
        }
    }

    fn convert_to_storage_values(parameters: &[SqlValue]) -> Vec<SqlStorageValue> {
        parameters
            .iter()
            .map(|parameter| match parameter {
                SqlValue::Null => SqlStorageValue::Null,
                SqlValue::Integer(value) => SqlStorageValue::Integer(*value),
                SqlValue::Text(value) => SqlStorageValue::String(value.clone()),
                SqlValue::Blob(value) => SqlStorageValue::Blob(value.clone()),
            })
            .collect()
    }

    impl AccountStore for AccountObjectStore {
        fn run_script(&self, script: &str) -> Result<(), AccountStoreError> {
            self.sql.exec(script, None)?;
            Ok(())
        }

        fn execute(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<(), AccountStoreError> {
            self.sql
                .exec(statement, convert_to_storage_values(parameters))?;
            Ok(())
        }

        fn query<T: DeserializeOwned>(
            &self,
            statement: &str,
            parameters: &[SqlValue],
        ) -> Result<Vec<T>, AccountStoreError> {
            Ok(self
                .sql
                .exec(statement, convert_to_storage_values(parameters))?
                .to_array()?)
        }

        fn write_step<R, E: From<AccountStoreError>>(
            &self,
            step: impl FnOnce(&Self) -> Result<R, E>,
        ) -> Result<R, E> {
            let mut step = Some(step);
            let mut outcome = None;
            let ran = self.storage.transaction_sync(&mut || {
                let Some(step) = step.take() else {
                    return Err(JsValue::from_str("the step was already run"));
                };
                let result = step(self);
                let is_failed = result.is_err();
                outcome = Some(result);
                // A throw rolls the savepoint back; the step's own error is kept in `outcome`.
                if is_failed {
                    Err(JsValue::from_str("the step failed"))
                } else {
                    Ok(JsValue::UNDEFINED)
                }
            });
            match (outcome, ran) {
                (Some(Err(error)), _) => Err(error),
                (Some(Ok(value)), Ok(_)) => Ok(value),
                (Some(Ok(_)) | None, Err(thrown)) => {
                    Err(AccountStoreError::Object(worker::Error::from(thrown)).into())
                }
                (None, Ok(_)) => Err(AccountStoreError::Object(worker::Error::RustError(
                    "the storage returned without running the step".to_owned(),
                ))
                .into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AccountStore, AccountStoreError, SqlValue, open_account_file};

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

    #[test]
    fn a_step_that_fails_leaves_none_of_its_writes() {
        let folder = tempfile::tempdir().unwrap();
        let connection = open_account_file(&folder.path().join("account.sqlite")).unwrap();
        let failed: Result<(), AccountStoreError> = connection.write_step(|store| {
            for jti in ["first", "second"] {
                AccountStore::execute(
                    store,
                    "INSERT INTO dpop_proof_jtis (jti, expires_at) VALUES (?1, 1)",
                    &[SqlValue::Text(jti.to_owned())],
                )?;
            }
            Err(AccountStoreError::Row(serde::de::Error::custom(
                "the step refuses",
            )))
        });
        assert!(failed.is_err());
        let rows: Vec<serde_json::Value> = connection
            .query("SELECT jti FROM dpop_proof_jtis", &[])
            .unwrap();
        assert!(rows.is_empty(), "neither row was kept: {rows:?}");
    }
}

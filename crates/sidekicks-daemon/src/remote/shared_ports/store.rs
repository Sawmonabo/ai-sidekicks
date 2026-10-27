//! The shared-ports table's reads and writes: the whole list read once at start in the order the
//! ports were added, and each change written before memory follows it.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::Port;

use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// The statements the shared ports read through the read pool, for the pool's statement cache.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start adds it to the read pool's statement cache"
    )
)]
pub(crate) const SHARED_PORTS_STATEMENT_CAPACITY: usize = 1;

const SELECT_SHARED_PORTS_SQL: &str = "SELECT port, added_at FROM shared_ports ORDER BY added_at";

const INSERT_SHARED_PORT_SQL: &str =
    "INSERT INTO shared_ports (port, added_at) VALUES (@port, @addedAt)";

const DELETE_SHARED_PORT_SQL: &str = "DELETE FROM shared_ports WHERE port = @port";

const DELETE_EVERY_SHARED_PORT_SQL: &str = "DELETE FROM shared_ports";

/// One stored row: a shared port and when it was shared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredSharedPort {
    /// The port.
    pub(crate) port: Port,
    /// When it was shared.
    pub(crate) added_at: WireInstant,
}

/// Why the stored list could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SharedPortsReadError {
    /// SQLite refused the read.
    #[error("the shared ports could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A stored port is no port number.
    #[error("a stored shared port, {0}, is not a port number")]
    StoredPort(i64),
    /// A stored instant is no instant.
    #[error("a stored shared port's time is not an instant")]
    StoredAddedAt(#[source] NotAnInstant),
}

/// Every stored shared port, in the order they were added. Fails with [`SharedPortsReadError`]
/// when the read fails or a stored row does not parse.
pub(crate) async fn read_shared_ports(
    reads: &DatabaseReadPool,
) -> Result<Vec<StoredSharedPort>, SharedPortsReadError> {
    let rows = reads
        .read(ReadLength::Short, |connection| {
            let mut statement = connection.prepare_cached(SELECT_SHARED_PORTS_SQL)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, SharedPortsReadError>(rows)
        })
        .await?;
    rows.into_iter()
        .map(|(port, added_at)| {
            Ok(StoredSharedPort {
                port: u16::try_from(port)
                    .ok()
                    .and_then(Port::new)
                    .ok_or(SharedPortsReadError::StoredPort(port))?,
                added_at: WireInstant::try_from(added_at)
                    .map_err(SharedPortsReadError::StoredAddedAt)?,
            })
        })
        .collect()
}

/// Stores `port` as shared at `added_at`. Fails as [`DatabaseWriter::write`] does, refused when
/// the port is stored already.
pub(crate) async fn insert_shared_port(
    writer: &DatabaseWriter,
    port: Port,
    added_at: &WireInstant,
) -> Result<(), WriteError> {
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(INSERT_SHARED_PORT_SQL),
            bindings: StatementBindings::Named(vec![
                port_binding(port),
                text_binding("@addedAt", added_at.as_str()),
            ]),
            expected_row_count: Some(1),
        }])
        .await?;
    Ok(())
}

/// Removes `port`'s row. Fails as [`DatabaseWriter::write`] does, refused when no row holds it.
pub(crate) async fn delete_shared_port(
    writer: &DatabaseWriter,
    port: Port,
) -> Result<(), WriteError> {
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(DELETE_SHARED_PORT_SQL),
            bindings: StatementBindings::Named(vec![port_binding(port)]),
            expected_row_count: Some(1),
        }])
        .await?;
    Ok(())
}

/// Removes every row. Fails as [`DatabaseWriter::write`] does.
pub(crate) async fn delete_every_shared_port(writer: &DatabaseWriter) -> Result<(), WriteError> {
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(DELETE_EVERY_SHARED_PORT_SQL),
            bindings: StatementBindings::None,
            expected_row_count: None,
        }])
        .await?;
    Ok(())
}

fn port_binding(port: Port) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed("@port"),
        Value::Integer(i64::from(port.get())),
    )
}

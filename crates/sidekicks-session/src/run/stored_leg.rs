//! A session's stored leg, the newest binding of its runs with a conversation to resume, and every
//! binding of its runs, read by session id with no live record.

use rusqlite::Connection;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingStoreError, read_bindings_of_runs,
    read_newest_resumable_binding_of_runs,
};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use crate::run::ids::read_session_run_ids;

/// The session's leg, its newest binding with a conversation to resume, by when each was recorded
/// and then by id, read through `pool`: the account it runs on and the handle of its conversation,
/// at rest as live; `None` for a session that never ran. Fails as the pool or SQLite fails, or a
/// stored row does not read.
pub async fn read_session_leg(
    pool: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Option<RuntimeBinding>, RuntimeBindingStoreError> {
    pool.read(ReadLength::Short, move |reader| {
        Ok(read_newest_resumable_binding_of_runs(
            reader,
            &read_session_run_ids(reader, &session_id)?,
        )?)
    })
    .await
}

/// Every binding of the session's runs, superseded ones included, read on `reader`, inside the
/// caller's snapshot where it holds one. Fails as SQLite fails or a stored row does not read.
pub(crate) fn read_session_bindings(
    reader: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<RuntimeBinding>> {
    read_bindings_of_runs(reader, &read_session_run_ids(reader, &session_id)?)
}

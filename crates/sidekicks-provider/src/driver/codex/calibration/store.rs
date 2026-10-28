//! The measured compaction limits in the `compaction_calibrations` table, keyed by Codex's version,
//! the model and the window, so a limit is measured once per build and kept across restarts.

use std::error::Error;
use std::num::TryFromIntError;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::driver::codex::DESCRIPTOR;

/// What one stored limit is measured for: a Codex build, a model and a window.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct CodexMeasuredWindow {
    /// Codex's version as it printed it.
    pub(super) provider_version: String,
    /// The model.
    pub(super) model_id: String,
    /// The model's whole window the limit was measured on, in tokens.
    pub(super) window_tokens: u64,
}

const SELECT_LIMIT_SQL: &str = "
  SELECT compaction_limit_tokens
    FROM compaction_calibrations
   WHERE provider = ?1 AND provider_version = ?2 AND model_id = ?3 AND window_tokens = ?4";

// A new measurement of one build, model and window replaces the one before it.
const UPSERT_LIMIT_SQL: &str = "
  INSERT INTO compaction_calibrations (provider, provider_version, model_id, window_tokens,
                                       compaction_limit_tokens, measured_at)
  VALUES (@provider, @provider_version, @model_id, @window_tokens, @compaction_limit_tokens,
          @measured_at)
  ON CONFLICT(provider, provider_version, model_id, window_tokens)
    DO UPDATE SET compaction_limit_tokens = excluded.compaction_limit_tokens,
                  measured_at             = excluded.measured_at";

/// Why the stored limit could not be read.
#[derive(Debug, thiserror::Error)]
pub(super) enum StoredLimitReadError {
    /// No connection could read.
    #[error("the stored compaction limit could not be read")]
    Read(#[from] DatabaseReadError),
    /// The query failed.
    #[error("the stored compaction limit could not be queried")]
    Query(#[from] rusqlite::Error),
    /// A count is past SQLite's integer range, or a stored one below zero.
    #[error("a compaction count is outside the stored range")]
    OutOfRange(#[from] TryFromIntError),
}

/// The limit stored for `measured`, `None` when none was. Fails as the read does.
pub(super) async fn read_stored_codex_limit(
    reads: &DatabaseReadPool,
    measured: &CodexMeasuredWindow,
) -> Result<Option<u64>, StoredLimitReadError> {
    let measured = measured.clone();
    let window_tokens = i64::try_from(measured.window_tokens)?;
    reads
        .read(ReadLength::Short, move |connection| {
            query_stored_limit(connection, &measured, window_tokens)
        })
        .await
}

fn query_stored_limit(
    connection: &Connection,
    measured: &CodexMeasuredWindow,
    window_tokens: i64,
) -> Result<Option<u64>, StoredLimitReadError> {
    let mut statement = connection.prepare_cached(SELECT_LIMIT_SQL)?;
    let limit = statement
        .query_row(
            (
                DESCRIPTOR.id,
                &measured.provider_version,
                &measured.model_id,
                window_tokens,
            ),
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(limit.map(u64::try_from).transpose()?)
}

/// Stores `limit_tokens` as the limit measured now for `measured`, replacing one stored before.
/// Fails as the write does.
pub(super) async fn store_codex_limit(
    writer: &DatabaseWriter,
    measured: &CodexMeasuredWindow,
    limit_tokens: u64,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let statement = WriteStatement {
        sql: UPSERT_LIMIT_SQL.into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider", DESCRIPTOR.id),
            text_binding("@provider_version", &measured.provider_version),
            text_binding("@model_id", &measured.model_id),
            (
                "@window_tokens".into(),
                Value::Integer(i64::try_from(measured.window_tokens)?),
            ),
            (
                "@compaction_limit_tokens".into(),
                Value::Integer(i64::try_from(limit_tokens)?),
            ),
            text_binding("@measured_at", WireInstant::now().as_str()),
        ]),
        expected_row_count: Some(1),
    };
    writer.write(vec![statement]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{CodexMeasuredWindow, read_stored_codex_limit, store_codex_limit};
    use crate::driver::schema::schema_parts;

    /// The read pool's statement cache: the one select.
    const STATEMENT_CAPACITY: usize = 1;

    fn measured(version: &str, model: &str, window_tokens: u64) -> CodexMeasuredWindow {
        CodexMeasuredWindow {
            provider_version: version.to_owned(),
            model_id: model.to_owned(),
            window_tokens,
        }
    }

    // A limit is read back only for the version, model and window it was measured for, and a new
    // measurement of the same three replaces it.
    #[tokio::test]
    async fn reads_a_limit_back_only_for_its_own_version_model_and_window() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let reads = Arc::new(DatabaseReadPool::new(database.path(), STATEMENT_CAPACITY));
        let stored = measured("codex-cli 0.163.0", "gpt-5.5", 272_000);
        store_codex_limit(&writer, &stored, 244_800)
            .await
            .expect("the limit is stored");

        for other in [
            measured("codex-cli 0.164.0", "gpt-5.5", 272_000),
            measured("codex-cli 0.163.0", "gpt-5.4", 272_000),
            measured("codex-cli 0.163.0", "gpt-5.5", 1_000_000),
        ] {
            let read = read_stored_codex_limit(&reads, &other)
                .await
                .expect("the limit is read");
            assert_eq!(read, None, "no limit was measured for {other:?}");
        }
        store_codex_limit(&writer, &stored, 230_000)
            .await
            .expect("a new measurement replaces the old");
        let read = read_stored_codex_limit(&reads, &stored)
            .await
            .expect("the limit is read");
        assert_eq!(read, Some(230_000));
    }
}

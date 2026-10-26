//! A session's own console settings, over the `session_console_state` table: the advisor a session
//! on a provider that offers an advisor keeps from its creation or, where no one picked one, from
//! what the provider resolved at its first start, changed only by the session's advisor command;
//! the Build or Plan mode the provider last took; and the session's own bound on the steps one
//! turn may take. Every process the daemon starts for the session reads the advisor at launch, a
//! restart resumes in the mode, and `session.read` answers with the step bound.

use std::borrow::Cow;
use std::error::Error;

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, safe_int_column, text_column};
use crate::database::writer::DatabaseWriter;
use crate::provider::port::session_advisor_store::ClaudeSessionAdvisorStore;
use crate::session::directory::lookups::write_while_session_exists;

/// The row a session on a provider that offers an advisor is born with when the person picked its
/// advisor: a model, or `NULL` for off. Never written for an unpicked session, whose advisor the
/// provider resolves at its first start. It binds the session id, the advisor and the time, in
/// that order.
pub(crate) const INSERT_CONSOLE_STATE_SQL: &str = "INSERT INTO session_console_state
  (session_id, advisor_model, advisor_set, updated_at) VALUES (?, ?, 1, ?)";

// A session born on a provider without an advisor has no row until its first change needs one.
const UPSERT_ADVISOR_MODEL_SQL: &str = "INSERT INTO session_console_state
  (session_id, advisor_model, advisor_set, updated_at)
  VALUES (@sessionId, @advisorModel, 1, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE SET advisor_model = excluded.advisor_model,
    advisor_set = 1, updated_at = excluded.updated_at";

// The advisor the provider resolved fills only a row whose advisor no one set.
const RECORD_RESOLVED_ADVISOR_SQL: &str = "INSERT INTO session_console_state
  (session_id, advisor_model, advisor_set, updated_at)
  VALUES (@sessionId, @advisorModel, 1, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE SET advisor_model = excluded.advisor_model,
    advisor_set = 1, updated_at = excluded.updated_at
  WHERE session_console_state.advisor_set = 0";

const UPSERT_SESSION_MODE_SQL: &str = "INSERT INTO session_console_state
  (session_id, session_mode, updated_at) VALUES (@sessionId, @sessionMode, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET session_mode = excluded.session_mode, updated_at = excluded.updated_at";

/// The statement storing the advisor the session's advisor command set, `None` for off,
/// committed in its event's own write.
pub(crate) fn advisor_model_change_statement(
    session_id: &SessionId,
    advisor_model: Option<&str>,
    updated_at: &str,
) -> WriteStatement {
    advisor_statement(
        UPSERT_ADVISOR_MODEL_SQL,
        session_id,
        advisor_model,
        updated_at,
    )
}

fn advisor_statement(
    sql: &'static str,
    session_id: &SessionId,
    advisor_model: Option<&str>,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            nullable_text_binding("@advisorModel", advisor_model),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

/// The session's own advisor: `None` when the session's advisor was never set, `Some(None)` when it
/// is off. Fails when the read fails.
#[expect(
    clippy::option_option,
    reason = "a session with no advisor of its own differs from one whose advisor is off"
)]
pub(crate) fn read_session_advisor_model(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<Option<String>>> {
    reader
        .prepare_cached(
            "SELECT advisor_model FROM session_console_state
  WHERE session_id = ? AND advisor_set = 1",
        )?
        .query_row([session_id.text().as_str()], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
}

impl ClaudeSessionAdvisorStore for DatabaseWriter {
    /// Keeps the resolved advisor while the session has a directory row, so a purged session gains
    /// no row; fails with `session.notFound` for one without.
    fn record_resolved(
        &self,
        session_id: SessionId,
        advisor_model: Option<String>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let statement = advisor_statement(
                RECORD_RESOLVED_ADVISOR_SQL,
                &session_id,
                advisor_model.as_deref(),
                WireInstant::now().as_str(),
            );
            write_while_session_exists(self, &session_id, statement).await?;
            Ok(())
        }
        .boxed()
    }
}

/// The statement storing the mode a `session.mode.update` moved the provider to.
pub(crate) fn session_mode_change_statement(
    session_id: &SessionId,
    session_mode: SessionMode,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_SESSION_MODE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@sessionMode", <&'static str>::from(session_mode)),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

/// The mode the session was last moved to, Build for a session never moved. Fails when the read
/// fails or the stored text names no mode.
pub(crate) fn read_session_mode(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<SessionMode> {
    let session_mode = reader
        .prepare_cached("SELECT session_mode FROM session_console_state WHERE session_id = ?")?
        .query_row([session_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()?;
    Ok(session_mode.unwrap_or(SessionMode::Build))
}

/// The session's own bound on the steps one turn may take, `None` where the person set none or the
/// session has no row. Fails when the read fails, and with
/// `rusqlite::Error::FromSqlConversionFailure`, naming the value, for a stored bound outside 1 to
/// 2^53 − 1.
pub(crate) fn read_session_max_steps_per_turn(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<SafeInt<1>>> {
    let max_steps_per_turn = reader
        .prepare_cached(
            "SELECT max_steps_per_turn FROM session_console_state WHERE session_id = ?",
        )?
        .query_row([session_id.text().as_str()], |row| {
            if row.get_ref(0)?.data_type() == Type::Null {
                Ok(None)
            } else {
                safe_int_column::<1>(row, 0).map(Some)
            }
        })
        .optional()?;
    Ok(max_steps_per_turn.flatten())
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::session::controls::methods::SessionMode;

    use super::{
        advisor_model_change_statement, read_session_advisor_model, session_mode_change_statement,
    };
    use crate::database::schema::session_directory::insert_session_row;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use crate::provider::port::session_advisor_store::ClaudeSessionAdvisorStore;
    use crate::questions::schema::schema_parts;

    const AT: &str = "2026-10-23T12:00:00.000Z";

    // Killed by a read that takes a row the mode made for an advisor set off, and by a resolved
    // advisor that overwrites the one the person set off.
    #[tokio::test]
    async fn a_resolved_advisor_fills_only_an_advisor_no_one_set() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens");
        let reader = database.reader();
        let (moved, off) = (test_session_id(), test_session_id());
        for session_id in [&moved, &off] {
            insert_session_row(&reader, session_id.text().as_str(), None, None);
        }
        writer
            .write(vec![
                session_mode_change_statement(&moved, SessionMode::Plan, AT),
                advisor_model_change_statement(&off, None, AT),
            ])
            .await
            .expect("the rows are written");
        let read = |session_id| {
            read_session_advisor_model(&reader, session_id).expect("the advisor reads")
        };
        assert_eq!(read(&moved), None);

        for session_id in [moved, off] {
            writer
                .record_resolved(session_id, Some("opus".to_owned()))
                .await
                .expect("the resolved advisor is recorded");
        }

        assert_eq!(read(&moved), Some(Some("opus".to_owned())));
        assert_eq!(read(&off), Some(None));
    }
}

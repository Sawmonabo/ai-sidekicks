//! A session's own console settings, over the `session_console_state` table: the advisor a session
//! on a provider that offers an advisor keeps from its creation or, where no one picked one, from
//! what the provider resolved at its first start, changed only by the session's advisor command;
//! the Build or Plan mode the session was last moved to; the session's own bound on the steps one
//! turn may take; and the `Auto memory` switch, unset until the person first sets it. Every process
//! the daemon starts for the session reads the advisor at launch, opens in the mode and, once the
//! switch is set, carries it, and `session.read` answers with the step bound.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::types::{Type, Value};
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::port::session_advisor_store::SessionAdvisorStore;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, safe_int_column, text_column};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::directory::lookups::write_while_session_exists;

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

const UPSERT_MAX_STEPS_PER_TURN_SQL: &str = "INSERT INTO session_console_state
  (session_id, max_steps_per_turn, updated_at) VALUES (@sessionId, @maxStepsPerTurn, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET max_steps_per_turn = excluded.max_steps_per_turn, updated_at = excluded.updated_at";

const UPSERT_AUTO_MEMORY_SQL: &str = "INSERT INTO session_console_state
  (session_id, auto_memory, updated_at) VALUES (@sessionId, @autoMemory, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET auto_memory = excluded.auto_memory, updated_at = excluded.updated_at";

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

/// The advisors a provider resolved, kept on each session's console state through the database
/// writer.
pub struct ConsoleStateAdvisors(pub Arc<DatabaseWriter>);

impl SessionAdvisorStore for ConsoleStateAdvisors {
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
            write_while_session_exists(&self.0, &session_id, statement).await?;
            Ok(())
        }
        .boxed()
    }
}

/// The statement storing the mode a `session.mode.update` moved the session to, which its next
/// process opens in.
pub fn session_mode_change_statement(
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

/// The statement storing the session's own bound on the steps one turn may take, `None` clearing
/// it so the machine's own value applies, read from the session's next turn.
pub fn max_steps_per_turn_change_statement(
    session_id: &SessionId,
    max_steps_per_turn: Option<SafeInt<1>>,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_MAX_STEPS_PER_TURN_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            (
                Cow::Borrowed("@maxStepsPerTurn"),
                max_steps_per_turn.map_or(Value::Null, |bound| Value::Integer(bound.into())),
            ),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

/// The statement storing the session's own `Auto memory` switch, on or off, committed in the
/// caller's own write; nothing sets the switch back to unset.
pub fn auto_memory_change_statement(
    session_id: &SessionId,
    is_enabled: bool,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_AUTO_MEMORY_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            (
                Cow::Borrowed("@autoMemory"),
                Value::Integer(i64::from(is_enabled)),
            ),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

/// The mode the session was last moved to, Build for a session never moved. Fails when the read
/// fails or the stored text names no mode.
pub fn read_session_mode(
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
pub fn read_session_max_steps_per_turn(
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

/// The session's own `Auto memory` switch, `None` where it was never set, so nothing is sent and
/// the provider's own settings decide. Fails when the read fails.
pub fn read_session_auto_memory(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<bool>> {
    let auto_memory = reader
        .prepare_cached("SELECT auto_memory FROM session_console_state WHERE session_id = ?")?
        .query_row([session_id.text().as_str()], |row| {
            row.get::<_, Option<bool>>(0)
        })
        .optional()?;
    Ok(auto_memory.flatten())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::session::controls::methods::SessionMode;
    use sidekicks_provider::port::session_advisor_store::SessionAdvisorStore;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{
        ConsoleStateAdvisors, advisor_model_change_statement, auto_memory_change_statement,
        read_session_advisor_model, read_session_auto_memory, read_session_mode,
        session_mode_change_statement,
    };
    use crate::questions::schema::schema_parts;

    const AT: &str = "2026-10-23T12:00:00.000Z";

    async fn open_writer(database: &TestDatabase) -> Arc<DatabaseWriter> {
        Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens"),
        )
    }

    // Killed by a read that takes a row the mode made for an advisor set off, and by a resolved
    // advisor that overwrites the one the person set off.
    #[tokio::test]
    async fn a_resolved_advisor_fills_only_an_advisor_no_one_set() {
        let database = TestDatabase::new(schema_parts());
        let writer = open_writer(&database).await;
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
            ConsoleStateAdvisors(Arc::clone(&writer))
                .record_resolved(session_id, Some("opus".to_owned()))
                .await
                .expect("the resolved advisor is recorded");
        }

        assert_eq!(read(&moved), Some(Some("opus".to_owned())));
        assert_eq!(read(&off), Some(None));
    }

    // Killed by an insert that replaces the row or an update that sets more than the switch (the
    // mode reads Build and the advisor none), by `advisor_set = 1` in the switch's insert, by doing
    // nothing on conflict, by an update with no insert, by an unset switch read as off, and by a
    // flipped bind.
    #[tokio::test]
    async fn the_switch_keeps_the_rows_other_settings_and_reads_unset_until_set() {
        let database = TestDatabase::new(schema_parts());
        let writer = open_writer(&database).await;
        let reader = database.reader();
        let (set_up, bare) = (test_session_id(), test_session_id());
        let read =
            |session_id| read_session_auto_memory(&reader, session_id).expect("the switch reads");

        writer
            .write(vec![
                session_mode_change_statement(&set_up, SessionMode::Plan, AT),
                advisor_model_change_statement(&set_up, Some("opus"), AT),
            ])
            .await
            .expect("the other settings are written");
        assert_eq!(read(&set_up), None);
        assert_eq!(read(&bare), None);

        writer
            .write(vec![
                auto_memory_change_statement(&set_up, false, AT),
                auto_memory_change_statement(&bare, true, AT),
            ])
            .await
            .expect("the switches are written");
        assert_eq!(read(&set_up), Some(false));
        assert_eq!(read(&bare), Some(true));
        assert_eq!(
            read_session_mode(&reader, &set_up).expect("the mode reads"),
            SessionMode::Plan
        );
        assert_eq!(
            read_session_advisor_model(&reader, &set_up).expect("the advisor reads"),
            Some(Some("opus".to_owned()))
        );
        assert_eq!(
            read_session_advisor_model(&reader, &bare).expect("the advisor reads"),
            None
        );

        writer
            .write(vec![auto_memory_change_statement(&set_up, true, AT)])
            .await
            .expect("the switch is turned on");
        assert_eq!(read(&set_up), Some(true));
    }
}

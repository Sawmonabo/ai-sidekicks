//! A session's limits as its budget row holds them: the upsert that sets both, the read of the
//! row, and the `Tokens per run` a new run of the session is admitted with.

use std::borrow::Cow;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _};
use sidekicks_contracts::session::cost::{TokensPerRun, UsdMicros};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::optional_safe_int_column;

const UPSERT_LIMITS_SQL: &str = "INSERT INTO session_budgets
  (session_id, spend_limit_usd_micros, tokens_per_run, updated_at)
  VALUES (@sessionId, @spendLimit, @tokensPerRun, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE SET
    spend_limit_usd_micros = excluded.spend_limit_usd_micros,
    tokens_per_run = excluded.tokens_per_run,
    updated_at = excluded.updated_at";

const READ_LIMITS_SQL: &str =
    "SELECT spend_limit_usd_micros, tokens_per_run FROM session_budgets WHERE session_id = ?1";

/// A session's two limits as its row holds them; `None` is `Unlimited`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionLimits {
    /// The spend limit across every provider and account the session uses.
    pub spend_limit: Option<UsdMicros>,
    /// The `Tokens per run` limit.
    pub tokens_per_run: Option<TokensPerRun>,
}

/// The write that sets `session_id`'s limits to `limits` at `updated_at`, creating its row or
/// replacing the one it has.
pub fn write_session_limits(
    session_id: SessionId,
    limits: SessionLimits,
    updated_at: &WireInstant,
) -> WriteStatement {
    let integer = |value: Option<u64>| {
        value.map_or(Value::Null, |value| {
            Value::Integer(i64::try_from(value).expect("a safe integer fits an i64"))
        })
    };
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_LIMITS_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            (
                Cow::Borrowed("@spendLimit"),
                integer(limits.spend_limit.map(|limit| limit.0.get())),
            ),
            (
                Cow::Borrowed("@tokensPerRun"),
                integer(limits.tokens_per_run.map(|tokens| tokens.0.get())),
            ),
            text_binding("@updatedAt", updated_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// `session_id`'s limits, `None` while it has no row. Fails as the read fails or a stored limit
/// is below its floor or past a safe integer.
pub fn read_session_limits(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Option<SessionLimits>> {
    connection
        .prepare_cached(READ_LIMITS_SQL)?
        .query_row([session_id.text().as_str()], |row| {
            Ok(SessionLimits {
                spend_limit: optional_safe_int_column(row, 0)?.map(UsdMicros),
                tokens_per_run: optional_safe_int_column(row, 1)?.map(TokensPerRun),
            })
        })
        .optional()
}

/// The `Tokens per run` a new run of `session_id` is admitted with: its row's, `Unlimited` among
/// them, when it has one, else `configuration_default`. Fails as [`read_session_limits`] fails.
pub fn effective_tokens_per_run(
    connection: &Connection,
    session_id: SessionId,
    configuration_default: Option<TokensPerRun>,
) -> rusqlite::Result<Option<TokensPerRun>> {
    Ok(read_session_limits(connection, session_id)?
        .map_or(configuration_default, |limits| limits.tokens_per_run))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::cost::{TokensPerRun, UsdMicros};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{
        SessionLimits, effective_tokens_per_run, read_session_limits, write_session_limits,
    };
    use crate::budget::schema::schema_parts;

    // A database holding the budget table, opened by its writer.
    async fn open_budgets() -> (TestDatabase, DatabaseWriter) {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        (database, writer)
    }

    async fn write(writer: &DatabaseWriter, session_id: SessionId, limits: SessionLimits) {
        writer
            .write(vec![write_session_limits(
                session_id,
                limits,
                &WireInstant::now(),
            )])
            .await
            .expect("the limits are written");
    }

    fn tokens(count: u64) -> TokensPerRun {
        TokensPerRun(SafeInt::new(count).expect("the test's limit is a safe integer"))
    }

    fn limits(spend: Option<u64>, tokens_per_run: Option<u64>) -> SessionLimits {
        SessionLimits {
            spend_limit: spend.map(|spend| UsdMicros(SafeInt::new(spend).expect("a safe integer"))),
            tokens_per_run: tokens_per_run.map(tokens),
        }
    }

    // Killed by the upsert's `DO UPDATE` dropped: the second write then fails on the key, or,
    // written `DO NOTHING`, leaves the first limits in place.
    #[tokio::test]
    async fn a_write_round_trips_and_a_second_write_replaces_the_row() {
        let (database, writer) = open_budgets().await;
        let session_id = test_session_id();
        let first = limits(Some(2_500_000), Some(40_000));
        write(&writer, session_id, first).await;
        assert_eq!(
            read_session_limits(&database.reader(), session_id).expect("the row reads"),
            Some(first)
        );

        let second = limits(None, Some(1));
        write(&writer, session_id, second).await;
        let reader = database.reader();
        assert_eq!(
            read_session_limits(&reader, session_id).expect("the row reads"),
            Some(second)
        );
        let rows: i64 = reader
            .query_row("SELECT count(*) FROM session_budgets", [], |row| row.get(0))
            .expect("the rows count");
        assert_eq!(rows, 1);
    }

    // Killed by either CHECK dropped: its refused value is then kept.
    #[rstest]
    #[case::negative_spend("-1", "NULL", false)]
    #[case::zero_tokens("NULL", "0", false)]
    #[case::both_unlimited("NULL", "NULL", true)]
    #[case::both_at_their_floors("0", "1", true)]
    #[tokio::test]
    async fn the_limits_hold_their_floors_and_take_unlimited(
        #[case] spend: &str,
        #[case] tokens_per_run: &str,
        #[case] is_kept: bool,
    ) {
        let (database, _writer) = open_budgets().await;
        let inserted = database.reader().execute(
            &format!(
                "INSERT INTO session_budgets
               (session_id, spend_limit_usd_micros, tokens_per_run, updated_at)
             VALUES ('{}', {spend}, {tokens_per_run}, '{}')",
                test_session_id(),
                WireInstant::now().as_str()
            ),
            [],
        );
        assert_eq!(inserted.is_ok(), is_kept, "{inserted:?}");
    }

    // Killed by the fallback order swapped: the configuration's value then wins over the row's.
    #[tokio::test]
    async fn a_session_row_answers_over_the_configuration() {
        let (database, writer) = open_budgets().await;
        let configured = Some(tokens(500_000));
        let [limited, unlimited, unset] = [(); 3].map(|()| test_session_id());
        write(&writer, limited, limits(None, Some(40_000))).await;
        write(&writer, unlimited, limits(Some(0), None)).await;
        let reader = database.reader();
        let effective = |session_id| {
            effective_tokens_per_run(&reader, session_id, configured).expect("the row reads")
        };
        assert_eq!(effective(limited), Some(tokens(40_000)));
        assert_eq!(effective(unlimited), None);
        assert_eq!(effective(unset), configured);
    }
}

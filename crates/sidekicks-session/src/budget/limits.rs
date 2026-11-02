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
mod tests;

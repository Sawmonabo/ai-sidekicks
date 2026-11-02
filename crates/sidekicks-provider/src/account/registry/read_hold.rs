//! An account's place on the limits read's throttle ladder, kept on its row so a restart resumes a
//! hold where it stood: how many reads in a row the provider refused, and when the latest hold
//! ends.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::{Type, Value};
use rusqlite::{OptionalExtension, Row};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, StatementResult, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::optional_text_column;

use super::ProviderAccountRegistry;
use crate::account::errors::ProviderAccountRegistryError;

const SELECT_READ_HOLD_SQL: &str = "
  SELECT read_hold_rung, read_held_until
    FROM provider_accounts
   WHERE account_id = ? AND removal_intent = 0";

// One rung up; each `@hold_<n>` is when a hold that puts the account on rung `n` ends, the last
// one standing for every rung past it. SQLite reads the old rung on both sides of the `SET`.
static CLIMB_READ_HOLD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET read_hold_rung = read_hold_rung + 1,
         read_held_until = CASE read_hold_rung
                             WHEN 0 THEN @hold_1
                             WHEN 1 THEN @hold_2
                             WHEN 2 THEN @hold_3
                             ELSE @hold_4
                           END,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING read_hold_rung, read_held_until"
    )
});

// Writes only an account that is on the ladder, so an answered read most often writes nothing.
static CLEAR_READ_HOLD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET read_hold_rung = 0, read_held_until = NULL, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id
     AND (read_hold_rung != 0 OR read_held_until IS NOT NULL)"
    )
});

/// An account's place on the limits read's throttle ladder: how many reads in a row the provider
/// refused, and when the latest hold ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadHold {
    /// 0 once a read answered, one more for each refused read since.
    pub(crate) rung: u32,
    /// When the latest hold ends; `None` until one is set.
    pub(crate) held_until: Option<WireInstant>,
}

impl ProviderAccountRegistry {
    /// `account_id`'s place on the read's throttle ladder. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed.
    pub(in crate::account) async fn read_hold(
        &self,
        account_id: ProviderAccountId,
    ) -> Result<ReadHold, ProviderAccountRegistryError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_READ_HOLD_SQL)?
                    .query_row([account_id.as_str()], read_hold)
                    .optional()?
                    .ok_or(ProviderAccountRegistryError::NotFound)
            })
            .await
    }

    /// Puts `account_id` one rung up the read's throttle ladder, held until `hold_ends[n - 1]`
    /// where `n` is its new rung, the last entry for every rung past the fourth, in one statement,
    /// and answers its new place. Fails with [`ProviderAccountRegistryError::NotFound`] for an
    /// account not registered or being removed.
    pub(in crate::account) async fn climb_read_hold(
        &self,
        account_id: &ProviderAccountId,
        hold_ends: &[WireInstant; 4],
    ) -> Result<ReadHold, ProviderAccountRegistryError> {
        let [first, second, third, fourth] = hold_ends;
        let results = self
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(CLIMB_READ_HOLD_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account_id.as_str()),
                    text_binding("@hold_1", first.as_str()),
                    text_binding("@hold_2", second.as_str()),
                    text_binding("@hold_3", third.as_str()),
                    text_binding("@hold_4", fourth.as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        returned_read_hold(&results).map_err(ProviderAccountRegistryError::Query)
    }

    /// Takes `account_id` off the read's throttle ladder, a write only where it was on it. An
    /// account not registered is left as it is. Fails when the write is not kept.
    pub(in crate::account) async fn clear_read_hold(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<(), ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_READ_HOLD_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@account_id",
                account_id.as_str(),
            )]),
            expected_row_count: None,
        }])
        .await?;
        Ok(())
    }
}

// The ladder place the write's one statement returned.
fn returned_read_hold(results: &[StatementResult]) -> rusqlite::Result<ReadHold> {
    let row = results.first().and_then(|result| result.rows.first());
    match row.map(Vec::as_slice) {
        Some([Value::Integer(rung), held_until]) => Ok(ReadHold {
            rung: u32::try_from(*rung).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Integer, Box::new(error))
            })?,
            held_until: match held_until {
                Value::Text(text) => {
                    Some(WireInstant::try_from(text.clone()).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
                    })?)
                }
                Value::Null => None,
                other @ (Value::Integer(_) | Value::Real(_) | Value::Blob(_)) => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        1,
                        other.data_type(),
                        "the stored hold end is no text".into(),
                    ));
                }
            },
        }),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            Type::Null,
            "the stored ladder place is not a rung and a hold end".into(),
        )),
    }
}

fn read_hold(row: &Row<'_>) -> rusqlite::Result<ReadHold> {
    Ok(ReadHold {
        rung: row.get(0)?,
        held_until: optional_text_column(row, 1, WireInstant::try_from)?,
    })
}

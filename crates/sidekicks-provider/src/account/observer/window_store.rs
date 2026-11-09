//! The newest quota reading of each account's windows, one row per account, limit and window
//! length in `provider_account_usage_windows`, projected from the `usage.rateLimit.updated` events
//! the machine's sentinel session holds, each read when its event occurred. A window the provider
//! sent with no length is named by its label in the length's place.
//!
//! - The later reading of a window is current; on an exact tie the account's own limits read
//!   outranks what a turn pushed.
//! - Inside one window, named by its reset, a reading with a lower share used than the stored one
//!   is dropped, since use only rises until the window resets; a reading naming another reset is
//!   a new window and stands. A reading with no reset names no window and is never dropped so.
//! - A reading from the account's own limits read carries the read's whole set, and first removes
//!   every stored window of the account the set does not name and that was read no later; what a
//!   turn pushed merges and removes nothing.
//! - A window at or below zero minutes, with neither a length nor a label, or used below zero, is
//!   no reading the table holds, and writes nothing.
//! - A reading is written only while its account is held, so a rebuild after a removal writes
//!   nothing for it, as the removal's cascade left it.
//! - `provider.account.list` reads the stored readings back, a registered account's alone, each
//!   read no earlier than the account's last limits read, which confirms a set it did not change.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::Row;
use rusqlite::types::{Type, Value};
use serde::Deserialize as _;
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventEnvelope};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::{UsageRateLimitUpdatedPayload, UsageRateLimitWindowKey};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{
    PROVIDER_QUOTA_DEFAULT_LIMIT_ID, ProviderAccountId, ProviderAccountUsageWindow,
    ProviderAccountUsageWindowSource,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::number::NonNegativeNumber;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::{StoredValueRefused, credential_generation};
use crate::account::usage_turns::credential_generation_binding;

// Each named window is a `[limitId, windowMins]` pair of the set's JSON, its label in the length's
// place where it has none, as the table's key names it.
const DELETE_UNNAMED_WINDOWS_SQL: &str = "DELETE FROM provider_account_usage_windows
 WHERE account_id = @account_id
   AND observed_at <= @observed_at
   AND NOT EXISTS (SELECT 1 FROM json_each(@whole_set) AS named
                    WHERE json_extract(named.value, '$[0]') = limit_id
                      AND json_extract(named.value, '$[1]') = IFNULL(window_mins, label))";

// The stored row is replaced by a later reading, or on a tie by the limits read over a push,
// unless both name the same reset and the newer one reads lower.
static WRITE_WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    let probe = <&'static str>::from(ProviderAccountUsageWindowSource::Probe);
    let run = <&'static str>::from(ProviderAccountUsageWindowSource::Run);
    format!(
        "INSERT INTO provider_account_usage_windows
  (account_id, limit_id, window_mins, label, used_percent, resets_at, observed_at,
   observed_credential_generation, source)
SELECT account_id, @limit_id, @window_mins, @label, @used_percent, @resets_at, @observed_at,
  @observed_credential_generation, @source
FROM provider_accounts WHERE account_id = @account_id
ON CONFLICT (account_id, limit_id, IFNULL(window_mins, label)) DO UPDATE
   SET label = excluded.label,
       used_percent = excluded.used_percent,
       resets_at = excluded.resets_at,
       observed_at = excluded.observed_at,
       observed_credential_generation = excluded.observed_credential_generation,
       source = excluded.source
 WHERE (excluded.observed_at > provider_account_usage_windows.observed_at
        OR (excluded.observed_at = provider_account_usage_windows.observed_at
            AND excluded.source = '{probe}'
            AND provider_account_usage_windows.source = '{run}'))
   AND NOT (COALESCE(excluded.resets_at = provider_account_usage_windows.resets_at, 0)
            AND excluded.used_percent < provider_account_usage_windows.used_percent)"
    )
});

// A removed account's readings go with its row, and one whose removal has begun is not read. A
// window reads as read at the account's last limits read where that came later: the read named the
// account's whole set, so a set it left unchanged was read then too.
const SELECT_USAGE_WINDOWS_SQL: &str = "
  SELECT windows.account_id, limit_id, window_mins, label, used_percent, resets_at,
         MAX(windows.observed_at, COALESCE(accounts.limits_read_at, windows.observed_at)),
         observed_credential_generation, source
    FROM provider_account_usage_windows AS windows
    JOIN provider_accounts AS accounts ON accounts.account_id = windows.account_id
   WHERE accounts.removal_intent = 0 AND (?1 IS NULL OR accounts.provider = ?1)
   ORDER BY windows.account_id, limit_id, window_mins";

// Every reading is the sentinel session's, so its rebuild clears them all.
const CLEAR_WINDOWS_SQL: &str = "DELETE FROM provider_account_usage_windows";

const USAGE_WINDOW_EVENT_TYPES: [SessionEventType; 1] = [SessionEventType::UsageRateLimitUpdated];

/// The statements that write the window of a `usage.rateLimit.updated` event in the append's own
/// write; none for any other event. Fails when the stored payload does not read as its variant,
/// which the append's own checks rule out.
pub fn usage_window_projection_statements(
    envelope: &UnsequencedEventEnvelope,
) -> Result<Vec<WriteStatement>, serde_json::Error> {
    if envelope.event_type() != SessionEventType::UsageRateLimitUpdated {
        return Ok(Vec::new());
    }
    let updated = UsageRateLimitUpdatedPayload::deserialize(envelope.payload())?;
    let mut statements = Vec::new();
    push_window_statements(envelope.occurred_at.as_str(), &updated, &mut statements);
    Ok(statements)
}

/// The `provider_account_usage_windows` rows the sentinel session's quota events leave, as a
/// rebuild replaces them. Its fold keeps no state, so the projection is its own fold.
#[derive(Clone, Copy, Debug)]
pub struct UsageWindowsProjection;

impl SessionProjection for UsageWindowsProjection {
    fn name(&self) -> &'static str {
        "providerAccountUsageWindows"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &USAGE_WINDOW_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        if *session_id != *DAEMON_SCOPE_SENTINEL_SESSION_ID {
            return Vec::new();
        }
        vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_WINDOWS_SQL),
            bindings: StatementBindings::None,
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for UsageWindowsProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        if let SessionEvent::UsageRateLimitUpdated(updated) = event {
            push_window_statements(envelope.occurred_at.as_str(), updated, statements);
        }
        Ok(())
    }
}

// Pushes the statements of one reading read at `observed_at`: the removal of what its whole set
// leaves out, then the window's own write.
fn push_window_statements(
    observed_at: &str,
    updated: &UsageRateLimitUpdatedPayload,
    statements: &mut Vec<WriteStatement>,
) {
    let account_id = updated.provider_account_id.as_str();
    if let Some(whole_set) = &updated.whole_set {
        statements.push(WriteStatement {
            sql: Cow::Borrowed(DELETE_UNNAMED_WINDOWS_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id),
                text_binding("@observed_at", observed_at),
                text_binding("@whole_set", &compose_named_windows(whole_set.as_slice())),
            ]),
            expected_row_count: None,
        });
    }
    let used_percent = updated.used_percent.get();
    let is_named = match updated.window_mins {
        Some(window_mins) => window_mins.get() > 0,
        None => updated.label.is_some(),
    };
    if !is_named || used_percent < 0.0 {
        return;
    }
    let source = if updated.whole_set.is_some() {
        ProviderAccountUsageWindowSource::Probe
    } else {
        ProviderAccountUsageWindowSource::Run
    };
    statements.push(WriteStatement {
        sql: Cow::Borrowed(WRITE_WINDOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@account_id", account_id),
            text_binding("@limit_id", limit_id(updated.limit_id.as_ref())),
            (
                Cow::Borrowed("@window_mins"),
                updated
                    .window_mins
                    .map_or(Value::Null, |window_mins| Value::Integer(window_mins.get())),
            ),
            nullable_text_binding("@label", updated.label.as_ref().map(FreeFormText::as_str)),
            (Cow::Borrowed("@used_percent"), Value::Real(used_percent)),
            nullable_text_binding(
                "@resets_at",
                updated.resets_at.as_ref().map(WireInstant::as_str),
            ),
            text_binding("@observed_at", observed_at),
            credential_generation_binding(
                "@observed_credential_generation",
                updated.credential_generation,
            ),
            text_binding("@source", <&'static str>::from(source)),
        ]),
        expected_row_count: None,
    });
}

// The set as the JSON array of `[limitId, windowMins]` pairs the removal reads, the label in the
// length's place on a window with none.
fn compose_named_windows(whole_set: &[UsageRateLimitWindowKey]) -> String {
    serde_json::Value::Array(
        whole_set
            .iter()
            .map(|key| {
                let window_name = match (key.window_mins, &key.label) {
                    (Some(window_mins), _) => serde_json::json!(window_mins.get()),
                    (None, label) => serde_json::json!(label.as_ref().map(FreeFormText::as_str)),
                };
                serde_json::json!([limit_id(key.limit_id.as_ref()), window_name])
            })
            .collect(),
    )
    .to_string()
}

// The limit a reading names, the reserved one where it names none.
fn limit_id(limit_id: Option<&BoundedText<1, EVENT_FIELD_MAX_LEN>>) -> &str {
    limit_id.map_or(PROVIDER_QUOTA_DEFAULT_LIMIT_ID, BoundedText::as_str)
}

/// Every stored quota reading of a registered account, or of `provider`'s accounts alone, in key
/// order. Fails when the readings cannot be read or a stored one does not read as its type.
pub async fn read_usage_windows(
    reads: &DatabaseReadPool,
    provider: Option<ProviderId>,
) -> Result<Vec<ProviderAccountUsageWindow>, ProviderAccountRegistryError> {
    reads
        .read(ReadLength::Short, move |connection| {
            let mut statement = connection.prepare_cached(SELECT_USAGE_WINDOWS_SQL)?;
            let windows = statement
                .query_map(
                    [provider.as_ref().map(ProviderId::as_str)],
                    read_usage_window,
                )?
                .collect::<Result<_, _>>()?;
            Ok(windows)
        })
        .await
}

fn read_usage_window(row: &Row<'_>) -> rusqlite::Result<ProviderAccountUsageWindow> {
    let window_mins: Option<i64> = row.get(2)?;
    let used_percent: f64 = row.get(4)?;
    Ok(ProviderAccountUsageWindow {
        account_id: text_column(row, 0, |text| {
            ProviderAccountId::new(text).ok_or(StoredValueRefused("account id"))
        })?,
        limit_id: text_column(row, 1, FreeFormText::new)?,
        window_mins: window_mins
            .map(|window_mins| {
                u64::try_from(window_mins)
                    .ok()
                    .and_then(SafeInt::new)
                    .ok_or_else(|| stored_refusal(2, Type::Integer, "window length"))
            })
            .transpose()?,
        label: optional_text_column(row, 3, FreeFormText::new)?,
        used_percent: NonNegativeNumber::new(used_percent)
            .ok_or_else(|| stored_refusal(4, Type::Real, "share used"))?,
        resets_at: optional_text_column(row, 5, WireInstant::try_from)?,
        observed_at: text_column(row, 6, WireInstant::try_from)?,
        observed_credential_generation: credential_generation(7, row.get(7)?)?,
        source: text_column(row, 8, closed_word)?,
    })
}

fn stored_refusal(index: usize, stored_type: Type, what: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        stored_type,
        Box::new(StoredValueRefused(what)),
    )
}

#[cfg(test)]
pub(crate) mod tests;

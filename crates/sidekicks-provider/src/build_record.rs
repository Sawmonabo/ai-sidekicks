//! The record of each provider's builds: one row per provider and build, `installed` when the
//! provider's command moved to it from an earlier build, `available` when it is a newer build the
//! provider was kept from taking. A provider's next build takes the place of its earlier rows at
//! once; an `installed` row also retires a while after it was recorded, an `available` row never on
//! a timer. Versions are compared as printed, never ordered.

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use crate::left_conversations::StoredProviderIdInvalidError;

// Reads a retired row too, so a build recorded once is never recorded again.
const SELECT_ARRIVAL_SQL: &str = "
  SELECT from_version IS NOT NULL
    FROM provider_builds
   WHERE provider_name = ? AND version = ?";

// The provider's next build takes the place of its earlier lines.
const DELETE_EARLIER_BUILDS_SQL: &str = "
  DELETE FROM provider_builds
   WHERE provider_name = @provider_name AND version <> @version";

// An `installed` build replaces an `available` row of the same build in place and lists again; an
// `available` never overwrites an `installed`, and a repeat changes nothing.
const UPSERT_BUILD_SQL: &str = "
  INSERT INTO provider_builds (provider_name, version, from_version, recorded_at, retired_at)
  VALUES (@provider_name, @version, @from_version, @recorded_at, NULL)
  ON CONFLICT (provider_name, version)
    DO UPDATE SET from_version = excluded.from_version,
                  recorded_at  = excluded.recorded_at,
                  retired_at   = NULL
     WHERE provider_builds.from_version IS NULL AND excluded.from_version IS NOT NULL";

const SELECT_LISTED_BUILDS_SQL: &str = "
  SELECT provider_name, version, from_version, recorded_at
    FROM provider_builds
   WHERE retired_at IS NULL
   ORDER BY recorded_at DESC, provider_name";

const SELECT_RETIREMENT_DUE_SQL: &str = "
  SELECT EXISTS (
    SELECT 1
      FROM provider_builds
     WHERE retired_at IS NULL AND from_version IS NOT NULL AND recorded_at < ?)";

// Only an `installed` line retires on a timer.
const RETIRE_BUILDS_SQL: &str = "
  UPDATE provider_builds
     SET retired_at = @retired_at
   WHERE retired_at IS NULL AND from_version IS NOT NULL AND recorded_at < @before";

/// The statements that tell the record's readers it changed, carried in the record's own write;
/// the daemon supplies them, since the readers live above this crate.
pub type RecordChangeStatements = dyn Fn() -> Vec<WriteStatement> + Send + Sync;

/// One build of a provider in the record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedProviderBuild {
    /// The provider.
    pub provider: ProviderId,
    /// The build, as the provider's command printed its version.
    pub version: String,
    /// The build the command moved from, as printed; `None` for a build only available.
    pub from_version: Option<String>,
    /// When the build was recorded.
    pub recorded_at: WireInstant,
}

/// How a build already in the record arrived.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordedArrival {
    /// The provider's command moved to it.
    Installed,
    /// It was recorded as available only.
    Available,
}

/// How `provider`'s build `version` is in the record, retired or not; `None` when it is not.
/// Fails when the read fails.
pub fn recorded_arrival(
    connection: &Connection,
    provider: &ProviderId,
    version: &str,
) -> rusqlite::Result<Option<RecordedArrival>> {
    connection
        .prepare_cached(SELECT_ARRIVAL_SQL)?
        .query_row([provider.as_str(), version], |row| row.get::<_, bool>(0))
        .optional()
        .map(|is_installed| {
            is_installed.map(|is_installed| {
                if is_installed {
                    RecordedArrival::Installed
                } else {
                    RecordedArrival::Available
                }
            })
        })
}

/// The write that records `build`: `change`'s statements, the removal of the provider's other
/// builds and the build's row. A caller writes it only after [`recorded_arrival`] answers that the
/// build is new, or available and now installed, so a repeat tells no reader of a change.
pub fn record_statements(
    build: &RecordedProviderBuild,
    change: &RecordChangeStatements,
) -> Vec<WriteStatement> {
    let mut statements = change();
    statements.push(WriteStatement {
        sql: Cow::Borrowed(DELETE_EARLIER_BUILDS_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", build.provider.as_str()),
            text_binding("@version", &build.version),
        ]),
        expected_row_count: None,
    });
    statements.push(WriteStatement {
        sql: Cow::Borrowed(UPSERT_BUILD_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", build.provider.as_str()),
            text_binding("@version", &build.version),
            nullable_text_binding("@from_version", build.from_version.as_deref()),
            text_binding("@recorded_at", build.recorded_at.as_str()),
        ]),
        expected_row_count: None,
    });
    statements
}

/// Every build the record still lists, the newest recorded first. Fails when the read fails or a
/// stored provider id or instant does not read as its type.
pub fn listed_builds(connection: &Connection) -> rusqlite::Result<Vec<RecordedProviderBuild>> {
    connection
        .prepare_cached(SELECT_LISTED_BUILDS_SQL)?
        .query_map([], |row| {
            Ok(RecordedProviderBuild {
                provider: text_column(row, 0, |text| {
                    ProviderId::new(text).ok_or(StoredProviderIdInvalidError)
                })?,
                version: row.get(1)?,
                from_version: row.get(2)?,
                recorded_at: text_column(row, 3, WireInstant::try_from)?,
            })
        })?
        .collect()
}

/// Whether any listed `installed` build was recorded before `before`, so a retirement would change
/// the list. Fails when the read fails.
pub fn is_retirement_due(connection: &Connection, before: &WireInstant) -> rusqlite::Result<bool> {
    connection
        .prepare_cached(SELECT_RETIREMENT_DUE_SQL)?
        .query_row([before.as_str()], |row| row.get(0))
}

/// The write that retires, at `at`, every listed `installed` build recorded before `before`; an
/// `available` build is never retired by it.
pub fn retirement_statements(before: &WireInstant, at: &WireInstant) -> Vec<WriteStatement> {
    vec![WriteStatement {
        sql: Cow::Borrowed(RETIRE_BUILDS_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@retired_at", at.as_str()),
            text_binding("@before", before.as_str()),
        ]),
        expected_row_count: None,
    }]
}

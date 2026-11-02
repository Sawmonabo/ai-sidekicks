//! Each provider's reading in each place: what the last check of its command found there, the
//! command's real path and the identity of the file it resolves to, and the latest-version marker's
//! last answer. One row per provider per place; a computer with one place keys its row by `''`.

use std::borrow::Cow;
use std::path::PathBuf;

use rusqlite::types::{Type, Value};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value as JsonValue};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::settings::{
    PROVIDER_VERSION_MAX_LEN, ProviderInstallation, ProviderVersion,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::EntryIdentity;
use sidekicks_store::database::schema::SchemaPart;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, place_value, text_binding,
};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, text_column,
};

// A check's result replaces the last one's and keeps the marker's answer.
const UPSERT_CHECK_SQL: &str = "
  INSERT INTO provider_place_readings (
    provider_name, place, installation_state, raw_version, parsed_version, latest_version,
    resolved_path, identity, size, modified_second, modified_nanosecond, checked_at)
  VALUES (
    @provider_name, coalesce(@place, ''), @installation_state, @raw_version, @parsed_version,
    @latest_version, @resolved_path, @identity, @size, @modified_second, @modified_nanosecond,
    @checked_at)
  ON CONFLICT (provider_name, place)
    DO UPDATE SET installation_state  = excluded.installation_state,
                  raw_version         = excluded.raw_version,
                  parsed_version      = excluded.parsed_version,
                  latest_version      = excluded.latest_version,
                  resolved_path       = excluded.resolved_path,
                  identity            = excluded.identity,
                  size                = excluded.size,
                  modified_second     = excluded.modified_second,
                  modified_nanosecond = excluded.modified_nanosecond,
                  checked_at          = excluded.checked_at";

const UPDATE_MARKER_SQL: &str = "
  UPDATE provider_place_readings
     SET marker_etag = @marker_etag, marker_build = @marker_build
   WHERE provider_name = @provider_name AND place = coalesce(@place, '')";

const DELETE_PLACE_SQL: &str = "
  DELETE FROM provider_place_readings
   WHERE provider_name = @provider_name AND place = coalesce(@place, '')";

const SELECT_READINGS_SQL: &str = "
  SELECT place, installation_state, raw_version, parsed_version, latest_version, resolved_path,
         identity, size, modified_second, modified_nanosecond, checked_at, marker_etag,
         marker_build
    FROM provider_place_readings
   WHERE provider_name = ?1";

const SELECT_READING_SQL: &str = "
  SELECT place, installation_state, raw_version, parsed_version, latest_version, resolved_path,
         identity, size, modified_second, modified_nanosecond, checked_at, marker_etag,
         marker_build
    FROM provider_place_readings
   WHERE provider_name = ?1 AND place = coalesce(?2, '')";

/// The readings table, `provider_place_readings`, registered beside the provider drivers' own part.
pub fn schema_part() -> SchemaPart {
    SchemaPart::new("provider_place_readings", readings_schema_sql())
}

fn readings_schema_sql() -> String {
    let state_words = installation_state_words();
    let states = sql_list_of(state_words.iter().map(String::as_str));
    let installed = &state_words[0];
    let raw_version_bound = printed_version_bound("raw_version");
    let parsed_version_bound = printed_version_bound("parsed_version");
    let latest_version_bound = printed_version_bound("latest_version");
    let marker_build_bound = printed_version_bound("marker_build");
    format!(
        "
-- ---------------------------------------------------------------------------
-- Provider place readings: one row per provider per place.
-- ---------------------------------------------------------------------------
-- The versions are provider-printed text, bounded as the wire bounds a printed version.
CREATE TABLE provider_place_readings (
  provider_name        TEXT NOT NULL,            -- the provider's open id
  -- The place as its wire JSON (`\"windows\"` or `{{\"distro\":…}}`); '' on a computer with one
  -- place, so the key never holds NULL.
  place                TEXT NOT NULL DEFAULT '',
  -- NULL until the place was checked; else the tag of what the check found.
  installation_state   TEXT CHECK(installation_state IS NULL OR installation_state IN ({states})),
  -- The three versions, NULL unless installed.
  raw_version          TEXT CHECK(raw_version IS NULL OR ({raw_version_bound})),
  parsed_version       TEXT CHECK(parsed_version IS NULL OR ({parsed_version_bound})),
  latest_version       TEXT CHECK(latest_version IS NULL OR ({latest_version_bound})),
  -- The command's real path and the file it resolves to, NULL unless installed. The identity is
  -- its `<volume>:<file>` text, since the file id is 128 bits, past an INTEGER.
  resolved_path        TEXT,
  identity             TEXT,
  size                 INTEGER CHECK(size IS NULL OR size >= 0),
  -- The file's modification time as whole seconds since the Unix epoch and the nanoseconds past
  -- them, so a fresh read compares exactly.
  modified_second      INTEGER,
  modified_nanosecond  INTEGER CHECK(modified_nanosecond IS NULL
                         OR modified_nanosecond BETWEEN -999999999 AND 999999999),
  checked_at           TEXT,
  -- The latest-version marker's last `ETag` and the build it named, NULL until it answered once.
  marker_etag          TEXT,
  marker_build         TEXT CHECK(marker_build IS NULL OR ({marker_build_bound})),
  PRIMARY KEY (provider_name, place),
  CHECK ((installation_state IS NULL) = (checked_at IS NULL)),
  CHECK ((installation_state IS '{installed}') = (raw_version IS NOT NULL)),
  CHECK (installation_state IS '{installed}'
     OR (parsed_version IS NULL AND latest_version IS NULL)),
  CHECK ((installation_state IS '{installed}') = (resolved_path IS NOT NULL)),
  CHECK ((resolved_path IS NULL) = (identity IS NULL)
     AND (resolved_path IS NULL) = (size IS NULL)
     AND (resolved_path IS NULL) = (modified_second IS NULL)
     AND (resolved_path IS NULL) = (modified_nanosecond IS NULL)),
  CHECK ((marker_etag IS NULL) = (marker_build IS NULL))
) STRICT;
"
    )
}

// A printed version's bound on `column`: within the wire's bound in code points, no NUL.
fn printed_version_bound(column: &str) -> String {
    format!(
        "length({column}) > 0 AND length({column}) <= {PROVIDER_VERSION_MAX_LEN} \
         AND instr({column}, char(0)) = 0"
    )
}

// Every installation arm's tag as the contract spells it, `installed` first, read from one value of
// each arm.
fn installation_state_words() -> [String; 5] {
    let version =
        ProviderVersion::new("0".to_owned()).expect("a one-character version is in bounds");
    [
        ProviderInstallation::Installed {
            raw_version: version,
            parsed_version: None,
            latest_version: None,
        },
        ProviderInstallation::NotInstalled {},
        ProviderInstallation::Indeterminate {},
        ProviderInstallation::NoBuildForSystem {},
        ProviderInstallation::DistributionNeedsWsl2 {},
    ]
    .map(|installation| InstallationColumns::of(&installation).state)
}

/// The file a provider's command resolves to, as the check read it: its real path, which entry it
/// is, its size in bytes and its modification time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandTarget {
    /// The command's real path, every link resolved.
    pub resolved_path: PathBuf,
    /// Which file-system entry the path names.
    pub identity: EntryIdentity,
    /// The file's size in bytes.
    pub size: u64,
    /// The file's modification time.
    pub modified_at: jiff::Timestamp,
}

/// The latest-version marker's last answer: the `ETag` it sent, which the next check sends as
/// `If-None-Match`, and the build it named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkerAnswer {
    /// The answer's `ETag`, as sent.
    pub etag: String,
    /// The build the marker named, as printed.
    pub build: String,
}

/// One provider's stored reading in one place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPlaceReading {
    /// The provider.
    pub provider: ProviderId,
    /// The place; `None` on a computer with one place.
    pub place: Option<Place>,
    /// What the last check found; `None` until the place was checked.
    pub installation: Option<ProviderInstallation>,
    /// The file the command resolved to; `None` unless installed.
    pub target: Option<CommandTarget>,
    /// When the place was last checked; `None` until it was.
    pub checked_at: Option<WireInstant>,
    /// The marker's last answer; `None` until it answered once.
    pub marker: Option<MarkerAnswer>,
}

// An installation as its stored columns: the arm's tag and the versions it carries.
struct InstallationColumns {
    state: String,
    raw_version: Option<String>,
    parsed_version: Option<String>,
    latest_version: Option<String>,
}

impl InstallationColumns {
    // Read through the contract's own serialization, so the stored words are its spelling.
    fn of(installation: &ProviderInstallation) -> Self {
        let value = serde_json::to_value(installation).expect("an installation serializes to JSON");
        let member = |name: &str| {
            value
                .get(name)
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
        };
        Self {
            state: member("state").expect("an installation carries its tag"),
            raw_version: member("rawVersion"),
            parsed_version: member("parsedVersion"),
            latest_version: member("latestVersion"),
        }
    }

    // The installation these columns hold, read through the contract; an absent version stays
    // absent, as the contract reads it.
    fn into_installation(self) -> Result<ProviderInstallation, serde_json::Error> {
        let mut members = Map::new();
        members.insert("state".to_owned(), JsonValue::String(self.state));
        for (name, version) in [
            ("rawVersion", self.raw_version),
            ("parsedVersion", self.parsed_version),
            ("latestVersion", self.latest_version),
        ] {
            if let Some(version) = version {
                members.insert(name.to_owned(), JsonValue::String(version));
            }
        }
        serde_json::from_value(JsonValue::Object(members))
    }
}

/// The write that records a check of `provider` in `place`: `installation`, the file the command
/// resolved to (present exactly when installed, or the table's check refuses the write) and
/// `checked_at`, over the last check's, keeping the marker's last answer.
pub fn record_check(
    provider: &ProviderId,
    place: Option<&Place>,
    installation: &ProviderInstallation,
    target: Option<&CommandTarget>,
    checked_at: &WireInstant,
) -> WriteStatement {
    let columns = InstallationColumns::of(installation);
    let integer =
        |name: &'static str, value: Option<i64>| (Cow::Borrowed(name), Value::from(value));
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_CHECK_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", provider.as_str()),
            (Cow::Borrowed("@place"), place_value(place)),
            text_binding("@installation_state", &columns.state),
            nullable_text_binding("@raw_version", columns.raw_version.as_deref()),
            nullable_text_binding("@parsed_version", columns.parsed_version.as_deref()),
            nullable_text_binding("@latest_version", columns.latest_version.as_deref()),
            nullable_text_binding(
                "@resolved_path",
                target
                    .map(|target| target.resolved_path.to_string_lossy())
                    .as_deref(),
            ),
            nullable_text_binding(
                "@identity",
                target.map(|target| target.identity.to_string()).as_deref(),
            ),
            integer(
                "@size",
                target.map(|target| {
                    i64::try_from(target.size).expect("no file system holds a file of 2^63 bytes")
                }),
            ),
            integer(
                "@modified_second",
                target.map(|target| target.modified_at.as_second()),
            ),
            integer(
                "@modified_nanosecond",
                target.map(|target| i64::from(target.modified_at.subsec_nanosecond())),
            ),
            text_binding("@checked_at", checked_at.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// The write that records the marker's `answer` for `provider` in `place`, keeping the rest of the
/// reading; the write is refused unless the place has a reading.
pub fn record_marker(
    provider: &ProviderId,
    place: Option<&Place>,
    answer: &MarkerAnswer,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPDATE_MARKER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", provider.as_str()),
            (Cow::Borrowed("@place"), place_value(place)),
            text_binding("@marker_etag", &answer.etag),
            text_binding("@marker_build", &answer.build),
        ]),
        expected_row_count: Some(1),
    }
}

/// The write that removes `provider`'s reading in `place`, a WSL distribution that is gone; a place
/// with no reading changes nothing.
pub fn forget_place(provider: &ProviderId, place: &Place) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_PLACE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", provider.as_str()),
            (Cow::Borrowed("@place"), place_value(Some(place))),
        ]),
        expected_row_count: None,
    }
}

/// Every place's reading of `provider`, in no set order: the caller orders the places. Fails when
/// the read fails or a stored value does not read as its type.
pub fn read_place_readings(
    connection: &Connection,
    provider: &ProviderId,
) -> rusqlite::Result<Vec<StoredPlaceReading>> {
    connection
        .prepare_cached(SELECT_READINGS_SQL)?
        .query_map([provider.as_str()], |row| reading_of_row(provider, row))?
        .collect()
}

/// `provider`'s reading in `place`, `None` when it has none. Fails as [`read_place_readings`] does.
pub fn read_place_reading(
    connection: &Connection,
    provider: &ProviderId,
    place: Option<&Place>,
) -> rusqlite::Result<Option<StoredPlaceReading>> {
    connection
        .prepare_cached(SELECT_READING_SQL)?
        .query_row(params![provider.as_str(), place_value(place)], |row| {
            reading_of_row(provider, row)
        })
        .optional()
}

// One row of `SELECT_READINGS_SQL`'s columns as the reading it stores.
fn reading_of_row(provider: &ProviderId, row: &Row<'_>) -> rusqlite::Result<StoredPlaceReading> {
    let place = text_column(row, 0, |text| {
        if text.is_empty() {
            Ok(None)
        } else {
            serde_json::from_str::<Place>(&text)
                .map(Some)
                .map_err(StoredJsonFault::from)
        }
    })?;
    let installation = row
        .get::<_, Option<String>>(1)?
        .map(|state| {
            InstallationColumns {
                state,
                raw_version: row.get(2)?,
                parsed_version: row.get(3)?,
                latest_version: row.get(4)?,
            }
            .into_installation()
            .map_err(|error| conversion_failure(1, Type::Text, StoredJsonFault::from(error)))
        })
        .transpose()?;
    // The table's check sets the identity, size and time exactly beside the path.
    let target = row
        .get::<_, Option<String>>(5)?
        .map(|resolved_path| -> rusqlite::Result<CommandTarget> {
            let size: i64 = row.get(7)?;
            Ok(CommandTarget {
                resolved_path: PathBuf::from(resolved_path),
                identity: text_column(row, 6, |text| text.parse::<EntryIdentity>())?,
                size: u64::try_from(size)
                    .map_err(|error| conversion_failure(7, Type::Integer, error))?,
                modified_at: jiff::Timestamp::new(row.get(8)?, row.get(9)?)
                    .map_err(|error| conversion_failure(8, Type::Integer, error))?,
            })
        })
        .transpose()?;
    let marker = row
        .get::<_, Option<String>>(11)?
        .map(|etag| -> rusqlite::Result<MarkerAnswer> {
            Ok(MarkerAnswer {
                etag,
                build: row.get(12)?,
            })
        })
        .transpose()?;
    Ok(StoredPlaceReading {
        provider: provider.clone(),
        place,
        installation,
        target,
        checked_at: optional_text_column(row, 10, WireInstant::try_from)?,
        marker,
    })
}

fn conversion_failure(
    index: usize,
    column_type: Type,
    failure: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, column_type, Box::new(failure))
}

#[cfg(test)]
mod tests;

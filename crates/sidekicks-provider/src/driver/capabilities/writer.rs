//! Each provider's last capability reading, stored in three provider-keyed tables
//! (`driver_capabilities`, `driver_tools`, `driver_contract_meta`) in one write, and rebuilt whole
//! on a cold start without asking the driver.
//!
//! - `driver_contract_meta` is the parent row: its presence means the provider was written.
//! - The CLI version pair describes the reading, not a capability, so it sits outside change
//!   detection; an unchanged reading rewrites only the pair, and only when it differs.
//! - One provider's declares take turns, each write committing before the next declare reads, so
//!   two declares never decide from one stale snapshot or overwrite each other.
//! - A printed version that differs from the stored one is the provider's new build: the write
//!   that moves the pair also records it, so the pair never moves without its line in the record.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::provider::driver::tools::ProviderToolMetadata;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use strum::VariantArray;

use crate::build_record::{
    RecordChangeStatements, RecordedArrival, RecordedProviderBuild, record_statements,
    recorded_arrival,
};
use crate::driver::ProviderDescriptor;
use crate::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use crate::driver::contract::params_and_results::{DriverCliVersionReport, GetCapabilitiesResult};
use crate::output_validation::{ProviderOutputValidationError, check_contract_version};

/// The statements a [`DriverCapabilitiesWriter`] prepares on a read connection: the contract row,
/// the flag rows, the tool rows and the declared build's row in the record of builds.
pub const DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY: usize = 4;

// The pair comes from the parent row itself, so a row with no version stays apart from no row.
const SELECT_CONTRACT_META_SQL: &str = "
  SELECT contract_version, cli_version_raw, cli_version_semver
    FROM driver_contract_meta
   WHERE provider_name = ?";

// No order: the flags are read into a map.
const SELECT_CAPABILITY_FLAGS_SQL: &str = "
  SELECT capability_flag, supported
    FROM driver_capabilities
   WHERE provider_name = ?";

// SQLite's BINARY order, which the declare's sort matches.
const SELECT_TOOLS_SQL: &str = "
  SELECT tool_name, idempotency_class, description
    FROM driver_tools
   WHERE provider_name = ?
   ORDER BY tool_name";

// Every flag is written on every capability write and none is ever dropped, so no row is left over.
const UPSERT_CAPABILITY_FLAG_SQL: &str = "
  INSERT INTO driver_capabilities (provider_name, capability_flag, supported, refreshed_at)
  VALUES (@provider_name, @capability_flag, @supported, @refreshed_at)
  ON CONFLICT(provider_name, capability_flag)
    DO UPDATE SET supported    = excluded.supported,
                  refreshed_at = excluded.refreshed_at";

const DELETE_TOOLS_SQL: &str = "DELETE FROM driver_tools WHERE provider_name = ?";

const INSERT_TOOL_SQL: &str = "
  INSERT INTO driver_tools (provider_name, tool_name, idempotency_class, description, refreshed_at)
  VALUES (@provider_name, @tool_name, @idempotency_class, @description, @refreshed_at)";

// The version pair rides every capability write, so it never lags one.
const UPSERT_CONTRACT_META_SQL: &str = "
  INSERT INTO driver_contract_meta (provider_name, contract_version, cli_version_raw,
                                    cli_version_semver, refreshed_at)
  VALUES (@provider_name, @contract_version, @cli_version_raw, @cli_version_semver, @refreshed_at)
  ON CONFLICT(provider_name)
    DO UPDATE SET contract_version   = excluded.contract_version,
                  cli_version_raw    = excluded.cli_version_raw,
                  cli_version_semver = excluded.cli_version_semver,
                  refreshed_at       = excluded.refreshed_at";

// The version alone: both columns together, so a parse never outlives its printed version.
const REFRESH_CLI_VERSION_SQL: &str = "
  UPDATE driver_contract_meta
     SET cli_version_raw    = @cli_version_raw,
         cli_version_semver = @cli_version_semver,
         refreshed_at       = @refreshed_at
   WHERE provider_name = @provider_name";

/// What a declare did to the stored capability snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilitySnapshotChange {
    /// No snapshot was stored before.
    Created,
    /// The stored snapshot differed and was replaced.
    Changed,
    /// The stored snapshot was the same; no capability row was written.
    Unchanged,
}

/// What a declare did: to the snapshot, and whether the stored CLI version pair differed from the
/// declared one and was rewritten.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeclaredCapabilities {
    /// What happened to the snapshot.
    pub(crate) snapshot_change: CapabilitySnapshotChange,
    /// Whether the stored version pair was rewritten.
    pub(crate) is_cli_version_refreshed: bool,
}

/// A provider's stored capabilities rebuilt, or why none can be: never written, or written with no
/// CLI version, which is never invented since it is the spawned build's own report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityHydration {
    /// The stored reading, rebuilt whole.
    Hit {
        /// The reading as the driver would answer it, without detection sources.
        result: GetCapabilitiesResult,
    },
    /// The provider's capabilities were never stored.
    NeverWritten {},
    /// The stored row carries no CLI version.
    CliVersionMissing {},
}

/// A provider's stored flag rows that are not exactly the flag set: the store wrote every flag, so
/// this is a damaged database, never a provider's report.
#[derive(Debug, thiserror::Error)]
#[error(
    "the stored capability flags are not the flag set: missing {missing:?}, unexpected \
     {unexpected:?}"
)]
pub struct StoredFlagSetMismatch {
    /// The flags with no stored row.
    pub(crate) missing: Vec<DriverCapabilityFlag>,
    /// The stored names that are no flag.
    pub(crate) unexpected: Vec<String>,
}

/// Why a capability declare or hydrate failed.
#[derive(Debug, thiserror::Error)]
pub enum DriverCapabilitiesWriterError {
    /// The reading was refused before anything was read or written.
    #[error(transparent)]
    InvalidOutput(#[from] ProviderOutputValidationError),
    /// The stored flag rows are not the flag set.
    #[error(transparent)]
    FlagSetMismatch(#[from] StoredFlagSetMismatch),
    /// The stored capabilities could not be read, or a stored value did not read as its type.
    #[error("reading the stored capabilities failed")]
    Database(#[from] rusqlite::Error),
    /// The read reached no connection.
    #[error("reading the stored capabilities failed")]
    Read(#[from] DatabaseReadError),
    /// The write was not kept.
    #[error("storing the capabilities failed")]
    Write(#[from] WriteError),
}

/// Stores each provider's declared capabilities and rebuilds them without asking the driver; one
/// per daemon, so its lock orders every declare of a provider.
pub struct DriverCapabilitiesWriter {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    // The statements that tell the record's readers a build was recorded.
    record_change: Arc<RecordChangeStatements>,
    // One provider's declares take turns, each committing before the next reads.
    declares: KeyedLock<ProviderId>,
}

// What is stored for one provider: the snapshot, and the version pair, `None` when the row has
// none.
struct StoredCapabilities {
    snapshot: CapabilitySnapshot,
    cli_version: Option<DriverCliVersionReport>,
}

// The part of a reading change detection compares: the flags, the contract version and the tools
// in name order.
#[derive(PartialEq)]
struct CapabilitySnapshot {
    capabilities: DriverCapabilities,
    tools: Vec<ProviderToolMetadata>,
}

impl DriverCapabilitiesWriter {
    /// A writer reading through `reads` and writing through `writer`, which carries
    /// `record_change`'s statements in each write that records a provider's new build.
    pub fn new(
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        record_change: Arc<RecordChangeStatements>,
    ) -> Self {
        Self {
            reads,
            writer,
            record_change,
            declares: KeyedLock::new(),
        }
    }

    /// Stores `provider`'s capability reading in one write, in turn with its other declares; an
    /// identical reading writes no capability row and rewrites the CLI version pair only when it
    /// differs. A printed version other than the stored one, of a build the record does not hold
    /// as installed, is recorded in the same write, moved from the stored one. Fails with
    /// [`DriverCapabilitiesWriterError::InvalidOutput`] for a contract version that is no
    /// canonical semantic version or a tool name declared twice, before anything is read or
    /// written, and otherwise when the read or the write fails.
    pub async fn declare(
        &self,
        provider: &ProviderId,
        result: &GetCapabilitiesResult,
    ) -> Result<DeclaredCapabilities, DriverCapabilitiesWriterError> {
        check_contract_version(&result.capabilities.contract_version).map_err(|error| {
            ProviderOutputValidationError {
                provider_name: Some(provider.clone()),
                ..error
            }
        })?;
        let mut tools = result.tools.clone();
        // UTF-8 byte order, as `ORDER BY tool_name` reads them back, so a reorder alone is no
        // change.
        tools.sort_by(|left, right| left.name.as_str().cmp(right.name.as_str()));
        if tools.windows(2).any(|pair| pair[0].name == pair[1].name) {
            return Err(ProviderOutputValidationError {
                provider_name: Some(provider.clone()),
                field: "tools",
                reason: "duplicate tool name",
            }
            .into());
        }
        let declared = CapabilitySnapshot {
            capabilities: result.capabilities.clone(),
            tools,
        };
        let declared_cli_version = &result.cli_version;

        let _turn = self.declares.acquire(provider.clone()).await;
        let stored_provider = provider.clone();
        let declared_raw_version = declared_cli_version.raw_version.clone();
        let (stored, moved_from_version) = self
            .reads
            .read(ReadLength::Short, move |reader| {
                let stored = read_stored_capabilities(reader, &stored_provider)?;
                let moved_from_version = match stored
                    .as_ref()
                    .and_then(|stored| stored.cli_version.as_ref())
                {
                    // Versions compare as printed; a build already installed is never recorded
                    // again, retired or not.
                    Some(stored_version) if stored_version.raw_version != declared_raw_version => {
                        (recorded_arrival(reader, &stored_provider, &declared_raw_version)?
                            != Some(RecordedArrival::Installed))
                        .then(|| stored_version.raw_version.clone())
                    }
                    Some(_) | None => None,
                };
                Ok::<_, DriverCapabilitiesWriterError>((stored, moved_from_version))
            })
            .await?;
        let is_cli_version_refreshed = stored
            .as_ref()
            .is_none_or(|stored| stored.cli_version.as_ref() != Some(declared_cli_version));
        let refreshed_at = WireInstant::now();
        let build_record = moved_from_version.map_or_else(Vec::new, |from_version| {
            record_statements(
                &RecordedProviderBuild {
                    provider: provider.clone(),
                    version: declared_cli_version.raw_version.clone(),
                    from_version: Some(from_version),
                    recorded_at: refreshed_at.clone(),
                },
                &*self.record_change,
            )
        });

        let snapshot_change = match &stored {
            Some(stored) if stored.snapshot == declared => {
                // A new build with the same capabilities still refreshes the pair, or the stored
                // version would name a build no longer installed.
                if is_cli_version_refreshed {
                    let mut statements = vec![refresh_cli_version_statement(
                        provider,
                        declared_cli_version,
                        &refreshed_at,
                    )];
                    statements.extend(build_record);
                    self.writer.write(statements).await?;
                }
                CapabilitySnapshotChange::Unchanged
            }
            Some(_) | None => {
                let mut statements =
                    snapshot_statements(provider, &declared, declared_cli_version, &refreshed_at);
                statements.extend(build_record);
                self.writer.write(statements).await?;
                if stored.is_some() {
                    CapabilitySnapshotChange::Changed
                } else {
                    CapabilitySnapshotChange::Created
                }
            }
        };
        Ok(DeclaredCapabilities {
            snapshot_change,
            is_cli_version_refreshed,
        })
    }

    /// Rebuilds `provider`'s stored capability reading without asking the driver, in one read
    /// snapshot, its fixed output-speed levels from `descriptor`. Fails with
    /// [`DriverCapabilitiesWriterError::FlagSetMismatch`] when the stored flag rows are not exactly
    /// the flag set, and when the read fails or a stored value does not read as its type.
    pub async fn hydrate(
        &self,
        provider: &ProviderId,
        descriptor: &ProviderDescriptor,
    ) -> Result<CapabilityHydration, DriverCapabilitiesWriterError> {
        let stored_provider = provider.clone();
        let stored = self
            .reads
            .read(ReadLength::Short, move |reader| {
                read_stored_capabilities(reader, &stored_provider)
            })
            .await?;
        let Some(stored) = stored else {
            return Ok(CapabilityHydration::NeverWritten {});
        };
        let Some(cli_version) = stored.cli_version else {
            return Ok(CapabilityHydration::CliVersionMissing {});
        };
        let output_speed_levels = descriptor.static_output_speed_levels(
            stored
                .snapshot
                .capabilities
                .flags
                .is_on(DriverCapabilityFlag::OutputSpeed),
        );
        Ok(CapabilityHydration::Hit {
            result: GetCapabilitiesResult {
                capabilities: stored.snapshot.capabilities,
                tools: stored.snapshot.tools,
                cli_version,
                detection_source: None,
                output_speed_levels,
            },
        })
    }
}

// The three reads in one transaction, so a declare committing between them cannot tear the read.
fn read_stored_capabilities(
    reader: &Connection,
    provider: &ProviderId,
) -> Result<Option<StoredCapabilities>, DriverCapabilitiesWriterError> {
    let snapshot = reader.unchecked_transaction()?;
    let contract_meta = snapshot
        .prepare_cached(SELECT_CONTRACT_META_SQL)?
        .query_row([provider.as_str()], |row| {
            Ok((
                text_column(
                    row,
                    0,
                    FreeFormText::<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>::new,
                )?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .optional()?;
    let Some((contract_version, cli_version_raw, cli_version_semver)) = contract_meta else {
        return Ok(None);
    };

    let mut flag_values = BTreeMap::new();
    let mut unexpected = Vec::new();
    let flag_rows = snapshot
        .prepare_cached(SELECT_CAPABILITY_FLAGS_SQL)?
        .query_map([provider.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (stored_name, supported) in flag_rows {
        match closed_word::<DriverCapabilityFlag>(stored_name.clone()) {
            Ok(flag) => {
                flag_values.insert(flag, supported == 1);
            }
            Err(_not_a_flag) => unexpected.push(stored_name),
        }
    }
    let missing: Vec<DriverCapabilityFlag> = DriverCapabilityFlag::VARIANTS
        .iter()
        .copied()
        .filter(|flag| !flag_values.contains_key(flag))
        .collect();
    if !missing.is_empty() || !unexpected.is_empty() {
        return Err(StoredFlagSetMismatch {
            missing,
            unexpected,
        }
        .into());
    }

    let tools = snapshot
        .prepare_cached(SELECT_TOOLS_SQL)?
        .query_map([provider.as_str()], |row| {
            Ok(ProviderToolMetadata {
                name: text_column(row, 0, FreeFormText::new)?,
                idempotency_class: text_column(row, 1, closed_word)?,
                description: optional_text_column(row, 2, FreeFormText::new)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(StoredCapabilities {
        snapshot: CapabilitySnapshot {
            capabilities: DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| flag_values.get(&flag) == Some(&true)),
                contract_version,
            },
            tools,
        },
        cli_version: cli_version_raw.map(|raw_version| DriverCliVersionReport {
            raw_version,
            parsed_version: cli_version_semver,
        }),
    }))
}

// Every flag, the tools deleted and inserted again so a removed tool leaves no row, and the parent
// row with the version pair.
fn snapshot_statements(
    provider: &ProviderId,
    snapshot: &CapabilitySnapshot,
    cli_version: &DriverCliVersionReport,
    refreshed_at: &WireInstant,
) -> Vec<WriteStatement> {
    let mut statements =
        Vec::with_capacity(DriverCapabilityFlag::VARIANTS.len() + snapshot.tools.len() + 2);
    for flag in DriverCapabilityFlag::VARIANTS {
        statements.push(WriteStatement {
            sql: Cow::Borrowed(UPSERT_CAPABILITY_FLAG_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@provider_name", provider.as_str()),
                text_binding("@capability_flag", (*flag).into()),
                (
                    Cow::Borrowed("@supported"),
                    Value::Integer(i64::from(snapshot.capabilities.flags.is_on(*flag))),
                ),
                text_binding("@refreshed_at", refreshed_at.as_str()),
            ]),
            expected_row_count: None,
        });
    }
    statements.push(WriteStatement {
        sql: Cow::Borrowed(DELETE_TOOLS_SQL),
        bindings: StatementBindings::Positional(vec![Value::Text(provider.as_str().to_owned())]),
        expected_row_count: None,
    });
    for tool in &snapshot.tools {
        statements.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_TOOL_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@provider_name", provider.as_str()),
                text_binding("@tool_name", tool.name.as_str()),
                text_binding("@idempotency_class", tool.idempotency_class.into()),
                nullable_text_binding(
                    "@description",
                    tool.description.as_ref().map(FreeFormText::as_str),
                ),
                text_binding("@refreshed_at", refreshed_at.as_str()),
            ]),
            expected_row_count: None,
        });
    }
    statements.push(WriteStatement {
        sql: Cow::Borrowed(UPSERT_CONTRACT_META_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", provider.as_str()),
            text_binding(
                "@contract_version",
                snapshot.capabilities.contract_version.as_str(),
            ),
            text_binding("@cli_version_raw", &cli_version.raw_version),
            nullable_text_binding("@cli_version_semver", cli_version.parsed_version.as_deref()),
            text_binding("@refreshed_at", refreshed_at.as_str()),
        ]),
        expected_row_count: None,
    });
    statements
}

fn refresh_cli_version_statement(
    provider: &ProviderId,
    cli_version: &DriverCliVersionReport,
    refreshed_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(REFRESH_CLI_VERSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@provider_name", provider.as_str()),
            text_binding("@cli_version_raw", &cli_version.raw_version),
            nullable_text_binding("@cli_version_semver", cli_version.parsed_version.as_deref()),
            text_binding("@refreshed_at", refreshed_at.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// A writer over `database`, opening its database writer and telling a recorded build's readers
/// through `record_change`, for tests that declare a reading.
#[cfg(test)]
pub(crate) async fn test_capabilities_writer(
    database: &sidekicks_store::database::writer::test_file::TestDatabase,
    record_change: Arc<RecordChangeStatements>,
) -> DriverCapabilitiesWriter {
    let writer = DatabaseWriter::open(
        database.opener(),
        sidekicks_store::database::writer::DatabaseWriterOptions::default(),
    )
    .await
    .expect("the writer opens its database");
    let reads = DatabaseReadPool::new(
        database.path(),
        DRIVER_CAPABILITIES_WRITER_STATEMENT_CAPACITY,
    );
    DriverCapabilitiesWriter::new(Arc::new(reads), Arc::new(writer), record_change)
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::Arc;

    use rusqlite::Connection;
    use sidekicks_contracts::provider::driver::tools::{IdempotencyClass, ProviderToolMetadata};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_store::database::schema::SchemaPart;
    use sidekicks_store::database::statement::{StatementBindings, WriteStatement, named_bindings};
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::{
        CapabilitySnapshotChange, DriverCapabilitiesWriterError, test_capabilities_writer,
    };
    use crate::build_record::{RecordChangeStatements, RecordedProviderBuild, record_statements};
    use crate::driver::PROVIDERS;
    use crate::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use crate::driver::contract::params_and_results::{
        DriverCliVersionReport, GetCapabilitiesResult,
    };
    use crate::driver::schema::schema_parts;

    const SENTINEL: &str = "2000-01-01T00:00:00.000Z";

    fn provider() -> ProviderId {
        ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
    }

    fn reading(cli_version: &str) -> GetCapabilitiesResult {
        GetCapabilitiesResult {
            capabilities: DriverCapabilities {
                flags: DriverCapabilityFlags::from_fn(|flag| flag == DriverCapabilityFlag::Resume),
                contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a version"),
            },
            tools: vec![ProviderToolMetadata {
                name: FreeFormText::new("Read".to_owned()).expect("a tool name"),
                idempotency_class: IdempotencyClass::Idempotent,
                description: None,
            }],
            cli_version: DriverCliVersionReport {
                raw_version: cli_version.to_owned(),
                parsed_version: Some(cli_version.to_owned()),
            },
            detection_source: None,
            output_speed_levels: None,
        }
    }

    // Every capability and tool row's refresh time, read through a connection of the test's own.
    fn refreshed_at_of_capability_rows(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT refreshed_at FROM driver_capabilities
                 UNION ALL SELECT refreshed_at FROM driver_tools",
            )
            .expect("the test's read prepares");
        statement
            .query_map([], |row| row.get(0))
            .expect("the test's read runs")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads")
    }

    #[tokio::test]
    async fn a_same_reading_writes_no_capability_row_and_a_new_build_rewrites_only_its_version() {
        let database = TestDatabase::new(schema_parts());
        let writer = test_capabilities_writer(&database, Arc::new(Vec::new)).await;
        let provider = provider();
        let first = writer
            .declare(&provider, &reading("2.0.0"))
            .await
            .expect("the first reading is stored");
        assert_eq!(first.snapshot_change, CapabilitySnapshotChange::Created);
        let connection = database.reader();
        connection
            .execute_batch(&format!(
                "UPDATE driver_capabilities SET refreshed_at = '{SENTINEL}';
                 UPDATE driver_tools SET refreshed_at = '{SENTINEL}';"
            ))
            .expect("the test marks every capability row");

        let same = writer
            .declare(&provider, &reading("2.0.0"))
            .await
            .expect("the same reading is declared");
        assert_eq!(same.snapshot_change, CapabilitySnapshotChange::Unchanged);
        assert!(!same.is_cli_version_refreshed);

        let new_build = writer
            .declare(&provider, &reading("2.1.0"))
            .await
            .expect("the new build's reading is declared");
        assert_eq!(
            new_build.snapshot_change,
            CapabilitySnapshotChange::Unchanged
        );
        assert!(new_build.is_cli_version_refreshed);

        let refreshed = refreshed_at_of_capability_rows(&connection);
        assert_ne!(refreshed, [] as [String; 0]);
        assert!(refreshed.iter().all(|at| at == SENTINEL));
        let stored_version: String = connection
            .query_row(
                "SELECT cli_version_raw FROM driver_contract_meta WHERE provider_name = ?",
                [provider.as_str()],
                |row| row.get(0),
            )
            .expect("the parent row reads");
        assert_eq!(stored_version, "2.1.0");
    }

    #[tokio::test]
    async fn a_stored_flag_set_missing_a_flag_fails_the_rebuild() {
        let database = TestDatabase::new(schema_parts());
        let writer = test_capabilities_writer(&database, Arc::new(Vec::new)).await;
        let provider = provider();
        writer
            .declare(&provider, &reading("2.0.0"))
            .await
            .expect("the reading is stored");
        database
            .reader()
            .execute(
                "DELETE FROM driver_capabilities WHERE provider_name = ? AND capability_flag = ?",
                [provider.as_str(), <&str>::from(DriverCapabilityFlag::Steer)],
            )
            .expect("the test removes one flag row");

        let rebuilt = writer.hydrate(&provider, PROVIDERS[0]).await;
        assert!(
            matches!(
                &rebuilt,
                Err(DriverCapabilitiesWriterError::FlagSetMismatch(mismatch))
                    if mismatch.missing == [DriverCapabilityFlag::Steer]
                        && mismatch.unexpected.is_empty()
            ),
            "{rebuilt:?}"
        );
    }

    // A record row: its build, the build it moved from and whether it is retired.
    type BuildRow = (String, Option<String>, bool);

    // The record's rows and how many times its readers were told of a change.
    fn record_and_changes(connection: &Connection) -> (Vec<BuildRow>, i64) {
        let rows = connection
            .prepare("SELECT version, from_version, retired_at IS NOT NULL FROM provider_builds")
            .expect("the test's read prepares")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("the test's read runs")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads");
        let changes = connection
            .query_row("SELECT count(*) FROM record_changes", [], |row| row.get(0))
            .expect("the markers count");
        (rows, changes)
    }

    // Points the stored pair back at `version`, as if the provider's command still ran it.
    fn store_version(connection: &Connection, version: &str) {
        connection
            .execute(
                "UPDATE driver_contract_meta SET cli_version_raw = ?1, cli_version_semver = ?1",
                [version],
            )
            .expect("the test moves the stored pair");
    }

    fn installed(version: &str, from_version: &str, is_retired: bool) -> BuildRow {
        (
            version.to_owned(),
            Some(from_version.to_owned()),
            is_retired,
        )
    }

    #[tokio::test]
    async fn a_new_printed_version_is_recorded_once_with_the_pair_it_moves() {
        let database = TestDatabase::new(schema_parts().with_part(SchemaPart::new(
            "record_changes",
            "CREATE TABLE record_changes (marked INTEGER NOT NULL) STRICT;",
        )));
        let record_change: Arc<RecordChangeStatements> = Arc::new(|| {
            vec![WriteStatement {
                sql: Cow::Borrowed("INSERT INTO record_changes (marked) VALUES (1)"),
                bindings: StatementBindings::None,
                expected_row_count: Some(1),
            }]
        });
        let writer = test_capabilities_writer(&database, record_change).await;
        let provider = provider();
        let connection = database.reader();
        let declare = |version: &'static str| {
            let writer = &writer;
            let provider = &provider;
            async move {
                writer
                    .declare(provider, &reading(version))
                    .await
                    .expect("the reading is declared");
            }
        };

        // A first declare, an unchanged version, alone or with new capabilities, and a stored row
        // with no version record nothing.
        declare("2.1.293").await;
        declare("2.1.293").await;
        let mut new_capabilities = reading("2.1.293");
        new_capabilities.tools.clear();
        writer
            .declare(&provider, &new_capabilities)
            .await
            .expect("the reading is declared");
        connection
            .execute_batch(
                "UPDATE driver_contract_meta SET cli_version_raw = NULL, cli_version_semver = NULL",
            )
            .expect("the test takes the stored version off");
        declare("2.1.293").await;
        assert_eq!(record_and_changes(&connection), (vec![], 0));

        declare("2.1.294").await;
        assert_eq!(
            record_and_changes(&connection),
            (vec![installed("2.1.294", "2.1.293", false)], 1)
        );

        // The same build declared again over the earlier one, listed or retired, is not recorded
        // again.
        store_version(&connection, "2.1.293");
        declare("2.1.294").await;
        assert_eq!(
            record_and_changes(&connection),
            (vec![installed("2.1.294", "2.1.293", false)], 1)
        );
        connection
            .execute_batch(&format!(
                "UPDATE provider_builds SET retired_at = '{SENTINEL}'"
            ))
            .expect("the test retires the build");
        store_version(&connection, "2.1.293");
        declare("2.1.294").await;
        assert_eq!(
            record_and_changes(&connection),
            (vec![installed("2.1.294", "2.1.293", true)], 1)
        );

        // An available build that the command then moves to is installed in place, and the
        // provider's earlier build leaves the record.
        connection
            .execute(
                "INSERT INTO provider_builds (provider_name, version, from_version, recorded_at)
                 VALUES (?, '2.1.295', NULL, ?)",
                [provider.as_str(), SENTINEL],
            )
            .expect("the test records an available build");
        declare("2.1.295").await;
        assert_eq!(
            record_and_changes(&connection),
            (vec![installed("2.1.295", "2.1.294", false)], 2)
        );

        // An available build never overwrites the same build installed.
        let available = record_statements(
            &RecordedProviderBuild {
                provider: provider.clone(),
                version: "2.1.295".to_owned(),
                from_version: None,
                recorded_at: WireInstant::now(),
            },
            &Vec::new,
        );
        for statement in available {
            let StatementBindings::Named(values) = &statement.bindings else {
                unreachable!("the record binds by name");
            };
            connection
                .execute(&statement.sql, named_bindings(values).as_slice())
                .expect("the record's statement runs");
        }
        assert_eq!(
            record_and_changes(&connection).0,
            [installed("2.1.295", "2.1.294", false)]
        );
    }
}

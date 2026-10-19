//! The durable record of each run's legs on its provider, over the `runtime_bindings` table; a
//! binding never touches a remote provider.
//!
//! - `contract_version`, `resume_handle` and the CLI version pair are provider-declared: the SQL
//!   CHECKs bound length and NULs, and each write checks them first. The version pair and the
//!   build's path come from one reading of the spawned build, so every row names the build it ran.
//! - `spawn_config` holds the spawn-bound legs and the build's path: recovery reads the legs back
//!   to resume without the original request, and the path records what ran, which no start reads.
//! - A stored provider id is kept as written and only checked to be a valid id, so a row stays
//!   readable when no driver answers it. Reads take a connection; writes go through the writer.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

use rusqlite::types::{FromSql, Type, Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{StoredJsonFault, parse_stored_json_object, text_column};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::provider::driver::contract::{
    DriverCliVersionReport, SessionToolServer, SpawnedVersionBindingCarriers, SubagentPolicy,
};
use crate::provider::left_conversations::{LeftConversation, compose_left_conversation_insert};
use crate::provider::output_validation::{
    ProviderOutputValidationError, check_contract_version, check_resume_handle,
};
use crate::uuid_v7::mint_uuid_v7;

/// The statements the binding reads prepare on a read connection: one binding, a run's, many
/// runs', and every resumable one.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start sizes read caches with it")
)]
pub(crate) const RUNTIME_BINDING_STORE_STATEMENT_CAPACITY: usize = 4;

// The stored spawn record's member naming the build that ran: written from the spawned build's
// reading, kept apart from the legs a resume reads.
const RESOLVED_EXECUTABLE_PATH_MEMBER: &str = "resolvedExecutablePath";

// The binding columns every read takes, in the order `binding_from_row` reads them.
macro_rules! select_bindings {
    ($rest:literal) => {
        concat!(
            "SELECT id, run_id, provider_name, contract_version, cli_version_raw,
                    cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at,
                    updated_at
               FROM runtime_bindings ",
            $rest
        )
    };
}

const SPAWN_CONFIG_COLUMN: usize = 7;

const SELECT_BINDING_SQL: &str = select_bindings!("WHERE id = ?");

// The run index serves it; the order is stable across a run's many bindings.
const SELECT_RUN_BINDINGS_SQL: &str = select_bindings!("WHERE run_id = ? ORDER BY created_at, id");

// One statement for any number of runs: the ids arrive as one JSON array, so no list of
// placeholders is built per count or reaches SQLite's bound on them.
const SELECT_BINDINGS_OF_RUNS_SQL: &str = select_bindings!(
    "WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY run_id, created_at, id"
);

const SELECT_RESUMABLE_BINDINGS_SQL: &str =
    select_bindings!("WHERE resume_handle IS NOT NULL ORDER BY created_at, id");

const INSERT_BINDING_SQL: &str = "
  INSERT INTO runtime_bindings
    (id, run_id, provider_name, contract_version, cli_version_raw, cli_version_semver,
     resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
  VALUES
    (@id, @run_id, @provider_name, @contract_version, @cli_version_raw, @cli_version_semver,
     @resume_handle, @spawn_config, @runtime_metadata, @created_at, @updated_at)";

// The merge runs in SQL, so a concurrent patch of another column is kept; an absent member keeps
// the stored value and a cleared handle writes NULL. The match on the stored provider and spawn
// record lands the patch only on the record just read.
const UPDATE_BINDING_SQL: &str = "
  UPDATE runtime_bindings
     SET contract_version = CASE WHEN @sets_contract_version THEN @contract_version
                                 ELSE contract_version END,
         resume_handle    = CASE WHEN @sets_resume_handle THEN @resume_handle
                                 ELSE resume_handle END,
         runtime_metadata = CASE WHEN @sets_runtime_metadata THEN @runtime_metadata
                                 ELSE runtime_metadata END,
         updated_at       = @updated_at
   WHERE id = @id AND provider_name = @provider_name AND spawn_config = @spawn_config
  RETURNING contract_version, resume_handle, runtime_metadata";

// The relaunch resolved the provider's command again, so it records its own build's version and
// path over the predecessor's; the run, provider, contract version and legs carry over.
const INSERT_RELAUNCHED_BINDING_SQL: &str = "
  INSERT INTO runtime_bindings
    (id, run_id, provider_name, contract_version, cli_version_raw, cli_version_semver,
     resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
  SELECT @id, run_id, provider_name, contract_version, @cli_version_raw, @cli_version_semver,
         @resume_handle,
         json_set(spawn_config, @path_member, @resolved_executable_path), '{}',
         @timestamp, @timestamp
    FROM runtime_bindings
   WHERE id = @predecessor_id";

const DELETE_BINDING_SQL: &str = "DELETE FROM runtime_bindings WHERE id = ?";

/// The spawn-bound legs a resume rebuilds from, stored at every binding write, since a resume is a
/// fresh spawn and recovery has no client request; a leg left out relaunches without it (no
/// posture relaunches unsandboxed). The function legs are injected again at each spawn instead.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeBindingSpawnConfig {
    /// How the session may touch the machine.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The daemon's callback tools.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The provider-native subagent policy.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach, each with the person's switch, so a resume starts
    /// with exactly the servers that were on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) tool_servers: Option<Vec<SessionToolServer>>,
    /// A JSON Schema the final output must meet.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// The account the run was admitted against, bound for the run's life, so a resume never moves
    /// onto the current default account.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The requested output-speed level, never the provider's observed state, which would read a
    /// level that stopped being offered as accepted after a restart.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) output_speed: Option<ProviderToken>,
}

/// A runtime binding as the daemon reads it, its JSON columns parsed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RuntimeBinding {
    /// The binding.
    pub(crate) id: RuntimeBindingId,
    /// The run it belongs to; a run has many.
    pub(crate) run_id: RunId,
    /// The provider, as written.
    pub(crate) provider_name: ProviderId,
    /// The provider's contract version.
    pub(crate) contract_version: FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>,
    /// The version the spawned build reported.
    pub(crate) cli_version: DriverCliVersionReport,
    /// The provider's handle of the conversation, `None` until it has one.
    pub(crate) resume_handle: Option<String>,
    /// The build that ran, from the same reading as the version; a record, never a start's input,
    /// since every start resolves the command again.
    pub(crate) resolved_executable_path: String,
    /// The legs a resume rebuilds from.
    pub(crate) spawn_config: RuntimeBindingSpawnConfig,
    /// The provider's own recovery data.
    pub(crate) runtime_metadata: Map<String, Value>,
    /// When it was recorded.
    pub(crate) created_at: String,
    /// When it last changed.
    pub(crate) updated_at: String,
}

/// What [`RuntimeBindingStore::create`] records; the store mints the id, since a run has many
/// bindings.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CreateRuntimeBindingInput {
    /// The run.
    pub(crate) run_id: RunId,
    /// The provider.
    pub(crate) provider_name: ProviderId,
    /// The provider's contract version.
    pub(crate) contract_version: FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>,
    /// The spawned build's version and path, from one reading.
    pub(crate) spawned_version: SpawnedVersionBindingCarriers,
    /// The provider's handle of the conversation, when it has one yet.
    pub(crate) resume_handle: Option<String>,
    /// The spawn-bound legs.
    pub(crate) spawn_config: RuntimeBindingSpawnConfig,
    /// The provider's own recovery data.
    pub(crate) runtime_metadata: Map<String, Value>,
}

/// The mutable columns [`RuntimeBindingStore::update`] patches, each `None` to keep the stored
/// value; the spawn record and version are absent, since a relaunch records a new row instead.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RuntimeBindingPatch {
    /// A new contract version.
    pub(crate) contract_version: Option<FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>>,
    /// A new resume handle.
    pub(crate) resume_handle: Option<String>,
    /// New recovery data.
    pub(crate) runtime_metadata: Option<Map<String, Value>>,
}

/// A binding pointed at the conversation its session moved onto, and the ones the session left.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RuntimeBindingRebind {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The conversation it runs on now.
    pub(crate) resume_handle: String,
    /// The conversations the session left.
    pub(crate) left_conversations: Vec<LeftConversation>,
}

/// A resume a driver started on its own, after its process ended or on a new provider build, and
/// the binding it minted for the session's leg.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RuntimeBindingRelaunch {
    /// The binding the session ran on before, whose run, provider and legs carry over.
    pub(crate) predecessor_id: RuntimeBindingId,
    /// The id the driver minted for the relaunched leg.
    pub(crate) binding_id: RuntimeBindingId,
    /// The conversation the leg runs on now.
    pub(crate) resume_handle: String,
    /// The relaunched build's version and path, from the one reading its spawn took.
    pub(crate) spawned_version: SpawnedVersionBindingCarriers,
    /// The conversations the leg left.
    pub(crate) left_conversations: Vec<LeftConversation>,
}

/// A stored binding row with a column that does not read as its type: the daemon's own record is
/// damaged, so the read fails rather than pass it on. It names the binding and the column, never
/// the value.
#[derive(Debug, thiserror::Error)]
#[error("the stored {column} of runtime binding {} does not read", .binding_id.as_str())]
pub(crate) struct StoredBindingUnreadable {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The column.
    pub(crate) column: &'static str,
    /// Why, when a parse said.
    #[source]
    pub(crate) cause: Option<Box<dyn Error + Send + Sync>>,
}

/// A stored binding id that is no valid binding id.
#[derive(Debug, thiserror::Error)]
#[error("a stored runtime binding id is not a valid binding id")]
pub(crate) struct StoredBindingIdInvalid;

/// Why the stored spawn record does not read.
#[derive(Debug, thiserror::Error)]
enum SpawnConfigFault {
    /// It is not a JSON object.
    #[error("the spawn record is not a JSON object")]
    NotAnObject(#[source] StoredJsonFault),
    /// It names no build path as text.
    #[error("the spawn record names no build path")]
    ExecutablePathMissing,
    /// A leg does not read as its type, or a member is no leg.
    #[error("a member of the spawn record is not a leg it holds")]
    Legs(#[source] StoredJsonFault),
}

/// Why a binding write or read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RuntimeBindingStoreError {
    /// A provider-declared value was refused before anything was written.
    #[error(transparent)]
    InvalidOutput(#[from] ProviderOutputValidationError),
    /// The spawn record about to be written would not read back, so it was not written.
    #[error(transparent)]
    SpawnConfig(#[from] StoredBindingUnreadable),
    /// SQLite failed the read, or a stored value did not read as its type.
    #[error("reading the runtime bindings failed")]
    Database(#[from] rusqlite::Error),
    /// The read reached no connection.
    #[error("reading the runtime bindings failed")]
    Read(#[from] DatabaseReadError),
    /// The write was not kept; a relaunch whose predecessor has no row is refused here.
    #[error("writing the runtime binding failed")]
    Write(#[from] WriteError),
    /// The binding to point elsewhere has no row, so nothing was recorded.
    #[error(
        "runtime binding {} has no row to point at another conversation",
        .binding_id.as_str()
    )]
    NoRowToRebind {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
}

/// The binding `id`, or `None`. Fails on a database error or a stored row that does not read.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "a run's binding record reads a relaunched leg's predecessor through it"
    )
)]
pub(crate) fn read_binding(
    reader: &Connection,
    id: &RuntimeBindingId,
) -> rusqlite::Result<Option<RuntimeBinding>> {
    reader
        .prepare_cached(SELECT_BINDING_SQL)?
        .query_row([id.as_str()], binding_from_row)
        .optional()
}

/// A run's bindings, oldest first; empty when it has none. Fails on a database error or a stored
/// row that does not read.
pub(crate) fn read_run_bindings(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Vec<RuntimeBinding>> {
    let mut statement = reader.prepare_cached(SELECT_RUN_BINDINGS_SQL)?;
    let rows = statement.query_map([run_id.text().as_str()], binding_from_row)?;
    rows.collect()
}

/// Every binding of `run_ids` in one read, superseded ones included, ordered by run, then oldest
/// first; the caller groups them. Fails as a whole on a database error or any row that does not
/// read.
pub(crate) fn read_bindings_of_runs(
    reader: &Connection,
    run_ids: &[RunId],
) -> rusqlite::Result<Vec<RuntimeBinding>> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    let run_ids_json = Value::Array(
        run_ids
            .iter()
            .map(|run_id| Value::String(run_id.text().as_str().to_owned()))
            .collect(),
    )
    .to_string();
    let mut statement = reader.prepare_cached(SELECT_BINDINGS_OF_RUNS_SQL)?;
    let rows = statement.query_map([run_ids_json], binding_from_row)?;
    rows.collect()
}

/// Every binding with a resume handle, oldest first, for recovery. Fails as a whole on a row that
/// does not read, since dropping it would read as nothing to recover.
#[expect(dead_code, reason = "recovery rebuilds a resume from it")]
pub(crate) fn read_resumable_bindings(
    reader: &Connection,
) -> rusqlite::Result<Vec<RuntimeBinding>> {
    let mut statement = reader.prepare_cached(SELECT_RESUMABLE_BINDINGS_SQL)?;
    let rows = statement.query_map([], binding_from_row)?;
    rows.collect()
}

/// Writes runtime bindings through the database writer, reading a stored one first through the
/// read pool where a write is gated on it.
pub(crate) struct RuntimeBindingStore {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl RuntimeBindingStore {
    /// A store reading through `reads` and writing through `writer`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start builds the one store")
    )]
    pub(crate) fn new(reads: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { reads, writer }
    }

    /// Records a new binding under a minted id and returns it as stored, once committed. Fails
    /// with [`RuntimeBindingStoreError::InvalidOutput`] for a contract version or resume handle
    /// that does not meet its rules, before anything is written, and when the write fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a session's start records its provider binding through it"
        )
    )]
    pub(crate) async fn create(
        &self,
        input: CreateRuntimeBindingInput,
    ) -> Result<RuntimeBinding, RuntimeBindingStoreError> {
        check_contract_version(&input.contract_version).map_err(|error| {
            ProviderOutputValidationError {
                provider_name: Some(input.provider_name.clone()),
                ..error
            }
        })?;
        if let Some(resume_handle) = &input.resume_handle {
            check_resume_handle(resume_handle)?;
        }
        let id = RuntimeBindingId::new(mint_uuid_v7().to_string())
            .expect("a UUID's text is within the binding id's bound");
        let timestamp = WireInstant::now().as_str().to_owned();
        let spawn_config_text = compose_spawn_config_text(
            &input.spawn_config,
            &input
                .spawned_version
                .resolved_executable_path
                .to_string_lossy(),
        );
        // Read back with the read path's parser first, so a record the store cannot read never
        // lands.
        let (resolved_executable_path, spawn_config) = parse_spawn_config(&id, &spawn_config_text)?;
        let runtime_metadata_text = Value::Object(input.runtime_metadata.clone()).to_string();
        let cli_version = input.spawned_version.cli_version;

        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(INSERT_BINDING_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", id.as_str()),
                    text_binding("@run_id", input.run_id.text().as_str()),
                    text_binding("@provider_name", input.provider_name.as_str()),
                    text_binding("@contract_version", input.contract_version.as_str()),
                    text_binding("@cli_version_raw", &cli_version.raw_version),
                    nullable_text_binding(
                        "@cli_version_semver",
                        cli_version.parsed_version.as_deref(),
                    ),
                    nullable_text_binding("@resume_handle", input.resume_handle.as_deref()),
                    text_binding("@spawn_config", &spawn_config_text),
                    text_binding("@runtime_metadata", &runtime_metadata_text),
                    text_binding("@created_at", &timestamp),
                    text_binding("@updated_at", &timestamp),
                ]),
                expected_row_count: None,
            }])
            .await?;

        Ok(RuntimeBinding {
            id,
            run_id: input.run_id,
            provider_name: input.provider_name,
            contract_version: input.contract_version,
            cli_version,
            resume_handle: input.resume_handle,
            resolved_executable_path,
            spawn_config,
            runtime_metadata: input.runtime_metadata,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })
    }

    /// Patches binding `id`'s mutable columns and stamps its change, recording each conversation
    /// in `left_conversations` in the same write; returns the binding as patched, or `None` when
    /// it has no row and nothing was written. Fails with
    /// [`RuntimeBindingStoreError::InvalidOutput`] for an invalid patch, even for an absent id, on
    /// a stored row that does not read, before anything is written, and when the write fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a fork or a restart's resume points the binding at its new conversation \
                      through it"
        )
    )]
    pub(crate) async fn update(
        &self,
        id: &RuntimeBindingId,
        patch: RuntimeBindingPatch,
        left_conversations: Vec<LeftConversation>,
    ) -> Result<Option<RuntimeBinding>, RuntimeBindingStoreError> {
        if let Some(contract_version) = &patch.contract_version {
            check_contract_version(contract_version)?;
        }
        if let Some(resume_handle) = &patch.resume_handle {
            check_resume_handle(resume_handle)?;
        }
        let runtime_metadata_text = patch
            .runtime_metadata
            .as_ref()
            .map(|metadata| Value::Object(metadata.clone()).to_string());
        loop {
            let stored_id = id.clone();
            // Read first: a patch committed onto a damaged record would hide it behind a fresh
            // change time.
            let stored = self
                .reads
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, RuntimeBindingStoreError>(read_stored_binding(reader, &stored_id)?)
                })
                .await?;
            let Some((stored, stored_spawn_config)) = stored else {
                return Ok(None);
            };
            // One stamp for the update and every left conversation, which lands only beside it.
            let updated_at = WireInstant::now().as_str().to_owned();
            let mut statements = Vec::with_capacity(1 + left_conversations.len());
            statements.push(WriteStatement {
                sql: Cow::Borrowed(UPDATE_BINDING_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", id.as_str()),
                    text_binding("@provider_name", stored.provider_name.as_str()),
                    text_binding("@spawn_config", &stored_spawn_config),
                    set_flag_binding("@sets_contract_version", patch.contract_version.is_some()),
                    nullable_text_binding(
                        "@contract_version",
                        patch.contract_version.as_ref().map(FreeFormText::as_str),
                    ),
                    set_flag_binding("@sets_resume_handle", patch.resume_handle.is_some()),
                    nullable_text_binding("@resume_handle", patch.resume_handle.as_deref()),
                    set_flag_binding("@sets_runtime_metadata", runtime_metadata_text.is_some()),
                    nullable_text_binding("@runtime_metadata", runtime_metadata_text.as_deref()),
                    text_binding("@updated_at", &updated_at),
                ]),
                expected_row_count: None,
            });
            statements.extend(left_conversations.iter().map(|conversation| {
                compose_left_conversation_insert(id, &updated_at, conversation)
            }));
            let results = self.writer.write(statements).await?;
            let Some(returned) = results.first().and_then(|result| result.rows.first()) else {
                // The row went after the read, or its provider or spawn record was edited outside
                // the daemon: the next read answers `None`, or reads the record as now stored.
                continue;
            };
            return Ok(Some(patched_binding(stored, returned, updated_at)?));
        }
    }

    /// Points binding `rebind.binding_id` at the conversation its session moved onto, recording
    /// each conversation the session left in the same write. Fails with
    /// [`RuntimeBindingStoreError::NoRowToRebind`] when the binding has no row, so nothing was
    /// recorded, and as [`RuntimeBindingStore::update`] does.
    #[expect(
        dead_code,
        reason = "a fork or a restart's resume points the binding at its new conversation \
                  through it"
    )]
    pub(crate) async fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> Result<(), RuntimeBindingStoreError> {
        let patch = RuntimeBindingPatch {
            resume_handle: Some(rebind.resume_handle),
            ..RuntimeBindingPatch::default()
        };
        match self
            .update(&rebind.binding_id, patch, rebind.left_conversations)
            .await?
        {
            Some(_) => Ok(()),
            None => Err(RuntimeBindingStoreError::NoRowToRebind {
                binding_id: rebind.binding_id,
            }),
        }
    }

    /// Records the binding a driver minted when it resumed a session on its own: a new row on the
    /// predecessor's run, provider and legs, with the relaunched build's own version and path,
    /// naming the conversation the leg runs on now, and each conversation it left in the same
    /// write. Fails with [`RuntimeBindingStoreError::InvalidOutput`] for an invalid resume handle,
    /// and with [`RuntimeBindingStoreError::Write`] when the predecessor has no row, so nothing
    /// was recorded.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a driver's own relaunch records its new binding through it"
        )
    )]
    pub(crate) async fn record_relaunch(
        &self,
        relaunch: RuntimeBindingRelaunch,
    ) -> Result<(), RuntimeBindingStoreError> {
        check_resume_handle(&relaunch.resume_handle)?;
        let timestamp = WireInstant::now().as_str().to_owned();
        let cli_version = &relaunch.spawned_version.cli_version;
        let mut statements = Vec::with_capacity(1 + relaunch.left_conversations.len());
        statements.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_RELAUNCHED_BINDING_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", relaunch.binding_id.as_str()),
                text_binding("@cli_version_raw", &cli_version.raw_version),
                nullable_text_binding("@cli_version_semver", cli_version.parsed_version.as_deref()),
                text_binding("@resume_handle", &relaunch.resume_handle),
                text_binding(
                    "@resolved_executable_path",
                    &relaunch
                        .spawned_version
                        .resolved_executable_path
                        .to_string_lossy(),
                ),
                text_binding(
                    "@path_member",
                    &format!("$.{RESOLVED_EXECUTABLE_PATH_MEMBER}"),
                ),
                text_binding("@timestamp", &timestamp),
                text_binding("@predecessor_id", relaunch.predecessor_id.as_str()),
            ]),
            expected_row_count: Some(1),
        });
        statements.extend(relaunch.left_conversations.iter().map(|conversation| {
            compose_left_conversation_insert(&relaunch.binding_id, &timestamp, conversation)
        }));
        self.writer.write(statements).await?;
        Ok(())
    }

    /// Deletes binding `id` and returns whether it had a row. Fails when the write fails.
    #[expect(dead_code, reason = "removing a binding's record goes through it")]
    pub(crate) async fn delete(
        &self,
        id: &RuntimeBindingId,
    ) -> Result<bool, RuntimeBindingStoreError> {
        let results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(DELETE_BINDING_SQL),
                bindings: StatementBindings::Positional(vec![SqlValue::Text(
                    id.as_str().to_owned(),
                )]),
                expected_row_count: None,
            }])
            .await?;
        Ok(results.first().is_some_and(|result| result.row_count > 0))
    }
}

// The binding and its stored spawn record's text, which the update matches on.
fn read_stored_binding(
    reader: &Connection,
    id: &RuntimeBindingId,
) -> rusqlite::Result<Option<(RuntimeBinding, String)>> {
    reader
        .prepare_cached(SELECT_BINDING_SQL)?
        .query_row([id.as_str()], |row| {
            Ok((binding_from_row(row)?, row.get(SPAWN_CONFIG_COLUMN)?))
        })
        .optional()
}

fn binding_from_row(row: &Row<'_>) -> rusqlite::Result<RuntimeBinding> {
    let id = text_column(row, 0, |text| {
        RuntimeBindingId::new(text).ok_or(StoredBindingIdInvalid)
    })?;
    let run_id = RunId::new(&row.get::<_, String>(1)?)
        .map_err(|error| stored_column_unreadable(1, &id, "run_id", Some(Box::new(error))))?;
    let provider_name = ProviderId::new(row.get(2)?)
        .ok_or_else(|| stored_column_unreadable(2, &id, "provider_name", None))?;
    let contract_version = FreeFormText::new(row.get(3)?).map_err(|error| {
        stored_column_unreadable(3, &id, "contract_version", Some(Box::new(error)))
    })?;
    let cli_version = DriverCliVersionReport {
        raw_version: row.get(4)?,
        parsed_version: row.get(5)?,
    };
    let (resolved_executable_path, spawn_config) =
        parse_spawn_config(&id, &row.get::<_, String>(SPAWN_CONFIG_COLUMN)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                SPAWN_CONFIG_COLUMN,
                Type::Text,
                Box::new(error),
            )
        })?;
    Ok(RuntimeBinding {
        run_id,
        provider_name,
        contract_version,
        cli_version,
        resume_handle: row.get(6)?,
        resolved_executable_path,
        spawn_config,
        runtime_metadata: runtime_metadata_column(&row.get::<_, String>(8)?, 8, &id)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        id,
    })
}

// The stored binding with the columns the update returned and its stamp.
fn patched_binding(
    stored: RuntimeBinding,
    returned: &[SqlValue],
    updated_at: String,
) -> rusqlite::Result<RuntimeBinding> {
    let contract_version =
        FreeFormText::new(returned_column::<String>(returned, 0)?).map_err(|error| {
            stored_column_unreadable(0, &stored.id, "contract_version", Some(Box::new(error)))
        })?;
    let runtime_metadata =
        runtime_metadata_column(&returned_column::<String>(returned, 2)?, 2, &stored.id)?;
    Ok(RuntimeBinding {
        contract_version,
        resume_handle: returned_column(returned, 1)?,
        runtime_metadata,
        updated_at,
        ..stored
    })
}

// A column a write returned, read as SQLite would read it from a row.
fn returned_column<Column: FromSql>(row: &[SqlValue], index: usize) -> rusqlite::Result<Column> {
    let value = row.get(index).map_or(ValueRef::Null, ValueRef::from);
    Column::column_result(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, value.data_type(), Box::new(error))
    })
}

// Binding `binding_id`'s stored recovery data, `text`, from column `index`, read as a JSON object.
fn runtime_metadata_column(
    text: &str,
    index: usize,
    binding_id: &RuntimeBindingId,
) -> rusqlite::Result<Map<String, Value>> {
    parse_stored_json_object(text).map_err(|fault| {
        stored_column_unreadable(index, binding_id, "runtime_metadata", Some(Box::new(fault)))
    })
}

fn stored_column_unreadable(
    index: usize,
    binding_id: &RuntimeBindingId,
    column: &'static str,
    cause: Option<Box<dyn Error + Send + Sync>>,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(StoredBindingUnreadable {
            binding_id: binding_id.clone(),
            column,
            cause,
        }),
    )
}

// The stored text of a spawn record: the legs and the build's path as one JSON object.
fn compose_spawn_config_text(
    spawn_config: &RuntimeBindingSpawnConfig,
    resolved_executable_path: &str,
) -> String {
    let mut record =
        serde_json::to_value(spawn_config).expect("every spawn leg is JSON data with text keys");
    record
        .as_object_mut()
        .expect("a struct serializes to a JSON object")
        .insert(
            RESOLVED_EXECUTABLE_PATH_MEMBER.to_owned(),
            Value::String(resolved_executable_path.to_owned()),
        );
    record.to_string()
}

// The build's path and the legs of a stored spawn record; a record with no path, or with a member
// no leg names, does not read.
fn parse_spawn_config(
    binding_id: &RuntimeBindingId,
    text: &str,
) -> Result<(String, RuntimeBindingSpawnConfig), StoredBindingUnreadable> {
    let unreadable = |fault: SpawnConfigFault| StoredBindingUnreadable {
        binding_id: binding_id.clone(),
        column: "spawn_config",
        cause: Some(Box::new(fault)),
    };
    let mut record = parse_stored_json_object(text)
        .map_err(|fault| unreadable(SpawnConfigFault::NotAnObject(fault)))?;
    let Some(Value::String(resolved_executable_path)) =
        record.remove(RESOLVED_EXECUTABLE_PATH_MEMBER)
    else {
        return Err(unreadable(SpawnConfigFault::ExecutablePathMissing));
    };
    let spawn_config = serde_json::from_value(Value::Object(record))
        .map_err(|error| unreadable(SpawnConfigFault::Legs(error.into())))?;
    Ok((resolved_executable_path, spawn_config))
}

fn set_flag_binding(name: &'static str, is_set: bool) -> (Cow<'static, str>, SqlValue) {
    (Cow::Borrowed(name), SqlValue::Integer(i64::from(is_set)))
}

#[cfg(test)]
mod tests;

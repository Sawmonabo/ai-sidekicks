//! The service's configuration store: the one row of `daemon_configuration`, read once when the
//! store opens and kept on a watch every reader in the daemon follows (the retention bounds, the
//! diagnostic switches, the run and workflow limits). Each update changes one value through the
//! writer and publishes the row once it committed, one update at a time, so the watch moves in
//! commit order.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, Row};
use sidekicks_contracts::daemon::config::{
    DaemonConfigUpdateRequest, RunTimeLimitMinutes, WorkflowChainAskAfterRuns,
};
use sidekicks_contracts::daemon::retention::{DaemonRetentionBounds, DaemonRetentionUpdateRequest};
use sidekicks_contracts::session::cost::{TokensPerRun, UsdMicros};
use sidekicks_contracts::wire::integer::{Port, SafeInt};
use tokio::sync::{Mutex, watch};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::stored_column::safe_int_column;
use crate::database::writer::{DatabaseWriter, WriteError};

/// The statements the store's read prepares, counted into the read pool's statement capacity.
pub(crate) const DAEMON_CONFIGURATION_STATEMENT_CAPACITY: usize = 1;

const READ_ROW_SQL: &str = "SELECT keep_diagnostic_logs_days, keep_sessions_days,
  workflow_listener_port, run_time_limit_minutes, workflow_chain_ask_after_runs,
  max_steps_per_turn, spend_limit_usd_micros, tokens_per_run, tool_memory_cap_bytes,
  package_cache_limit_bytes, record_traces, record_provider_messages
  FROM daemon_configuration WHERE singleton = 1";

/// The configuration as the row holds it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DaemonConfiguration {
    /// `Keep diagnostic logs for` and `Keep sessions for`, in whole days.
    pub(crate) retention: DaemonRetentionBounds,
    /// The port a workflow started by a web request listens on.
    pub(crate) workflow_listener_port: Port,
    /// `Stop a run after`; `None` is `No limit`.
    pub(crate) run_time_limit_minutes: Option<RunTimeLimitMinutes>,
    /// `Ask me after one start leads to`; `None` is `Never ask`.
    pub(crate) workflow_chain_ask_after_runs: Option<WorkflowChainAskAfterRuns>,
    /// `Max steps per turn`; `None` is `Unlimited`.
    pub(crate) max_steps_per_turn: Option<SafeInt<1>>,
    /// `Spend limit`; `None` is `Unlimited`.
    pub(crate) spend_limit_usd_micros: Option<UsdMicros>,
    /// `Tokens per run`; `None` is `Unlimited`.
    pub(crate) tokens_per_run: Option<TokensPerRun>,
    /// `Memory cap for tool processes`, in bytes; `None` is no cap.
    pub(crate) tool_memory_cap_bytes: Option<SafeInt<1>>,
    /// `Cache limit`, in bytes; `None` is `Unlimited`.
    pub(crate) package_cache_limit_bytes: Option<SafeInt<1>>,
    /// `Record traces`.
    pub(crate) record_traces: bool,
    /// `Record raw provider messages`.
    pub(crate) record_provider_messages: bool,
}

/// One value an update changes: a configuration setting or a retention bound.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ConfigurationChange<'change> {
    /// A setting from `daemon.config.update`.
    Setting(&'change DaemonConfigUpdateRequest),
    /// A bound from `daemon.retention.update`.
    Bound(DaemonRetentionUpdateRequest),
}

/// Why the store could not open or an update was not kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConfigurationError {
    /// The row could not be written or changed.
    #[error("the service's configuration could not be written")]
    Write(#[from] WriteError),
    /// The row could not be read, or a stored value did not read as its type.
    #[error("the service's configuration could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// The configuration row, read once and followed on a watch.
pub(crate) struct ConfigurationStore {
    writer: Arc<DatabaseWriter>,
    current: watch::Sender<DaemonConfiguration>,
    // Held across an update's write and its publish, so the watch follows commit order.
    update_lock: Mutex<()>,
}

impl ConfigurationStore {
    /// Opens the store over the row the schema wrote, reading it. Fails when the read fails or a
    /// stored value does not read as its type.
    pub(crate) async fn open(
        writer: Arc<DatabaseWriter>,
        reads: &DatabaseReadPool,
    ) -> Result<Self, ConfigurationError> {
        let configuration = reads
            .read(ReadLength::Short, |connection| {
                read_configuration(connection)
            })
            .await?;
        Ok(Self {
            writer,
            current: watch::Sender::new(configuration),
            update_lock: Mutex::new(()),
        })
    }

    /// The configuration as it stands.
    pub(crate) fn current(&self) -> DaemonConfiguration {
        self.current.borrow().clone()
    }

    /// A receiver that holds the configuration as it stands and sees each update once it commits.
    pub(crate) fn follow(&self) -> watch::Receiver<DaemonConfiguration> {
        self.current.subscribe()
    }

    /// Changes one value and answers the configuration with it, once it committed and was
    /// published. Fails when the write is not kept; nothing is published then.
    pub(crate) async fn update(
        &self,
        change: ConfigurationChange<'_>,
    ) -> Result<DaemonConfiguration, ConfigurationError> {
        let (column, value) = column_value_of(change);
        let _update = self.update_lock.lock().await;
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Owned(format!(
                    "UPDATE daemon_configuration SET {column} = ?1 WHERE singleton = 1"
                )),
                bindings: StatementBindings::Positional(vec![value]),
                expected_row_count: Some(1),
            }])
            .await?;
        self.current
            .send_modify(|configuration| apply_change(configuration, change));
        Ok(self.current())
    }
}

/// The row as [`READ_ROW_SQL`] reads it. Fails when there is none, or a stored value does not
/// read as its type.
fn read_configuration(connection: &Connection) -> Result<DaemonConfiguration, ConfigurationError> {
    let mut statement = connection.prepare_cached(READ_ROW_SQL)?;
    Ok(statement.query_row([], |row| {
        Ok(DaemonConfiguration {
            retention: DaemonRetentionBounds {
                keep_diagnostic_logs_days: safe_int_column(row, 0)?,
                keep_sessions_days: safe_int_column(row, 1)?,
            },
            workflow_listener_port: integer_column(row, 2, Port::new)?,
            run_time_limit_minutes: optional_integer_column(row, 3, RunTimeLimitMinutes::new)?,
            workflow_chain_ask_after_runs: optional_integer_column(
                row,
                4,
                WorkflowChainAskAfterRuns::new,
            )?,
            max_steps_per_turn: optional_integer_column(row, 5, SafeInt::new)?,
            spend_limit_usd_micros: optional_integer_column(row, 6, |value| {
                SafeInt::new(value).map(UsdMicros)
            })?,
            tokens_per_run: optional_integer_column(row, 7, |value| {
                SafeInt::new(value).map(TokensPerRun)
            })?,
            tool_memory_cap_bytes: optional_integer_column(row, 8, SafeInt::new)?,
            package_cache_limit_bytes: optional_integer_column(row, 9, SafeInt::new)?,
            record_traces: row.get(10)?,
            record_provider_messages: row.get(11)?,
        })
    })?)
}

/// A stored INTEGER read through `parse`, failing the read for a value it refuses.
fn integer_column<Integer, Parsed>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(Integer) -> Option<Parsed>,
) -> rusqlite::Result<Parsed>
where
    Integer: TryFrom<i64>,
{
    let value: i64 = row.get(index)?;
    Integer::try_from(value)
        .ok()
        .and_then(parse)
        .ok_or(rusqlite::Error::IntegralValueOutOfRange(index, value))
}

/// A nullable stored INTEGER read as [`integer_column`] reads one; `None` for `NULL`.
fn optional_integer_column<Integer, Parsed>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(Integer) -> Option<Parsed>,
) -> rusqlite::Result<Option<Parsed>>
where
    Integer: TryFrom<i64>,
{
    match row.get::<_, Option<i64>>(index)? {
        None => Ok(None),
        Some(_) => integer_column(row, index, parse).map(Some),
    }
}

// The column a change writes and the value it writes there.
fn column_value_of(change: ConfigurationChange<'_>) -> (&'static str, Value) {
    fn integer(value: u64) -> Value {
        Value::Integer(i64::try_from(value).expect("a safe integer fits an i64"))
    }
    fn optional(value: Option<u64>) -> Value {
        value.map_or(Value::Null, integer)
    }
    match change {
        ConfigurationChange::Bound(DaemonRetentionUpdateRequest::KeepDiagnosticLogsDays(days)) => {
            ("keep_diagnostic_logs_days", integer(days.get()))
        }
        ConfigurationChange::Bound(DaemonRetentionUpdateRequest::KeepSessionsDays(days)) => {
            ("keep_sessions_days", integer(days.get()))
        }
        ConfigurationChange::Setting(setting) => match setting {
            DaemonConfigUpdateRequest::WorkflowListenerPort(port) => {
                ("workflow_listener_port", integer(u64::from(port.get())))
            }
            DaemonConfigUpdateRequest::RunTimeLimitMinutes(minutes) => (
                "run_time_limit_minutes",
                optional(minutes.map(|minutes| u64::from(minutes.get()))),
            ),
            DaemonConfigUpdateRequest::WorkflowChainAskAfterRuns(runs) => (
                "workflow_chain_ask_after_runs",
                optional(runs.map(|runs| u64::from(runs.get()))),
            ),
            DaemonConfigUpdateRequest::MaxStepsPerTurn(steps) => {
                ("max_steps_per_turn", optional(steps.map(SafeInt::get)))
            }
            DaemonConfigUpdateRequest::SpendLimitUsdMicros(limit) => (
                "spend_limit_usd_micros",
                optional(limit.map(|limit| limit.0.get())),
            ),
            DaemonConfigUpdateRequest::TokensPerRun(tokens) => (
                "tokens_per_run",
                optional(tokens.map(|tokens| tokens.0.get())),
            ),
            DaemonConfigUpdateRequest::ToolMemoryCapBytes(bytes) => {
                ("tool_memory_cap_bytes", optional(bytes.map(SafeInt::get)))
            }
            DaemonConfigUpdateRequest::PackageCacheLimitBytes(bytes) => (
                "package_cache_limit_bytes",
                optional(bytes.map(SafeInt::get)),
            ),
            DaemonConfigUpdateRequest::RecordTraces(is_on) => {
                ("record_traces", Value::Integer(i64::from(*is_on)))
            }
            DaemonConfigUpdateRequest::RecordProviderMessages(is_on) => (
                "record_provider_messages",
                Value::Integer(i64::from(*is_on)),
            ),
        },
    }
}

// The configuration with `change` made, as its committed write left the row.
fn apply_change(configuration: &mut DaemonConfiguration, change: ConfigurationChange<'_>) {
    match change {
        ConfigurationChange::Bound(DaemonRetentionUpdateRequest::KeepDiagnosticLogsDays(days)) => {
            configuration.retention.keep_diagnostic_logs_days = days;
        }
        ConfigurationChange::Bound(DaemonRetentionUpdateRequest::KeepSessionsDays(days)) => {
            configuration.retention.keep_sessions_days = days;
        }
        ConfigurationChange::Setting(setting) => match setting {
            DaemonConfigUpdateRequest::WorkflowListenerPort(port) => {
                configuration.workflow_listener_port = *port;
            }
            DaemonConfigUpdateRequest::RunTimeLimitMinutes(minutes) => {
                configuration.run_time_limit_minutes = *minutes;
            }
            DaemonConfigUpdateRequest::WorkflowChainAskAfterRuns(runs) => {
                configuration.workflow_chain_ask_after_runs = *runs;
            }
            DaemonConfigUpdateRequest::MaxStepsPerTurn(steps) => {
                configuration.max_steps_per_turn = *steps;
            }
            DaemonConfigUpdateRequest::SpendLimitUsdMicros(limit) => {
                configuration.spend_limit_usd_micros = *limit;
            }
            DaemonConfigUpdateRequest::TokensPerRun(tokens) => {
                configuration.tokens_per_run = *tokens;
            }
            DaemonConfigUpdateRequest::ToolMemoryCapBytes(bytes) => {
                configuration.tool_memory_cap_bytes = *bytes;
            }
            DaemonConfigUpdateRequest::PackageCacheLimitBytes(bytes) => {
                configuration.package_cache_limit_bytes = *bytes;
            }
            DaemonConfigUpdateRequest::RecordTraces(is_on) => {
                configuration.record_traces = *is_on;
            }
            DaemonConfigUpdateRequest::RecordProviderMessages(is_on) => {
                configuration.record_provider_messages = *is_on;
            }
        },
    }
}

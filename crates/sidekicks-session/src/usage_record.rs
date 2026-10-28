//! The daemon's usage record, the drivers' usage sink: each metered delta becomes one
//! `usage.tokenCount.recorded` row on the run the reading belongs to, and each quota window a
//! provider pushed one `usage.rateLimit.updated` row under the machine's sentinel session, both
//! stamped with the account's credential generation read at the write. After each row the run's
//! token count, its rows' input and output read back from the log, is held to the token limit
//! admitted with the run, so a restart never counts a run from zero.

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::{
    UsageRateLimitUpdatedPayload, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, SafeSignedInt};
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_provider::driver::run_control::HelperTokenLimitParams;
use sidekicks_provider::port::usage_sink::{MeteredUsage, ProviderQuotaWindow, UsageSink};
use sidekicks_provider::run::delivery::{
    DeliveryBinding, InboundDelivery, LateAppendableRow, MachineScopedRow,
};
use sidekicks_provider::runtime_binding::store::read_binding;
use sidekicks_provider::usage_delta_accountant::UsageAxisCounts;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::connection::setup::open_database_reader;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};

use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::inbound::{InboundDispatchError, RunInboundDispatch};

/// The statements the usage record prepares on the shared read pool: a binding, an account's
/// credential generation, a helper's start and run, a run's admitted token limit and a run's token
/// count.
pub const USAGE_RECORD_STATEMENT_CAPACITY: usize = 5;

// The one statement the prior-emitted read prepares on its own connection.
const PRIOR_EMITTED_STATEMENT_CAPACITY: usize = 1;

const SELECT_CREDENTIAL_GENERATION_SQL: &str =
    "SELECT credential_generation FROM provider_accounts WHERE account_id = ?1";

// A helper's own run: the provider subagent the engine queued under the run of the helper's newest
// `agent.subagent.started` on the session by provider and id, just before that start, since a
// driver starts the helper's run and then writes its start, in that order.
static SELECT_HELPER_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let started = SessionEventType::AgentSubagentStarted;
    let queued = SessionEventType::AgentRunQueued;
    format!(
        "SELECT queued.run_id
  FROM session_events AS started
  JOIN session_events AS queued
    ON queued.session_id = started.session_id
   AND queued.category = '{queued_category}'
   AND queued.type = '{queued}'
   AND queued.sequence < started.sequence
  JOIN runs AS helper
    ON helper.run_id = queued.run_id
   AND helper.parent_run_id = started.run_id
   AND helper.reached_by = '{provider_subagent}'
  WHERE started.session_id = @session_id
    AND started.category = '{started_category}'
    AND started.type = '{started}'
    AND json_extract(started.payload, '$.provider') = @provider
    AND json_extract(started.payload, '$.subagentId') = @subagent_id
  ORDER BY started.sequence DESC, queued.sequence DESC
  LIMIT 1",
        started = started.as_str(),
        started_category = started.category().as_str(),
        queued = queued.as_str(),
        queued_category = queued.category().as_str(),
        provider_subagent = <&'static str>::from(ChildRunProvenance::ProviderSubagent),
    )
});

// The token limit admitted with the run: its own, else, for a provider subagent, that of the
// nearest run above it that carries one, whose admission its helper's run shares.
static SELECT_ADMITTED_TOKEN_LIMIT_SQL: LazyLock<String> = LazyLock::new(|| {
    let queued = SessionEventType::AgentRunQueued;
    format!(
        "WITH RECURSIVE lineage(run_id, depth) AS (
    SELECT @run_id, 0
    UNION ALL
    SELECT runs.parent_run_id, lineage.depth + 1
      FROM runs JOIN lineage ON runs.run_id = lineage.run_id
      WHERE runs.reached_by = '{provider_subagent}'
  )
  SELECT json_extract(queued.payload, '$.effectiveRunConfig.tokenLimit')
  FROM lineage JOIN session_events AS queued
    ON queued.session_id = @session_id
   AND queued.category = '{queued_category}'
   AND queued.type = '{queued}'
   AND queued.run_id = lineage.run_id
  WHERE json_extract(queued.payload, '$.effectiveRunConfig.tokenLimit') IS NOT NULL
  ORDER BY lineage.depth
  LIMIT 1",
        queued = queued.as_str(),
        queued_category = queued.category().as_str(),
        provider_subagent = <&'static str>::from(ChildRunProvenance::ProviderSubagent),
    )
});

// A run's token count: the input and output of its rows, never the cache or the reasoning.
static SELECT_TOKEN_COUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    let recorded = SessionEventType::UsageTokenCountRecorded;
    format!(
        "SELECT COALESCE(SUM(COALESCE(json_extract(payload, '$.inputTokens'), 0)
                   + COALESCE(json_extract(payload, '$.outputTokens'), 0)), 0)
  FROM session_events
  WHERE session_id = @session_id
    AND type = '{recorded}'
    AND run_id = @run_id",
        recorded = recorded.as_str(),
    )
});

// The sums of every axis the rows of a thread's own runs carry, the helpers' rows aside, since a
// helper meters a thread of its own; an axis no row reported is NULL.
static SELECT_PRIOR_EMITTED_SQL: LazyLock<String> = LazyLock::new(|| {
    let recorded = SessionEventType::UsageTokenCountRecorded;
    format!(
        "SELECT SUM(json_extract(payload, '$.inputTokens')),
       SUM(json_extract(payload, '$.cacheReadTokens')),
       SUM(json_extract(payload, '$.cacheWriteTokens')),
       SUM(json_extract(payload, '$.outputTokens')),
       SUM(json_extract(payload, '$.reasoningTokens')),
       SUM(json_extract(payload, '$.tokenCount'))
  FROM session_events
  WHERE session_id = @session_id
    AND type = '{recorded}'
    AND json_extract(payload, '$.subagentId') IS NULL
    AND run_id IN (SELECT run_id FROM runtime_bindings WHERE resume_handle = @thread_id)",
        recorded = recorded.as_str(),
    )
});

/// Why a usage reading or a quota window was not recorded, or the run it passed the limit of was
/// not stopped.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UsageRecordError {
    /// The reading came on a binding the daemon has no row for.
    #[error("runtime binding {} is not stored", binding_id.as_str())]
    BindingNotFound {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The account is not registered, so it has no credential generation.
    #[error("provider account {} is not registered", provider_account_id.as_str())]
    AccountNotRegistered {
        /// The account.
        provider_account_id: ProviderAccountId,
    },
    /// The provider attributed the reading to a helper whose start and run the log does not hold.
    #[error("helper {} has no start and run on its session", subagent_id.as_str())]
    HelperNotStarted {
        /// The helper.
        subagent_id: SubagentId,
    },
    /// A figure is past what the wire carries.
    #[error("a usage figure is past 2^53 - 1")]
    FigureOutOfRange,
    /// A quota window's figures do not fit its row.
    #[error("quota window {limit_id} does not fit its row")]
    QuotaWindowUnfit {
        /// The provider's name for the limit.
        limit_id: String,
    },
    /// The row's event was neither written nor absorbed.
    #[error(transparent)]
    Dispatch(#[from] InboundDispatchError),
    /// The run past its token limit was not stopped.
    #[error(transparent)]
    Stop(#[from] RunEngineError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the usage record could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("the read pool did not run the usage record's read")]
    Pool(#[from] DatabaseReadError),
    /// The prior-emitted read's own connection did not open.
    #[error("the usage record's connection did not open")]
    Open(#[from] CleanupFailures<rusqlite::Error>),
}

/// The usage record: the drivers' usage sink, which the daemon's start registers on their ports.
pub struct UsageRecord {
    pool: Arc<DatabaseReadPool>,
    database_path: PathBuf,
    dispatch: Arc<RunInboundDispatch>,
    engine: Arc<RunEngine>,
}

// Where a metered reading's row goes: the binding's run, or a helper's own run, and the account
// it is charged to with that account's generation.
struct MeteredTarget {
    run_id: RunId,
    provider_account_id: ProviderAccountId,
    credential_generation: CredentialGeneration,
}

impl UsageRecord {
    /// A record reading through `pool`, the prior sums through a connection of its own on the
    /// database at `database_path`, writing through `dispatch` and stopping runs through `engine`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        database_path: PathBuf,
        dispatch: Arc<RunInboundDispatch>,
        engine: Arc<RunEngine>,
    ) -> Self {
        Self {
            pool,
            database_path,
            dispatch,
            engine,
        }
    }

    // Records one metered reading and holds its run to its token limit.
    async fn record(&self, metered: MeteredUsage) -> Result<(), UsageRecordError> {
        let MeteredUsage {
            session_id,
            binding_id,
            subagent_id,
            delta,
        } = metered;
        let read_binding_id = binding_id.clone();
        let read_subagent_id = subagent_id.clone();
        let target = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_metered_target(reader, session_id, &read_binding_id, read_subagent_id)
            })
            .await?;
        let payload = UsageTokenCountRecordedPayload {
            session_id,
            run_id: Some(target.run_id),
            token_count: axis_figure(delta.axis_deltas.total)?,
            input_tokens: normalized_figure(
                delta.axis_deltas.input,
                delta.normalized_input_tokens,
            )?,
            output_tokens: normalized_figure(
                delta.axis_deltas.output,
                delta.normalized_output_tokens,
            )?,
            cache_read_tokens: axis_figure(delta.axis_deltas.cached_input)?,
            cache_write_tokens: axis_figure(delta.axis_deltas.cache_write_input)?,
            reasoning_tokens: axis_figure(delta.axis_deltas.reasoning_output)?,
            provider_account_id: target.provider_account_id.clone(),
            credential_generation: target.credential_generation,
            model_id: None,
            subagent_id: subagent_id.clone(),
            source_epoch: None,
            source_position: None,
        };
        self.dispatch
            .dispatch(InboundDelivery::SessionRow {
                binding: DeliveryBinding {
                    binding_id,
                    operation: None,
                },
                row: LateAppendableRow::UsageTokenCountRecorded(payload),
                content: None,
            })
            .await?;
        self.hold_to_token_limit(session_id, target.run_id, subagent_id)
            .await
    }

    // Stops the reading's run once its count is past the token limit admitted with it: the run
    // itself through the engine's stop, a helper's alone through its driver.
    async fn hold_to_token_limit(
        &self,
        session_id: SessionId,
        run_id: RunId,
        subagent_id: Option<SubagentId>,
    ) -> Result<(), UsageRecordError> {
        let passed = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_passed_token_limit(reader, session_id, run_id)
            })
            .await?;
        let Some(token_limit) = passed else {
            return Ok(());
        };
        match subagent_id {
            None => {
                self.engine.stop_at_token_limit(run_id, token_limit).await?;
            }
            Some(subagent_id) => {
                let params = HelperTokenLimitParams {
                    session_id,
                    run_id,
                    subagent_id,
                };
                self.engine
                    .stop_helper_at_token_limit(params, token_limit)
                    .await?;
            }
        }
        Ok(())
    }

    // Files each window as one row under the machine's sentinel session, stamped with the
    // account's credential generation read now.
    async fn record_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> Result<(), UsageRecordError> {
        let read_account_id = provider_account_id.clone();
        let credential_generation = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_credential_generation(reader, read_account_id)
            })
            .await?;
        for window in windows {
            let row = quota_window_row(
                window,
                provider.clone(),
                provider_account_id.clone(),
                credential_generation,
            )?;
            self.dispatch
                .dispatch(InboundDelivery::MachineEvent {
                    row: MachineScopedRow::UsageRateLimitUpdated(row),
                })
                .await?;
        }
        Ok(())
    }

    // The sums the rows of `thread_id`'s own runs on `session_id` carry, on a connection opened
    // for the read, since the drivers ask while they establish a thread.
    fn read_prior_sums(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<UsageAxisCounts, UsageRecordError> {
        let reader = open_database_reader(&self.database_path, PRIOR_EMITTED_STATEMENT_CAPACITY)?;
        let sums = reader
            .prepare_cached(&SELECT_PRIOR_EMITTED_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@thread_id": thread_id,
                },
                |row| {
                    let sum = |index: usize| -> rusqlite::Result<Option<u64>> {
                        row.get::<_, Option<i64>>(index)?
                            .map(|sum| {
                                u64::try_from(sum).map_err(|error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        index,
                                        rusqlite::types::Type::Integer,
                                        Box::new(error),
                                    )
                                })
                            })
                            .transpose()
                    };
                    Ok(UsageAxisCounts {
                        input: sum(0)?,
                        cached_input: sum(1)?,
                        cache_write_input: sum(2)?,
                        output: sum(3)?,
                        reasoning_output: sum(4)?,
                        total: sum(5)?,
                    })
                },
            )?;
        Ok(sums)
    }
}

impl UsageSink for UsageRecord {
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move { self.record(metered).await.map_err(Into::into) }.boxed()
    }

    fn record_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.record_windows(provider, provider_account_id, windows)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<UsageAxisCounts, Box<dyn Error + Send + Sync>> {
        Ok(self.read_prior_sums(session_id, thread_id)?)
    }
}

// The run a reading on `binding_id` is recorded on, the binding's own or, where the provider
// attributes it to a helper, the helper's, and the account it is charged to with that account's
// generation as the accounts table holds it now.
fn read_metered_target(
    reader: &Connection,
    session_id: SessionId,
    binding_id: &RuntimeBindingId,
    subagent_id: Option<SubagentId>,
) -> Result<MeteredTarget, UsageRecordError> {
    let binding =
        read_binding(reader, binding_id)?.ok_or_else(|| UsageRecordError::BindingNotFound {
            binding_id: binding_id.clone(),
        })?;
    let provider_account_id = binding.spawn_config.provider_account_id;
    let run_id = match subagent_id {
        None => binding.run_id,
        Some(subagent_id) => {
            read_helper_run(reader, session_id, &binding.provider_name, subagent_id)?
        }
    };
    let credential_generation = read_credential_generation(reader, provider_account_id.clone())?;
    Ok(MeteredTarget {
        run_id,
        provider_account_id,
        credential_generation,
    })
}

// The own run of `subagent_id`, which its rows are recorded on and counted toward.
fn read_helper_run(
    reader: &Connection,
    session_id: SessionId,
    provider: &ProviderId,
    subagent_id: SubagentId,
) -> Result<RunId, UsageRecordError> {
    let found = reader
        .prepare_cached(&SELECT_HELPER_RUN_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@provider": provider.as_str(),
                "@subagent_id": subagent_id.as_str(),
            },
            |row| text_column(row, 0, |text| RunId::new(&text)),
        )
        .optional()?;
    found.ok_or(UsageRecordError::HelperNotStarted { subagent_id })
}

// The account's credential generation as the accounts table holds it now.
fn read_credential_generation(
    reader: &Connection,
    provider_account_id: ProviderAccountId,
) -> Result<CredentialGeneration, UsageRecordError> {
    let generation = reader
        .prepare_cached(SELECT_CREDENTIAL_GENERATION_SQL)?
        .query_row([provider_account_id.as_str()], |row| {
            safe_int_column::<1>(row, 0)
        })
        .optional()?
        .ok_or(UsageRecordError::AccountNotRegistered {
            provider_account_id,
        })?;
    let generation = serde_json::from_value(Value::from(generation.get())).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    Ok(generation)
}

// The token limit admitted with `run_id` once its rows are past it; `None` while it is under, or
// unlimited.
fn read_passed_token_limit(
    reader: &Connection,
    session_id: SessionId,
    run_id: RunId,
) -> Result<Option<TokensPerRun>, UsageRecordError> {
    let session = session_id.text();
    let token_limit = reader
        .prepare_cached(&SELECT_ADMITTED_TOKEN_LIMIT_SQL)?
        .query_row(
            named_params! {
                "@session_id": session.as_str(),
                "@run_id": run_id.text().as_str(),
            },
            |row| safe_int_column::<1>(row, 0),
        )
        .optional()?;
    let Some(token_limit) = token_limit else {
        return Ok(None);
    };
    let count: i64 = reader.prepare_cached(&SELECT_TOKEN_COUNT_SQL)?.query_row(
        named_params! {
            "@session_id": session.as_str(),
            "@run_id": run_id.text().as_str(),
        },
        |row| row.get(0),
    )?;
    let is_past = u64::try_from(count).is_ok_and(|count| count > token_limit.get());
    Ok(is_past.then_some(TokensPerRun(token_limit)))
}

// An axis's figure on the row: absent where the reading carried none, never zero.
fn axis_figure(figure: Option<u64>) -> Result<Option<SafeInt<0>>, UsageRecordError> {
    figure
        .map(|figure| SafeInt::new(figure).ok_or(UsageRecordError::FigureOutOfRange))
        .transpose()
}

// A normalized figure on the row, present where the reading carried its axis.
fn normalized_figure(
    axis: Option<u64>,
    normalized: u64,
) -> Result<Option<SafeInt<0>>, UsageRecordError> {
    axis_figure(axis.map(|_| normalized))
}

// One window's `usage.rateLimit.updated` row.
fn quota_window_row(
    window: ProviderQuotaWindow,
    provider: ProviderId,
    provider_account_id: ProviderAccountId,
    credential_generation: CredentialGeneration,
) -> Result<UsageRateLimitUpdatedPayload, UsageRecordError> {
    let ProviderQuotaWindow {
        limit_id,
        window_mins,
        used_percent,
        resets_at,
    } = window;
    let unfit = || UsageRecordError::QuotaWindowUnfit {
        limit_id: limit_id.clone(),
    };
    let resets_at = match resets_at {
        Some(resets_at) => Some(WireInstant::from_timestamp(resets_at).ok_or_else(unfit)?),
        None => None,
    };
    Ok(UsageRateLimitUpdatedPayload {
        provider,
        provider_account_id,
        credential_generation,
        window_mins: SafeSignedInt::new(window_mins).ok_or_else(unfit)?,
        used_percent: Number::new(used_percent).ok_or_else(unfit)?,
        resets_at,
        limit_id: Some(BoundedText::new(limit_id.clone()).ok_or_else(unfit)?),
    })
}

#[cfg(test)]
mod tests;

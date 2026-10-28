//! The usage record's reads of the log and the accounts: where a reading's row goes, a run's tally
//! seeded once per run, the turn a provider's turn id opened, and a thread's prior counts.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::usage::UsageContainment;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::{EpochPosition, TURN_STARTED_EVENT_TYPE};
use sidekicks_provider::port::usage_sink::MeteredUsageOwner;
use sidekicks_provider::runtime_binding::store::read_binding;
use sidekicks_provider::usage_delta_accountant::UsageAxisCounts;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, readable_event_sql, session_read_bound,
};

use crate::run::engine::usage_tallies::RunUsageTally;
use crate::run::read::RunStateReader;
use crate::transcript::turn_attribution::RunTurnReads;
use crate::usage_record::UsageRecordError;

const SELECT_CREDENTIAL_GENERATION_SQL: &str =
    "SELECT credential_generation FROM provider_accounts WHERE account_id = ?1";

// A helper's own run, as the newest start of the helper on the session by provider and id names
// it.
static SELECT_HELPER_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let started = SessionEventType::AgentSubagentStarted;
    format!(
        "SELECT json_extract(payload, '$.childRunId')
  FROM session_events
  WHERE session_id = @session_id
    AND category = '{started_category}'
    AND type = '{started}'
    AND json_extract(payload, '$.provider') = @provider
    AND json_extract(payload, '$.subagentId') = @subagent_id
    AND json_extract(payload, '$.childRunId') IS NOT NULL
  ORDER BY sequence DESC
  LIMIT 1",
        started = started.as_str(),
        started_category = started.category().as_str(),
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

// The newest turn of the run the provider opened under its own turn id, through the log's
// run-and-type index.
static SELECT_TURN_OPENING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT sequence FROM session_events AS event
  WHERE session_id = @session_id AND type = '{TURN_STARTED_EVENT_TYPE}' AND run_id = @run_id
    AND json_extract(payload, '$.providerTurnId') = @provider_turn_id AND {}
  ORDER BY sequence DESC
  LIMIT 1",
        readable_event_sql("event")
    )
});

// The cumulative counts the rows of a thread's own runs carry, the helpers' rows aside, since a
// helper meters a thread of its own; an axis no row reported is NULL. A row's input is put back to
// the provider's raw figure by adding the cache reads and writes its containment took out.
static SELECT_PRIOR_EMITTED_SQL: LazyLock<String> = LazyLock::new(|| {
    let recorded = SessionEventType::UsageTokenCountRecorded;
    let subtracted = serde_json::to_value(UsageContainment::ConfirmedSubtracted)
        .expect("a closed enum serializes");
    let subtracted = subtracted
        .as_str()
        .expect("a unit variant serializes to its name");
    format!(
        "SELECT SUM(json_extract(payload, '$.inputTokens')
           + CASE WHEN json_extract(payload, '$.containment') = '{subtracted}'
               THEN COALESCE(json_extract(payload, '$.cacheReadTokens'), 0)
                  + COALESCE(json_extract(payload, '$.cacheWriteTokens'), 0)
               ELSE 0 END),
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

/// Where a metered reading's row goes: the binding's run or a helper's own run, none for a side
/// question, and the account it is charged to with that account's generation.
pub(super) struct MeteredTarget {
    /// The run the row is recorded on and counted toward, `None` for a side question's.
    pub(super) run_id: Option<RunId>,
    /// The account the reading is charged to.
    pub(super) provider_account_id: ProviderAccountId,
    /// That account's credential generation as the accounts table holds it now.
    pub(super) credential_generation: CredentialGeneration,
}

/// The target of a reading on `binding_id` that is `owner`'s. Fails as the binding, the helper's
/// start or the account is missing, or a read fails.
pub(super) fn read_metered_target(
    reader: &Connection,
    session_id: SessionId,
    binding_id: &RuntimeBindingId,
    owner: &MeteredUsageOwner,
) -> Result<MeteredTarget, UsageRecordError> {
    let binding =
        read_binding(reader, binding_id)?.ok_or_else(|| UsageRecordError::BindingNotFound {
            binding_id: binding_id.clone(),
        })?;
    let provider_account_id = binding.spawn_config.provider_account_id;
    let run_id = match owner {
        MeteredUsageOwner::Run => Some(binding.run_id),
        MeteredUsageOwner::Helper(subagent_id) => Some(read_helper_run(
            reader,
            session_id,
            &binding.provider_name,
            subagent_id,
        )?),
        MeteredUsageOwner::SideQuestion => None,
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
    subagent_id: &SubagentId,
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
    found.ok_or_else(|| UsageRecordError::HelperNotStarted {
        subagent_id: subagent_id.clone(),
    })
}

/// The account's credential generation as the accounts table holds it now. Fails with
/// [`UsageRecordError::AccountNotRegistered`] for an account the table does not hold.
pub(super) fn read_credential_generation(
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

/// `run_id`'s tally as its log stands, read at its first report: the token limit admitted with it
/// and, under a limit, the count of its rows so far; `None` for a run that has ended or that the
/// daemon has no row for, which no limit stops.
pub(super) fn read_tally_seed(
    reader: &Connection,
    session_id: SessionId,
    run_id: RunId,
) -> Result<Option<RunUsageTally>, UsageRecordError> {
    let is_live = RunStateReader::new(reader)
        .read_run(&run_id)?
        .is_some_and(|run| !run.state.is_terminal());
    if !is_live {
        return Ok(None);
    }
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
        .optional()?
        .map(TokensPerRun);
    // An unlimited run is never held to a count.
    let token_count = if token_limit.is_none() {
        0
    } else {
        let count: i64 = reader.prepare_cached(&SELECT_TOKEN_COUNT_SQL)?.query_row(
            named_params! {
                "@session_id": session.as_str(),
                "@run_id": run_id.text().as_str(),
            },
            |row| row.get(0),
        )?;
        u64::try_from(count).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?
    };
    Ok(Some(RunUsageTally {
        token_limit,
        token_count,
        is_stopped: false,
        turn_opening: None,
    }))
}

/// The epoch and turn of `run_id`'s newest turn the provider opened under `provider_turn_id`, as
/// the run stood once that turn started; `None` when no such turn is in the readable log.
pub(super) fn read_turn_opening(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: SessionId,
    run_id: RunId,
    provider_turn_id: &str,
) -> Result<Option<EpochPosition>, UsageRecordError> {
    let read_bound = session_read_bound(read_damaged_from_sequence, &session_id, None);
    let opening: Option<i64> = reader
        .prepare_cached(&SELECT_TURN_OPENING_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_id": run_id.text().as_str(),
                "@provider_turn_id": provider_turn_id,
                "@read_bound": read_bound,
            },
            |row| row.get(0),
        )
        .optional()?;
    let Some(opening) = opening else {
        return Ok(None);
    };
    let standing = RunTurnReads::new(reader, read_damaged_from_sequence).read_standing_before(
        &session_id,
        &run_id,
        opening + 1,
    )?;
    Ok(Some(standing))
}

/// The cumulative counts the rows of `thread_id`'s own runs on `session_id` carry, each axis as
/// the provider counted it.
pub(super) fn read_prior_emitted(
    reader: &Connection,
    session_id: SessionId,
    thread_id: &str,
) -> Result<UsageAxisCounts, UsageRecordError> {
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

//! The daemon's usage record, the drivers' usage sink: each metered delta becomes one
//! `usage.tokenCount.recorded` row on the run the reading belongs to, or on the session for a side
//! question's, and each quota window a provider pushed one `usage.rateLimit.updated` row under the
//! machine's sentinel session, both stamped with the account's credential generation read at the
//! write. A row the provider attributes to one of its turns is stamped with the turn that opened,
//! so it ranks there wherever it arrives. Each run's reports are taken one at a time against a
//! tally the engine keeps from the run's first report, seeded once from the log, so a restart
//! never counts a run from zero and no report reads the run's rows again.

mod reads;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::usage::{
    UsageRateLimitUpdatedPayload, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, SafeSignedInt};
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_provider::driver::run_control::HelperTokenLimitParams;
use sidekicks_provider::port::usage_sink::{
    MeteredUsage, MeteredUsageOwner, ProviderQuotaWindow, UsageSink,
};
use sidekicks_provider::run::delivery::{
    DeliveryBinding, InboundDelivery, LateAppendableRow, MachineScopedRow, SessionScopedRow,
};
use sidekicks_provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

use crate::run::engine::usage_tallies::RunUsageTally;
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::inbound::{InboundDispatchError, RunInboundDispatch};
use crate::transcript::turn_attribution::TurnAttributionError;
use crate::usage_record::reads::{
    MeteredTarget, read_credential_generation, read_metered_target, read_prior_emitted,
    read_tally_seed, read_turn_opening,
};

/// The statements the usage record prepares on the shared read pool: a binding, an account's
/// credential generation, a helper's run, a run's state, its admitted token limit and its token
/// count, the turn a provider's turn id opened with the run's rollbacks and turns before it, and a
/// thread's prior counts.
pub const USAGE_RECORD_STATEMENT_CAPACITY: usize = 10;

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
    /// The turn a provider's turn id opened could not be read.
    #[error(transparent)]
    TurnOpening(#[from] TurnAttributionError),
}

/// The usage record: the drivers' usage sink, which the daemon's start registers on their ports.
pub struct UsageRecord {
    pool: Arc<DatabaseReadPool>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    dispatch: Arc<RunInboundDispatch>,
    engine: Arc<RunEngine>,
}

impl UsageRecord {
    /// A record reading through `pool`, a damaged session's log only before its damage as
    /// `read_damaged_from_sequence` answers, writing through `dispatch` and stopping runs through
    /// `engine`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
        dispatch: Arc<RunInboundDispatch>,
        engine: Arc<RunEngine>,
    ) -> Self {
        Self {
            pool,
            read_damaged_from_sequence,
            dispatch,
            engine,
        }
    }

    // Records one metered reading and holds its run to its token limit.
    async fn record(&self, metered: MeteredUsage) -> Result<(), UsageRecordError> {
        let MeteredUsage {
            session_id,
            binding_id,
            owner,
            delta,
        } = metered;
        let read_binding_id = binding_id.clone();
        let read_owner = owner.clone();
        let target = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_metered_target(reader, session_id, &read_binding_id, &read_owner)
            })
            .await?;
        let helper = match owner {
            MeteredUsageOwner::Helper(subagent_id) => Some(subagent_id),
            MeteredUsageOwner::Run | MeteredUsageOwner::SideQuestion => None,
        };
        let mut payload = usage_row(session_id, &target, helper.clone(), &delta)?;
        let Some(run_id) = target.run_id else {
            // A side question's usage belongs to the session, counted toward no run.
            self.dispatch
                .dispatch(InboundDelivery::SessionEvent {
                    row: SessionScopedRow::UsageTokenCountRecorded(payload),
                })
                .await?;
            return Ok(());
        };
        let slot = self.engine.run_usage_tally(run_id);
        let mut tally = slot.lock().await;
        if tally.is_none() {
            *tally = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    read_tally_seed(reader, session_id, run_id)
                })
                .await?;
            if tally.is_none() {
                self.engine.forget_run_usage_tally(run_id, &slot);
            }
        }
        if let Some(provider_turn_id) = delta.attributed_turn_id {
            let opening = self
                .read_turn_opening(tally.as_mut(), session_id, run_id, provider_turn_id)
                .await?;
            if let Some(opening) = opening {
                payload.source_epoch = Some(opening.epoch);
                payload.source_position = Some(opening.position);
            }
        }
        let row_tokens = row_token_count(&payload);
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
        // A run that has ended is stopped by no limit.
        let Some(tally) = tally.as_mut() else {
            return Ok(());
        };
        tally.token_count = tally.token_count.saturating_add(row_tokens);
        self.hold_to_token_limit(tally, session_id, run_id, helper)
            .await
    }

    // The turn `provider_turn_id` opened on `run_id`, kept on the run's tally for the reports of
    // that turn that follow.
    async fn read_turn_opening(
        &self,
        tally: Option<&mut RunUsageTally>,
        session_id: SessionId,
        run_id: RunId,
        provider_turn_id: String,
    ) -> Result<Option<EpochPosition>, UsageRecordError> {
        if let Some(RunUsageTally {
            turn_opening: Some((kept_turn_id, opening)),
            ..
        }) = tally.as_deref()
            && *kept_turn_id == provider_turn_id
        {
            return Ok(*opening);
        }
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        let read_turn_id = provider_turn_id.clone();
        let opening = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_turn_opening(
                    reader,
                    read_damaged_from_sequence.as_ref(),
                    session_id,
                    run_id,
                    &read_turn_id,
                )
            })
            .await?;
        if let Some(tally) = tally {
            tally.turn_opening = Some((provider_turn_id, opening));
        }
        Ok(opening)
    }

    // Stops the reading's run once its count is past the token limit admitted with it, once: the
    // run itself through the engine's stop, a helper's alone through its driver. A stop that
    // failed is asked again at the run's next report.
    async fn hold_to_token_limit(
        &self,
        tally: &mut RunUsageTally,
        session_id: SessionId,
        run_id: RunId,
        helper: Option<SubagentId>,
    ) -> Result<(), UsageRecordError> {
        let Some(token_limit) = tally.token_limit else {
            return Ok(());
        };
        if tally.is_stopped || tally.token_count <= token_limit.0.get() {
            return Ok(());
        }
        match helper {
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
        tally.is_stopped = true;
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
        thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async move {
            self.pool
                .read(ReadLength::Short, move |reader| {
                    read_prior_emitted(reader, session_id, &thread_id)
                })
                .await
                .map_err(Into::into)
        }
        .boxed()
    }
}

// The row of `delta` on `target`, unstamped, attributed to `helper` where one is named.
fn usage_row(
    session_id: SessionId,
    target: &MeteredTarget,
    helper: Option<SubagentId>,
    delta: &MeteredUsageDelta,
) -> Result<UsageTokenCountRecordedPayload, UsageRecordError> {
    Ok(UsageTokenCountRecordedPayload {
        session_id,
        run_id: target.run_id,
        token_count: axis_figure(delta.axis_deltas.total)?,
        input_tokens: normalized_figure(delta.axis_deltas.input, delta.normalized_input_tokens)?,
        output_tokens: normalized_figure(delta.axis_deltas.output, delta.normalized_output_tokens)?,
        cache_read_tokens: axis_figure(delta.axis_deltas.cached_input)?,
        cache_write_tokens: axis_figure(delta.axis_deltas.cache_write_input)?,
        reasoning_tokens: axis_figure(delta.axis_deltas.reasoning_output)?,
        containment: delta.containment,
        provider_account_id: target.provider_account_id.clone(),
        credential_generation: target.credential_generation,
        model_id: None,
        subagent_id: helper,
        source_epoch: None,
        source_position: None,
    })
}

// What a row adds to its run's token count: its input and output, never the cache or the
// reasoning.
fn row_token_count(payload: &UsageTokenCountRecordedPayload) -> u64 {
    let figure = |figure: Option<SafeInt<0>>| figure.map_or(0, SafeInt::get);
    figure(payload.input_tokens).saturating_add(figure(payload.output_tokens))
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

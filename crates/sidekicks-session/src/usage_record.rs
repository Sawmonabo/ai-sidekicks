//! The daemon's usage record, the drivers' usage sink: each metered delta becomes one
//! `usage.tokenCount.recorded` row on the run the reading belongs to, or on the session for a side
//! question's, and each quota window a provider pushed or an account's own limits read answered
//! one `usage.rateLimit.updated` row under the machine's sentinel session, both stamped with the
//! account's credential generation read at the write. A row the provider attributes to one of its
//! turns is stamped with the turn that opened, so it ranks there wherever it arrives. A priced
//! request becomes one `usage.cost.updated` per account its rows were charged to, on the session
//! with no binding, so a request priced after its run ended is recorded all the same. Each run's
//! reports are taken one at a time against a tally the engine keeps from the run's first report,
//! seeded once from the log, so a restart never counts a run from zero and no report reads the
//! run's rows again. A run past its token limit is stopped on a task of its own, so a report never
//! waits on a driver.

pub(crate) mod reads;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::usage::{
    UsageCostSource, UsageCostUpdatedPayload, UsagePricedEvent, UsageRateLimitUpdatedPayload,
    UsageRateLimitWindowKey, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, PROVIDER_QUOTA_DEFAULT_LIMIT_ID, ProviderAccountId,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{SafeInt, SafeSignedInt};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_provider::driver::run_control::HelperStopParams;
use sidekicks_provider::port::usage_sink::{
    MeteredUsage, MeteredUsageOwner, PricedRequest, PricedUsageRow, ProviderQuotaWindow,
    RecordedUsage, UsageSink,
};
use sidekicks_provider::run::delivery::{
    DeliveryBinding, InboundDelivery, InboundOutcome, LateAppendableRow, MachineScopedRow,
    SessionScopedRow,
};
use sidekicks_provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;

use crate::run::engine::RunEngine;
use crate::run::engine::usage_tallies::{RunUsageTally, RunUsageTallySlot, TokenLimitStop};
use crate::run::inbound::{InboundDispatchError, RunInboundDispatch};
use crate::transcript::turn_attribution::TurnAttributionError;
use crate::usage_record::reads::{
    MeteredTarget, StoredQuotaWindow, read_credential_generation, read_metered_target,
    read_prior_emitted, read_request_recorded, read_run_at, read_stored_windows, read_tally_seed,
    read_thread_speed_at, read_turn_opening,
};

/// The statements the usage record prepares on the shared read pool: a binding, an account's
/// credential generation and its stored quota windows, a helper's run, a run's state, its admitted
/// token limit and its token count, the turn a provider's turn id opened with the run's rollbacks
/// and turns before it, a thread's prior counts, whether an account holds a request, and a
/// session's thread tier and run at an instant.
pub const USAGE_RECORD_STATEMENT_CAPACITY: usize = 14;

// The windows of an account's whole set, as each window's row carries them.
type UsageRateLimitWholeSet = BoundedVec<UsageRateLimitWindowKey, 1, { usize::MAX }>;

/// Why a usage reading or a quota window was not recorded.
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
    // The token-limit stops under way, each on a task of its own.
    stops: TaskTracker,
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
            stops: TaskTracker::new(),
        }
    }

    /// Waits for every token-limit stop under way, which the daemon's stop does before the drivers
    /// shut down, so no stop outlives the driver it calls.
    pub async fn stop(&self) {
        self.stops.close();
        self.stops.wait().await;
    }

    // Records one metered reading and holds its run to its token limit, answering the row written
    // and where it was charged; `None` where the dispatch wrote nothing.
    async fn record(
        &self,
        metered: MeteredUsage,
    ) -> Result<Option<RecordedUsage>, UsageRecordError> {
        let MeteredUsage {
            session_id,
            binding_id,
            owner,
            delta,
            provider_account_id,
        } = metered;
        let read_binding_id = binding_id.clone();
        let read_owner = owner.clone();
        let kept_helper_run = match &owner {
            MeteredUsageOwner::Helper(subagent_id) => {
                self.engine.helper_run(&binding_id, subagent_id)
            }
            MeteredUsageOwner::Run | MeteredUsageOwner::Session => None,
        };
        let target = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_metered_target(
                    reader,
                    session_id,
                    &read_binding_id,
                    &read_owner,
                    kept_helper_run,
                    provider_account_id,
                )
            })
            .await?;
        let helper = match owner {
            MeteredUsageOwner::Helper(subagent_id) => {
                if kept_helper_run.is_none()
                    && let Some(helper_run_id) = target.run_id
                {
                    self.engine.keep_helper_run(
                        binding_id.clone(),
                        subagent_id.clone(),
                        helper_run_id,
                    );
                }
                Some(subagent_id)
            }
            MeteredUsageOwner::Run | MeteredUsageOwner::Session => None,
        };
        let mut payload = usage_row(session_id, &target, helper.clone(), &delta)?;
        let Some(run_id) = target.run_id else {
            // The session's own spend, counted toward no run.
            let outcome = self
                .dispatch
                .dispatch(InboundDelivery::SessionEvent {
                    row: SessionScopedRow::UsageTokenCountRecorded(Box::new(payload)),
                })
                .await?;
            return Ok(recorded_usage(&outcome, target, helper));
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
        let outcome = self
            .dispatch
            .dispatch(InboundDelivery::SessionRow {
                binding: DeliveryBinding {
                    binding_id,
                    operation: None,
                },
                row: LateAppendableRow::UsageTokenCountRecorded(Box::new(payload)),
                content: None,
            })
            .await?;
        let recorded = recorded_usage(&outcome, target, helper.clone());
        // A run that has ended is stopped by no limit.
        let Some(tally) = tally.as_mut() else {
            return Ok(recorded);
        };
        tally.token_count = tally.token_count.saturating_add(row_tokens);
        self.hold_to_token_limit(tally, &slot, session_id, run_id, helper);
        Ok(recorded)
    }

    // Writes one `usage.cost.updated` per account `request`'s rows name, in the order the accounts
    // first appear, on the session with no binding, all in one write, so a failure keeps none.
    async fn record_request_cost(&self, request: PricedRequest) -> Result<(), UsageRecordError> {
        let PricedRequest {
            session_id,
            model_id,
            cost_source,
            rows,
        } = request;
        let mut accounts: Vec<(ProviderAccountId, Vec<PricedUsageRow>)> = Vec::new();
        for row in rows {
            let account_id = &row.row.provider_account_id;
            match accounts
                .iter_mut()
                .find(|(account, _)| account == account_id)
            {
                Some((_, account_rows)) => account_rows.push(row),
                None => accounts.push((account_id.clone(), vec![row])),
            }
        }
        let payloads = accounts
            .into_iter()
            .map(|(_, account_rows)| {
                cost_row(session_id, model_id.clone(), cost_source, account_rows)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let Some(costs) = BoundedVec::new(payloads) else {
            return Ok(());
        };
        self.dispatch
            .dispatch(InboundDelivery::SessionEvent {
                row: SessionScopedRow::UsageCostUpdated(costs),
            })
            .await?;
        Ok(())
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

    // Starts the stop of the reading's run once its count is past the token limit admitted with
    // it, once, on a task of its own, so the report never waits on a driver or a session's task:
    // the run itself through the engine's stop, a helper's alone through its driver. The task marks
    // the tally in `slot` stopped once the stop goes through; one that failed is logged and asked
    // again at the run's next report.
    fn hold_to_token_limit(
        &self,
        tally: &mut RunUsageTally,
        slot: &RunUsageTallySlot,
        session_id: SessionId,
        run_id: RunId,
        helper: Option<SubagentId>,
    ) {
        let Some(token_limit) = tally.token_limit else {
            return;
        };
        if tally.limit_stop != TokenLimitStop::Unasked || tally.token_count <= token_limit.0.get() {
            return;
        }
        tally.limit_stop = TokenLimitStop::InFlight;
        let engine = Arc::clone(&self.engine);
        let slot = Arc::clone(slot);
        self.stops.spawn(
            async move {
                let stopped = match helper {
                    None => engine.stop_at_token_limit(run_id, token_limit).await,
                    Some(subagent_id) => {
                        let params = HelperStopParams {
                            session_id,
                            run_id,
                            subagent_id,
                        };
                        engine.stop_helper_at_token_limit(params, token_limit).await
                    }
                };
                if let Err(error) = &stopped {
                    tracing::warn!(
                        run_id = %run_id,
                        error = error as &(dyn Error + 'static),
                        "a run past its token limit was not stopped; its next report asks again"
                    );
                }
                // A run that ended meanwhile keeps this slot nowhere, so no report reads the mark.
                if let Some(tally) = slot.lock().await.as_mut() {
                    tally.limit_stop = match stopped {
                        Ok(()) => TokenLimitStop::Stopped,
                        Err(_) => TokenLimitStop::Unasked,
                    };
                }
            }
            .instrument(tracing::Span::current()),
        );
    }

    // Files each window as one row under the machine's sentinel session, stamped with the
    // account's credential generation read now, each marked with every window of the set where
    // the set is the account's whole one. A whole set that says nothing the stored windows do not
    // files nothing, so a read every few minutes grows the log only when a figure moved.
    async fn record_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
        is_whole_set: bool,
    ) -> Result<(), UsageRecordError> {
        if windows.is_empty() {
            return Ok(());
        }
        let whole_set = if is_whole_set {
            Some(whole_set_keys(&windows)?)
        } else {
            None
        };
        let read_account_id = provider_account_id.clone();
        let (credential_generation, stored) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let stored = if is_whole_set {
                    Some(read_stored_windows(reader, &read_account_id)?)
                } else {
                    None
                };
                Ok::<_, UsageRecordError>((
                    read_credential_generation(reader, read_account_id)?,
                    stored,
                ))
            })
            .await?;
        let rows = windows
            .into_iter()
            .map(|window| {
                quota_window_row(
                    window,
                    provider.clone(),
                    provider_account_id.clone(),
                    credential_generation,
                    whole_set.clone(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if stored.is_some_and(|stored| is_stored_set(&rows, &stored)) {
            return Ok(());
        }
        for row in rows {
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
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async move { self.record(metered).await.map_err(Into::into) }.boxed()
    }

    fn record_cost(
        &self,
        request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move { self.record_request_cost(request).await.map_err(Into::into) }.boxed()
    }

    fn record_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.record_windows(provider, provider_account_id, windows, false)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn record_whole_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.record_windows(provider, provider_account_id, windows, true)
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

    fn is_request_recorded(
        &self,
        provider_account_id: ProviderAccountId,
        request_key: String,
    ) -> BoxFuture<'_, Result<bool, Box<dyn Error + Send + Sync>>> {
        async move {
            self.pool
                .read(ReadLength::Short, move |reader| {
                    read_request_recorded(reader, provider_account_id.as_str(), &request_key)
                })
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn read_thread_speed_at(
        &self,
        session_id: SessionId,
        at: WireInstant,
    ) -> BoxFuture<'_, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        async move {
            self.pool
                .read(ReadLength::Short, move |reader| {
                    read_thread_speed_at(reader, session_id, at.as_str())
                })
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn read_run_at(
        &self,
        session_id: SessionId,
        at: WireInstant,
    ) -> BoxFuture<'_, Result<Option<RunId>, Box<dyn Error + Send + Sync>>> {
        async move {
            self.pool
                .read(ReadLength::Short, move |reader| {
                    read_run_at(reader, session_id, at.as_str())
                })
                .await
                .map_err(Into::into)
        }
        .boxed()
    }
}

// The row of `delta` on `target`, unstamped, attributed to `helper` where one is named, with the
// request facts a later repricing reads.
fn usage_row(
    session_id: SessionId,
    target: &MeteredTarget,
    helper: Option<SubagentId>,
    delta: &MeteredUsageDelta,
) -> Result<UsageTokenCountRecordedPayload, UsageRecordError> {
    let figures = delta
        .row_figures()
        .ok_or(UsageRecordError::FigureOutOfRange)?;
    Ok(UsageTokenCountRecordedPayload {
        session_id,
        run_id: target.run_id,
        token_count: figures.total,
        input_tokens: figures.input,
        output_tokens: figures.output,
        cache_read_tokens: figures.cache_read,
        cache_write_tokens: figures.cache_write,
        reasoning_tokens: figures.reasoning,
        containment: delta.containment,
        provider_account_id: target.provider_account_id.clone(),
        credential_generation: target.credential_generation,
        model_id: delta.request.model_id.clone(),
        subagent_id: helper,
        request_key: delta.request.request_key.clone(),
        speed: delta.request.speed.clone(),
        processing_region: delta.request.processing_region.clone(),
        cache_write_extended_tokens: figures.cache_write_extended,
        web_search_requests: figures.web_searches,
        thread_speed: delta.request.thread_speed.clone(),
        source_epoch: None,
        source_position: None,
    })
}

// What `outcome` wrote of a row on `target`, attributed to `helper` where one is named; `None`
// where nothing was written.
fn recorded_usage(
    outcome: &InboundOutcome,
    target: MeteredTarget,
    helper: Option<SubagentId>,
) -> Option<RecordedUsage> {
    outcome.event_id().map(|event_id| RecordedUsage {
        event_id: event_id.clone(),
        run_id: target.run_id,
        provider_account_id: target.provider_account_id,
        subagent_id: helper,
    })
}

// One account's `usage.cost.updated` of a request: each of `rows`' events with its share, their
// sum, and the run and the helper every row was charged to, each `None` where the rows disagree.
// Unstamped, since each token row carries its own stamp.
fn cost_row(
    session_id: SessionId,
    model_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    cost_source: UsageCostSource,
    rows: Vec<PricedUsageRow>,
) -> Result<UsageCostUpdatedPayload, UsageRecordError> {
    let mut charged_to: Option<(Option<RunId>, Option<SubagentId>)> = None;
    let mut total: u64 = 0;
    let mut priced_events = Vec::with_capacity(rows.len());
    for PricedUsageRow {
        row,
        cost_usd_micros,
    } in rows
    {
        total = total
            .checked_add(cost_usd_micros.0.get())
            .ok_or(UsageRecordError::FigureOutOfRange)?;
        match &mut charged_to {
            None => charged_to = Some((row.run_id, row.subagent_id)),
            Some((run_id, subagent_id)) => {
                if *run_id != row.run_id {
                    *run_id = None;
                }
                if *subagent_id != row.subagent_id {
                    *subagent_id = None;
                }
            }
        }
        priced_events.push(UsagePricedEvent {
            event_id: row.event_id,
            cost_usd_micros,
        });
    }
    let (run_id, subagent_id) =
        charged_to.expect("each account's rows hold the row that named the account");
    Ok(UsageCostUpdatedPayload {
        session_id,
        run_id,
        cost_usd_micros: UsdMicros(SafeInt::new(total).ok_or(UsageRecordError::FigureOutOfRange)?),
        model_id: Some(model_id),
        subagent_id,
        cost_source,
        priced_events: BoundedVec::new(priced_events)
            .expect("each account's rows hold the row that named the account"),
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

// Every window of a non-empty set, by its limit and length, as each of its rows names the set.
fn whole_set_keys(
    windows: &[ProviderQuotaWindow],
) -> Result<UsageRateLimitWholeSet, UsageRecordError> {
    let keys = windows
        .iter()
        .map(|window| {
            let unfit = || UsageRecordError::QuotaWindowUnfit {
                limit_id: window.limit_id.clone(),
            };
            Ok(UsageRateLimitWindowKey {
                limit_id: Some(BoundedText::new(window.limit_id.clone()).ok_or_else(unfit)?),
                window_mins: SafeSignedInt::new(window.window_mins).ok_or_else(unfit)?,
            })
        })
        .collect::<Result<Vec<_>, UsageRecordError>>()?;
    Ok(BoundedVec::new(keys).expect("the caller hands a set of at least one window"))
}

// Whether `rows`, an account's whole set, are the stored windows as they stand: the same windows,
// each with the same share used, reset and generation.
fn is_stored_set(rows: &[UsageRateLimitUpdatedPayload], stored: &[StoredQuotaWindow]) -> bool {
    rows.len() == stored.len()
        && rows.iter().all(|row| {
            let limit_id = row
                .limit_id
                .as_ref()
                .map_or(PROVIDER_QUOTA_DEFAULT_LIMIT_ID, BoundedText::as_str);
            stored.iter().any(|window| {
                window.limit_id == limit_id
                    && window.window_mins == row.window_mins.get()
                    && window.used_percent.to_bits() == row.used_percent.get().to_bits()
                    && window.resets_at.as_deref()
                        == row.resets_at.as_ref().map(WireInstant::as_str)
                    && window.credential_generation == row.credential_generation
            })
        })
}

// One window's `usage.rateLimit.updated` row.
fn quota_window_row(
    window: ProviderQuotaWindow,
    provider: ProviderId,
    provider_account_id: ProviderAccountId,
    credential_generation: CredentialGeneration,
    whole_set: Option<UsageRateLimitWholeSet>,
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
        whole_set,
    })
}

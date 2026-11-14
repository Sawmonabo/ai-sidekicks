//! The daemon's usage record, the drivers' usage sink: each metered delta becomes one
//! `usage.tokenCount.recorded` row on the run the reading belongs to, or on the session for a side
//! question's, and each quota window a provider pushed or an account's own limits read answered
//! one `usage.rateLimit.updated` row under the machine's sentinel session, both stamped with the
//! account's credential generation read at the write. A row the provider attributes to one of its
//! turns is stamped with the turn that opened, so it ranks there wherever it arrives. A priced
//! request becomes one `usage.cost.updated` per account its rows were charged to, on the session
//! with no binding, so a request priced after its run ended is recorded all the same. Each run's
//! reports are taken one at a time against a tally the engine keeps from the run's first report,
//! seeded once from the log and the sightings that count toward it, so a restart never counts a
//! run from zero and no report reads the run's rows again. A sighting passed over on a run counts
//! its request's row toward the run where that row was the session's own, as its mark's own write
//! decides, so the stored record is the one account of it. A hand-over's readings are read one by
//! one and their writes queued together, so the store commits them as one where it can, each with
//! its own refusal. A run past its token limit is stopped on a task of its own, so a report never
//! waits on a driver.

mod quota_windows;
pub(crate) mod reads;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::event::usage::{
    UsageCostSource, UsageCostUpdatedPayload, UsagePricedEvent, UsageSighting,
    UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::account::usage_turns::sightings::{
    counted_record, is_sighting_passed_over, mark_sighting_statements, read_sighting_passed_over,
};
use sidekicks_provider::driver::run_control::HelperStopParams;
use sidekicks_provider::port::usage_sink::{
    MeteredUsage, MeteredUsageOwner, PricedRequest, PricedUsageRow, ProviderQuotaWindow,
    RecordedReading, RecordedUsage, UsageSink,
};
use sidekicks_provider::run::delivery::{
    DeliveryBinding, InboundDelivery, InboundOutcome, LateAppendableRow, SessionScopedRow,
};
use sidekicks_provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio_util::task::TaskTracker;
use tracing::Instrument as _;

use crate::run::engine::RunEngine;
use crate::run::engine::usage_tallies::{RunUsageTally, RunUsageTallySlot, TokenLimitStop};
use crate::run::inbound::{InboundDispatchError, RunInboundDispatch, SIGHTING_GUARD_INDEX};
use crate::transcript::turn_attribution::TurnAttributionError;
use crate::usage_record::reads::{
    MeteredTarget, read_counted_record_tokens, read_metered_target, read_prior_emitted,
    read_run_at, read_tally_seed, read_thread_speed_at, read_turn_opening,
};

/// The statements the usage record prepares on the shared read pool: a binding, an account's
/// credential generation and its stored quota windows, a helper's run, a run's state, its admitted
/// token limit and its token count, the turn a provider's turn id opened with the run's rollbacks
/// and turns before it, a thread's prior counts, a session's thread tier and run at an instant,
/// whether a sighting is passed over, and the tokens of a record's row.
pub const USAGE_RECORD_STATEMENT_CAPACITY: usize = 15;

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
    /// A sighting's mark was not written.
    #[error("a usage sighting's mark was not written")]
    Mark(#[from] WriteError),
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

// How a usage row's write with its sighting ended.
enum SightingWrite {
    // The row's event was written, or absorbed.
    Appended(InboundOutcome),
    // The sighting was its request's second or later, so its mark was written and no row; the
    // record whose row the mark counted toward the run, where it counted one.
    PassedOver { counted_record: Option<i64> },
    // The request's record moved since the store was read, so the sighting is decided again.
    Moved,
}

// A reading read and placed, its row built, waiting for its write: where it goes, whose it is,
// whether its sighting was passed over as the store was read, and the tally of the live run it
// counts toward.
struct PreparedReading {
    binding_id: RuntimeBindingId,
    target: MeteredTarget,
    helper: Option<SubagentId>,
    payload: UsageTokenCountRecordedPayload,
    is_passed_over: bool,
    tally: Option<RunUsageTallySlot>,
}

/// The usage record: the drivers' usage sink, which the daemon's start registers on their ports.
pub struct UsageRecord {
    pool: Arc<DatabaseReadPool>,
    // Where a sighting passed over writes its mark.
    writer: Arc<DatabaseWriter>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    dispatch: Arc<RunInboundDispatch>,
    engine: Arc<RunEngine>,
    // The token-limit stops under way, each on a task of its own.
    stops: TaskTracker,
}

impl UsageRecord {
    /// A record reading through `pool`, a damaged session's log only before its damage as
    /// `read_damaged_from_sequence` answers, writing rows through `dispatch` and a passed-over
    /// sighting's mark through `writer`, and stopping runs through `engine`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
        dispatch: Arc<RunInboundDispatch>,
        engine: Arc<RunEngine>,
    ) -> Self {
        Self {
            pool,
            writer,
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

    // Records each reading of one hand-over in order: each is read and placed first, then every
    // write is queued before any is awaited, so the writer commits them together, each in its own
    // write with its own refusal. Answers each reading's row, `None` where nothing was written.
    async fn record_together(
        &self,
        batch: Vec<MeteredUsage>,
    ) -> Vec<Result<Option<RecordedUsage>, UsageRecordError>> {
        let mut prepared = Vec::with_capacity(batch.len());
        for metered in batch {
            prepared.push(self.prepare(metered).await);
        }
        join_all(
            prepared
                .into_iter()
                .map(|prepared| async move { self.write_prepared(prepared?).await }),
        )
        .await
    }

    // Reads where `metered` goes and builds its row: its target, whether its sighting is passed
    // over, and, on a live run, the run's tally seeded once and the turn its provider's turn id
    // opened. The tally is let go before the write, so a hand-over's writes go out together.
    async fn prepare(&self, metered: MeteredUsage) -> Result<PreparedReading, UsageRecordError> {
        let MeteredUsage {
            session_id,
            binding_id,
            owner,
            delta,
            provider_account_id,
        } = metered;
        let read_binding_id = binding_id.clone();
        let read_owner = owner.clone();
        let read_sighting = delta.sighting.clone();
        let kept_helper_run = match &owner {
            MeteredUsageOwner::Helper(subagent_id) => {
                self.engine.helper_run(&binding_id, subagent_id)
            }
            MeteredUsageOwner::Run | MeteredUsageOwner::Session => None,
        };
        let (target, is_passed_over) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let target = read_metered_target(
                    reader,
                    session_id,
                    &read_binding_id,
                    &read_owner,
                    kept_helper_run,
                    provider_account_id,
                )?;
                let is_passed_over = match &read_sighting {
                    Some(sighting) => read_sighting_passed_over(reader, sighting)?,
                    None => false,
                };
                Ok::<_, UsageRecordError>((target, is_passed_over))
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
            return Ok(PreparedReading {
                binding_id,
                target,
                helper,
                payload,
                is_passed_over,
                tally: None,
            });
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
        drop(tally);
        Ok(PreparedReading {
            binding_id,
            target,
            helper,
            payload,
            is_passed_over,
            tally: Some(slot),
        })
    }

    // Writes `prepared`'s row or its sighting's mark, deciding again where its request's record
    // moved, then holds its run to its token limit with what it counted: its row's tokens, or the
    // tokens of the session's row its mark counted toward the run.
    async fn write_prepared(
        &self,
        prepared: PreparedReading,
    ) -> Result<Option<RecordedUsage>, UsageRecordError> {
        let PreparedReading {
            binding_id,
            target,
            helper,
            payload,
            mut is_passed_over,
            tally,
        } = prepared;
        let (recorded, counted_tokens) = loop {
            let delivery = || match target.run_id {
                None => InboundDelivery::SessionEvent {
                    row: SessionScopedRow::UsageTokenCountRecorded(Box::new(payload.clone())),
                },
                Some(_) => InboundDelivery::SessionRow {
                    binding: DeliveryBinding {
                        binding_id: binding_id.clone(),
                        operation: None,
                    },
                    row: LateAppendableRow::UsageTokenCountRecorded(Box::new(payload.clone())),
                    content: None,
                },
            };
            let written = self
                .write_sighted_row(
                    payload.sighting.as_ref(),
                    is_passed_over,
                    target.run_id,
                    delivery,
                )
                .await?;
            match written {
                SightingWrite::Appended(outcome) => {
                    break (
                        recorded_usage(&outcome, target, helper.clone()),
                        row_token_count(&payload),
                    );
                }
                SightingWrite::PassedOver {
                    counted_record: Some(record_id),
                } => break (None, self.read_counted_tokens(record_id).await?),
                SightingWrite::PassedOver {
                    counted_record: None,
                } => return Ok(None),
                SightingWrite::Moved => {
                    is_passed_over = self.read_sighting(payload.sighting.as_ref()).await?;
                }
            }
        };
        // The session's own spend counts toward no run, and a run that has ended is stopped by no
        // limit.
        if let (Some(slot), Some(run_id)) = (tally, payload.run_id) {
            let mut kept = slot.lock().await;
            if let Some(kept) = kept.as_mut() {
                kept.token_count = kept.token_count.saturating_add(counted_tokens);
                self.hold_to_token_limit(kept, &slot, payload.session_id, run_id, helper);
            }
        }
        Ok(recorded)
    }

    // Writes a usage row's sighting in one write, as the store was read: one `is_passed_over`
    // writes only its mark, seen on `run_id` where the row goes on one, passed over where it marked
    // the request's record or its source's id was recorded already; any other writes the row
    // `delivery` builds with its record opened in the row's own write, which the row's prelude
    // refuses where the record holds the request by now. Either answers moved where the store
    // changed since it was read.
    async fn write_sighted_row<'key>(
        &self,
        sighting: Option<&UsageSighting>,
        is_passed_over: bool,
        run_id: Option<RunId>,
        delivery: impl FnOnce() -> InboundDelivery<'key>,
    ) -> Result<SightingWrite, UsageRecordError> {
        if let Some(sighting) = sighting
            && is_passed_over
        {
            let marked = self
                .writer
                .write(Vec::from(mark_sighting_statements(sighting, run_id)))
                .await?;
            return Ok(if is_sighting_passed_over(&marked) {
                SightingWrite::PassedOver {
                    counted_record: counted_record(&marked),
                }
            } else {
                SightingWrite::Moved
            });
        }
        match (self.dispatch.dispatch(delivery()).await, sighting) {
            (Ok(outcome), _) => Ok(SightingWrite::Appended(outcome)),
            (Err(InboundDispatchError::Append(error)), Some(_))
                if error.refused_statement_index() == Some(SIGHTING_GUARD_INDEX) =>
            {
                Ok(SightingWrite::Moved)
            }
            (Err(error), _) => Err(error.into()),
        }
    }

    // Whether `sighting` is passed over as the store stands now; `false` for a row with none.
    async fn read_sighting(
        &self,
        sighting: Option<&UsageSighting>,
    ) -> Result<bool, UsageRecordError> {
        let Some(sighting) = sighting.cloned() else {
            return Ok(false);
        };
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, UsageRecordError>(read_sighting_passed_over(reader, &sighting)?)
            })
            .await
    }

    // The tokens of the row that opened `record_id`, which a mark just counted toward its run.
    async fn read_counted_tokens(&self, record_id: i64) -> Result<u64, UsageRecordError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                read_counted_record_tokens(reader, record_id)
            })
            .await
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
}

impl UsageSink for UsageRecord {
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async move {
            let prepared = self.prepare(metered).await?;
            Ok(self.write_prepared(prepared).await?)
        }
        .boxed()
    }

    fn record_metered_together(
        &self,
        batch: Vec<MeteredUsage>,
    ) -> BoxFuture<'_, Vec<RecordedReading>> {
        async move {
            self.record_together(batch)
                .await
                .into_iter()
                .map(|recorded| recorded.map_err(Into::into))
                .collect()
        }
        .boxed()
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
        sighting: delta.sighting.clone(),
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

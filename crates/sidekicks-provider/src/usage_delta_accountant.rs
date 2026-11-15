//! Turns a provider's cumulative token counters into per-turn usage deltas, resolves where a
//! request's cost comes from, and derives one window-telemetry update.
//!
//! A provider reports usage as a running total for its session, reset at no turn boundary, no
//! compaction and no resume, so forwarding each reading as a per-turn figure would re-count every
//! earlier turn. Each session meters every usage frame through one accountant:
//!
//! - One base register per provider thread and axis, advanced in stream order as each reading is
//!   consumed. A base copied at turn dispatch would let two interleaved turns each re-count the
//!   interval the other metered (readings 0, 100, 150 must yield 100 + 50).
//! - Each interval is attributed to the turn the frame itself names, not the turn open at arrival:
//!   a usage frame routinely lands after the next turn has opened.
//! - A fresh provider session bases at zero, since the provider's counter starts there. A
//!   provider-native resume bases at the daemon's own prior-emitted sum for the thread, never at
//!   the first reading after it.
//! - There is no compaction re-base: compaction does not touch the provider's counter, and a
//!   re-base would forgive every token before the boundary.
//! - Where the wire declares a per-turn figure beside the cumulative one, the derived interval is
//!   compared with it; a mismatch is a diagnostic, never a substitution.
//! - A cumulative axis never decreases within a session, so a decrease is a falsified declaration:
//!   floored at zero, re-based at the observed value, and reported.
//! - The normalized input is uncached input. The cached count is subtracted only where the
//!   breakdown's sum identity shows it sits inside the input figure; otherwise input is emitted
//!   unsubtracted, with a diagnostic, once per thread and turn, where the reading's declared total
//!   disagrees with it. A reading with no total has no identity to check.
//!
//! Readings arrive typed: a driver reports a usage member that is not a non-negative integer where
//! it reads the wire, so nothing here meets an unknown axis or a non-finite count.

use std::collections::HashMap;

use serde_json::{Value, json};
use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::event::usage::{UsageContainment, UsageCostSource, UsageSighting};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use strum::{IntoStaticStr, VariantArray};

use crate::driver::contract::account::WindowTurnSpend;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::pricing::quote::split_figure;
use crate::pricing::rule::RequestPricing;

/// A cumulative token axis a provider reading may carry: uncached input, cached input, cache-write
/// input, output, reasoning output, and the total. A driver maps its own wire members onto them.
/// `VARIANTS` lists them in the order a reading is metered, and each converts to its name in a
/// diagnostic's details.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, VariantArray, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum UsageTokenAxis {
    /// Input tokens, before any cached share is subtracted.
    Input,
    /// Input tokens read from the provider's cache.
    CachedInput,
    /// Input tokens written to the provider's cache.
    CacheWriteInput,
    /// Output tokens.
    Output,
    /// Output tokens spent on reasoning.
    ReasoningOutput,
    /// Every token, as the provider totals them.
    Total,
}

/// Token counts by axis, each present only where the source carried it: a cumulative reading, a
/// declared per-turn figure, a resume's prior-emitted sums or a reading's per-axis deltas.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageAxisCounts {
    /// Uncached input, or input before the cached share is subtracted.
    pub input: Option<u64>,
    /// Input read from the cache.
    pub cached_input: Option<u64>,
    /// Input written to the cache.
    pub cache_write_input: Option<u64>,
    /// Output.
    pub output: Option<u64>,
    /// Output spent on reasoning.
    pub reasoning_output: Option<u64>,
    /// The provider's total.
    pub total: Option<u64>,
}

impl UsageAxisCounts {
    /// The count on `axis`, if carried.
    pub(crate) const fn get(&self, axis: UsageTokenAxis) -> Option<u64> {
        match axis {
            UsageTokenAxis::Input => self.input,
            UsageTokenAxis::CachedInput => self.cached_input,
            UsageTokenAxis::CacheWriteInput => self.cache_write_input,
            UsageTokenAxis::Output => self.output,
            UsageTokenAxis::ReasoningOutput => self.reasoning_output,
            UsageTokenAxis::Total => self.total,
        }
    }

    fn set(&mut self, axis: UsageTokenAxis, count: u64) {
        let slot = match axis {
            UsageTokenAxis::Input => &mut self.input,
            UsageTokenAxis::CachedInput => &mut self.cached_input,
            UsageTokenAxis::CacheWriteInput => &mut self.cache_write_input,
            UsageTokenAxis::Output => &mut self.output,
            UsageTokenAxis::ReasoningOutput => &mut self.reasoning_output,
            UsageTokenAxis::Total => &mut self.total,
        };
        *slot = Some(count);
    }

    /// Each axis summed, saturating, present where either side carries it.
    pub(crate) fn added(self, other: Self) -> Self {
        self.combined(other, u64::saturating_add)
    }

    /// Each axis's larger count, present where either side carries it.
    pub(crate) fn larger(self, other: Self) -> Self {
        self.combined(other, u64::max)
    }

    fn combined(self, other: Self, combine: fn(u64, u64) -> u64) -> Self {
        let axis = |left, right| combine_count(left, right, combine);
        Self {
            input: axis(self.input, other.input),
            cached_input: axis(self.cached_input, other.cached_input),
            cache_write_input: axis(self.cache_write_input, other.cache_write_input),
            output: axis(self.output, other.output),
            reasoning_output: axis(self.reasoning_output, other.reasoning_output),
            total: axis(self.total, other.total),
        }
    }
}

/// One count combined by `combine`, present where either side carries it.
pub(crate) fn combine_count(
    left: Option<u64>,
    right: Option<u64>,
    combine: fn(u64, u64) -> u64,
) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(combine(left, right)),
        (left, right) => left.or(right),
    }
}

/// One cumulative usage reading, as a driver read it off a usage frame. `named_turn_id` is the
/// turn the frame names, `None` where the wire names none; `declared_per_turn` is the wire's own
/// per-turn figure, used only as a cross-check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CumulativeUsageReading {
    /// The provider thread the reading is for.
    pub(crate) thread_id: String,
    /// The turn the frame itself names, if any; the consumer otherwise resolves the turn from its
    /// own dispatch scope.
    pub(crate) named_turn_id: Option<String>,
    /// The cumulative counters.
    pub(crate) cumulative: UsageAxisCounts,
    /// The wire's per-turn figure, where it declares one.
    pub(crate) declared_per_turn: Option<UsageAxisCounts>,
    /// The request the reading's change belongs to and what prices it.
    pub(crate) request: UsageRequestFacts,
}

/// What a later repricing needs of the request a token row belongs to, beside its counts: its key,
/// model and selectors, and the counts priced apart from the token axes. Each is absent where the
/// provider named none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UsageRequestFacts {
    /// The model the provider attributes the request to.
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The provider's id of the request, shared by every row of that request.
    pub request_key: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The speed tier the request ran at, in the provider's word.
    pub speed: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The region the request was processed in, in the driver's region word.
    pub processing_region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The part of the row's cache-write change written at the longer cache lifetime.
    pub cache_write_extended_tokens: Option<u64>,
    /// The web searches the row's change ran.
    pub web_search_requests: Option<u64>,
    /// The speed tier the reading's thread declared when the reading was taken, which prices the
    /// requests of helpers that thread spawned.
    pub thread_speed: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
}

/// The cache read and write deltas, kept beside the normalized figures for diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageDiagnosticBand {
    /// The cached-input delta, zero where the reading carried none.
    pub cache_read_tokens_delta: u64,
    /// The cache-write delta, zero where the reading carried none.
    pub cache_write_tokens_delta: u64,
}

/// The per-turn delta derived from one cumulative reading. The normalized input is uncached input
/// where the containment identity confirmed the subtraction, and the raw input figure otherwise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeteredUsageDelta {
    /// The provider the reading came from.
    pub provider: ProviderId,
    /// The provider thread the reading is for.
    pub thread_id: String,
    /// The turn the frame named, if any.
    pub attributed_turn_id: Option<String>,
    /// Per-axis deltas against the thread's stream-ordered base registers.
    pub axis_deltas: UsageAxisCounts,
    /// The input figure a usage row carries.
    pub normalized_input_tokens: u64,
    /// The output figure a usage row carries.
    pub normalized_output_tokens: u64,
    /// Whether the cached input was subtracted.
    pub containment: UsageContainment,
    /// The cache split, for diagnostics.
    pub diagnostic_band: UsageDiagnosticBand,
    /// The request the change belongs to and what prices it.
    pub request: UsageRequestFacts,
    /// The sighting of the request the change came from, where its provider sees one request
    /// more than once, so a later sighting of it is passed over; `None` for a provider that does
    /// not.
    pub sighting: Option<UsageSighting>,
}

impl MeteredUsageDelta {
    /// Whether every count the row would carry is zero or absent: the axes, the longer-lifetime
    /// cache write and the searches, since a change of either of the last two alone is still spend.
    pub(crate) fn is_unchanged(&self) -> bool {
        let axes = &self.axis_deltas;
        [
            axes.input,
            axes.cached_input,
            axes.cache_write_input,
            axes.output,
            axes.reasoning_output,
            axes.total,
            self.request.cache_write_extended_tokens,
            self.request.web_search_requests,
        ]
        .into_iter()
        .all(|count| count.unwrap_or(0) == 0)
    }

    /// The delta's counts as a usage row carries them, each absent where the reading carried none;
    /// `None` when one passes the wire's integer range.
    pub fn row_figures(&self) -> Option<UsageRowFigures> {
        let figure = |figure: Option<u64>| match figure {
            Some(figure) => SafeInt::new(figure).map(Some),
            None => Some(None),
        };
        let axes = &self.axis_deltas;
        Some(UsageRowFigures {
            total: figure(axes.total)?,
            input: figure(axes.input.map(|_| self.normalized_input_tokens))?,
            output: figure(axes.output.map(|_| self.normalized_output_tokens))?,
            cache_read: figure(axes.cached_input)?,
            cache_write: figure(axes.cache_write_input)?,
            reasoning: figure(axes.reasoning_output)?,
            cache_write_extended: figure(self.request.cache_write_extended_tokens)?,
            web_searches: figure(self.request.web_search_requests)?,
        })
    }
}

/// A delta's counts as the wire's integers, the one reading the stored and the priced row share;
/// each is absent where the reading carried none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageRowFigures {
    /// Every token, as the provider totals them.
    pub total: Option<SafeInt<0>>,
    /// The normalized input.
    pub input: Option<SafeInt<0>>,
    /// The normalized output.
    pub output: Option<SafeInt<0>>,
    /// Input read from the cache.
    pub cache_read: Option<SafeInt<0>>,
    /// Input written to the cache.
    pub cache_write: Option<SafeInt<0>>,
    /// Output spent on reasoning.
    pub reasoning: Option<SafeInt<0>>,
    /// The cache write's part at the longer lifetime.
    pub cache_write_extended: Option<SafeInt<0>>,
    /// The web searches the change ran.
    pub web_searches: Option<SafeInt<0>>,
}

/// How a thread's base registers are established.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThreadBaseEstablishment {
    /// A daemon-created session: every axis bases at zero.
    Fresh,
    /// A provider-native resume: each axis bases at the sum the daemon already emitted for it.
    Resume {
        /// The prior-emitted cumulative sums, rebuilt from the session's record.
        prior_emitted_cumulative: UsageAxisCounts,
    },
}

/// Meters cumulative provider readings into per-turn deltas, one set of base registers per
/// thread. A decrease or an inconsistent reading goes to the diagnostic channel, never to spend.
#[derive(Debug)]
pub(crate) struct UsageDeltaAccountant {
    provider: ProviderId,
    base_registers_by_thread_id: HashMap<String, UsageAxisCounts>,
    // The turn each thread last reported a failed containment identity on, so a turn's every
    // reading after the first logs none.
    containment_reported_turn_by_thread_id: HashMap<String, Option<String>>,
}

impl UsageDeltaAccountant {
    /// An accountant for one session on `provider`, with no thread established.
    pub(crate) fn new(provider: ProviderId) -> Self {
        Self {
            provider,
            base_registers_by_thread_id: HashMap::new(),
            containment_reported_turn_by_thread_id: HashMap::new(),
        }
    }

    /// Establishes one thread's base registers, replacing any it had, which is what a resume of an
    /// already-metered thread needs.
    pub(crate) fn establish_thread(
        &mut self,
        thread_id: String,
        establishment: ThreadBaseEstablishment,
    ) {
        let base_registers = match establishment {
            ThreadBaseEstablishment::Fresh => UsageAxisCounts::default(),
            ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative,
            } => prior_emitted_cumulative,
        };
        self.base_registers_by_thread_id
            .insert(thread_id, base_registers);
    }

    /// Whether a thread's base registers have been established.
    pub(crate) fn has_thread(&self, thread_id: &str) -> bool {
        self.base_registers_by_thread_id.contains_key(thread_id)
    }

    /// The base registers of `thread_id`, each axis at the cumulative count the daemon has metered
    /// up to, `None` for a thread with none; a fork bases the conversation it starts on them.
    pub(crate) fn base_registers(&self, thread_id: &str) -> Option<UsageAxisCounts> {
        self.base_registers_by_thread_id.get(thread_id).copied()
    }

    /// Drops a thread's registers when its provider session ends.
    pub(crate) fn release_thread(&mut self, thread_id: &str) {
        self.base_registers_by_thread_id.remove(thread_id);
        self.containment_reported_turn_by_thread_id
            .remove(thread_id);
    }

    /// Meters one cumulative reading into a per-turn delta; `None` for a thread with no
    /// established base, since metering it would invent a zero base for a resume, and for a
    /// reading that changed nothing, a repeat, which records and prices nothing and is not
    /// cross-checked. The base registers advance either way.
    pub(crate) fn meter_reading(
        &mut self,
        reading: CumulativeUsageReading,
    ) -> Option<MeteredUsageDelta> {
        let declared_per_turn = reading.declared_per_turn;
        let delta = self
            .meter_change(reading)
            .filter(|delta| !delta.is_unchanged())?;
        if let Some(declared_per_turn) = &declared_per_turn {
            self.cross_check_declared_per_turn(&delta, declared_per_turn);
        }
        Some(delta)
    }

    // The delta one reading makes against its thread's base registers, advancing them; a reading
    // that changed nothing meters to a delta of zeros.
    fn meter_change(&mut self, reading: CumulativeUsageReading) -> Option<MeteredUsageDelta> {
        let base_registers = self
            .base_registers_by_thread_id
            .get_mut(&reading.thread_id)?;

        let mut axis_deltas = UsageAxisCounts::default();
        for &axis in UsageTokenAxis::VARIANTS {
            let Some(cumulative_value) = reading.cumulative.get(axis) else {
                continue;
            };
            let base_value = base_registers.get(axis).unwrap_or(0);
            if cumulative_value < base_value {
                // A decrease is a falsified declaration, not a negative charge: floor at zero,
                // re-base at the observed value, and report.
                emit_usage_diagnostic(
                    self.provider.clone(),
                    DriverDiagnosticKind::UsageDeltaFloorHit,
                    "declared-cumulative token axis decreased; emission floored at zero and the \
                     base register re-set to the observed reading",
                    [
                        ("threadId", json!(reading.thread_id)),
                        ("axis", json!(<&str>::from(axis))),
                        ("baseValue", json!(base_value)),
                        ("observedValue", json!(cumulative_value)),
                    ],
                );
            }
            axis_deltas.set(axis, cumulative_value.saturating_sub(base_value));
            // Advance in stream order, as each reading is consumed.
            base_registers.set(axis, cumulative_value);
        }

        let (normalized_input_tokens, containment) =
            self.normalize_input_tokens(&reading, &axis_deltas);

        Some(MeteredUsageDelta {
            provider: self.provider.clone(),
            thread_id: reading.thread_id,
            attributed_turn_id: reading.named_turn_id,
            axis_deltas,
            normalized_input_tokens,
            normalized_output_tokens: axis_deltas.output.unwrap_or(0),
            containment,
            diagnostic_band: UsageDiagnosticBand {
                cache_read_tokens_delta: axis_deltas.cached_input.unwrap_or(0),
                cache_write_tokens_delta: axis_deltas.cache_write_input.unwrap_or(0),
            },
            request: reading.request,
            sighting: None,
        })
    }

    // A mismatch between the wire's per-turn figure and the derived interval is recorded, and the
    // derived figure is kept.
    fn cross_check_declared_per_turn(
        &self,
        delta: &MeteredUsageDelta,
        declared_per_turn: &UsageAxisCounts,
    ) {
        for &axis in UsageTokenAxis::VARIANTS {
            let (Some(derived_interval), Some(declared_value)) =
                (delta.axis_deltas.get(axis), declared_per_turn.get(axis))
            else {
                continue;
            };
            if derived_interval != declared_value {
                emit_usage_diagnostic(
                    self.provider.clone(),
                    DriverDiagnosticKind::UsageCrossCheckMismatch,
                    "wire-declared per-turn figure disagrees with the derived interval; recorded \
                     as a cross-check and never substituted for it",
                    [
                        ("threadId", json!(delta.thread_id)),
                        ("namedTurnId", json!(delta.attributed_turn_id)),
                        ("axis", json!(<&str>::from(axis))),
                        ("derivedInterval", json!(derived_interval)),
                        ("declaredValue", json!(declared_value)),
                    ],
                );
            }
        }
    }

    // Input is input neither read from nor written to the cache only where `total == input +
    // output` on the cumulative counters: a total used up by input plus output leaves the cache
    // counts nowhere to live but inside input, so both are subtracted and every provider counts
    // the same thing. Otherwise input is emitted unsubtracted: an overstatement, surfaced once per
    // thread and turn rather than left a silent understatement where the reading declares a total
    // its counts disagree with; a reading with no total has no identity to fail.
    fn normalize_input_tokens(
        &mut self,
        reading: &CumulativeUsageReading,
        axis_deltas: &UsageAxisCounts,
    ) -> (u64, UsageContainment) {
        let input_delta = axis_deltas.input.unwrap_or(0);
        let cached_input_delta = axis_deltas.cached_input.unwrap_or(0);
        let cache_write_delta = axis_deltas.cache_write_input.unwrap_or(0);
        let cumulative = &reading.cumulative;
        // `None` where the reading leaves out the total, input or output the identity reads.
        let is_containment_confirmed = if let (Some(total), Some(input), Some(output)) =
            (cumulative.total, cumulative.input, cumulative.output)
        {
            Some(
                input.checked_add(output) == Some(total)
                    && cumulative
                        .cached_input
                        .unwrap_or(0)
                        .checked_add(cumulative.cache_write_input.unwrap_or(0))
                        .is_some_and(|cached| cached <= input),
            )
        } else {
            None
        };
        if is_containment_confirmed == Some(true) {
            return (
                input_delta
                    .saturating_sub(cached_input_delta)
                    .saturating_sub(cache_write_delta),
                UsageContainment::ConfirmedSubtracted,
            );
        }
        if is_containment_confirmed == Some(false)
            && (cached_input_delta > 0 || cache_write_delta > 0)
            && self
                .containment_reported_turn_by_thread_id
                .insert(reading.thread_id.clone(), reading.named_turn_id.clone())
                != Some(reading.named_turn_id.clone())
        {
            emit_usage_diagnostic(
                self.provider.clone(),
                DriverDiagnosticKind::UsageContainmentIdentityUnconfirmed,
                "token breakdown satisfies no containment identity; input emitted unsubtracted (a \
                 conservative overstatement surfaced for repair, never a silent understatement)",
                [
                    ("threadId", json!(reading.thread_id)),
                    ("namedTurnId", json!(reading.named_turn_id)),
                    ("inputDelta", json!(input_delta)),
                    ("cachedInputDelta", json!(cached_input_delta)),
                    ("cacheWriteDelta", json!(cache_write_delta)),
                ],
            );
        }
        (input_delta, UsageContainment::UnconfirmedUnsubtracted)
    }
}

/// One reading of `counts` on `provider`'s `thread_id`, metered from a zero base with `request` as
/// what prices it: the delta of spend no running sum holds, its input normalized as a session's
/// usage rows are.
pub(crate) fn meter_from_zero(
    provider: ProviderId,
    thread_id: String,
    counts: UsageAxisCounts,
    request: UsageRequestFacts,
) -> MeteredUsageDelta {
    let mut accountant = UsageDeltaAccountant::new(provider);
    accountant.establish_thread(thread_id.clone(), ThreadBaseEstablishment::Fresh);
    accountant
        .meter_change(CumulativeUsageReading {
            thread_id,
            named_turn_id: None,
            cumulative: counts,
            declared_per_turn: None,
            request,
        })
        .expect("the thread was just established")
}

/// What one request of a process that ran one turn and nothing else spent on `provider`: its
/// cumulative `counts` metered from a zero base, the input normalized as a session's usage rows
/// are, on `model_id` at `speed` as the provider names them; a request that spent nothing composes
/// its counts as they read. Fails with `None` where a count is past the wire's integer range.
pub(crate) fn compose_one_turn_spend(
    provider: ProviderId,
    model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    speed: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    counts: UsageAxisCounts,
) -> Option<WindowTurnSpend> {
    let delta = meter_from_zero(
        provider,
        "one-turn".to_owned(),
        counts,
        UsageRequestFacts::default(),
    );
    let figures = delta.row_figures()?;
    Some(WindowTurnSpend {
        model_id,
        speed,
        input_tokens: figures.input,
        output_tokens: figures.output,
        cache_read_tokens: figures.cache_read,
        cache_write_tokens: figures.cache_write,
        reasoning_tokens: figures.reasoning,
    })
}

/// Prices one request: a finite, non-negative provider figure (in micro-dollars, converted from the
/// provider's unit and rounded to a whole micro-dollar) is `providerReported`, shared across the
/// request's rows by `row_weights`; else the request takes what `derive`, its pricer, answers: a
/// `derivedExact` figure, or a hold for a price or a sign-in kind. A held request is never given a
/// made-up or zero cost.
pub(crate) fn resolve_cost_update_provenance(
    provider: ProviderId,
    provider_reported_cost_usd_micros: Option<f64>,
    row_weights: &[u64],
    derive: impl FnOnce() -> RequestPricing,
) -> RequestPricing {
    if let Some(reported_usd_micros) = provider_reported_cost_usd_micros {
        if let Some(cost_usd_micros) = whole_usd_micros(reported_usd_micros) {
            return RequestPricing::Priced {
                cost_source: UsageCostSource::ProviderReported,
                shares: split_figure(cost_usd_micros, row_weights),
            };
        }
        // Falling through silently would put a derived figure where the provider's was, with no
        // record that the provider's was refused.
        let is_finite = reported_usd_micros.is_finite();
        emit_usage_diagnostic(
            provider,
            DriverDiagnosticKind::UsageCrossCheckMismatch,
            "provider-reported cost was non-finite, negative or past the largest whole \
             micro-dollar figure; discarded in favor of the derivation ladder and surfaced rather \
             than dropped",
            [
                (
                    "providerReportedCostUsdMicros",
                    json!(is_finite.then_some(reported_usd_micros)),
                ),
                ("reportedCostIsFinite", json!(is_finite)),
            ],
        );
    }
    derive()
}

// A finite, non-negative figure rounded half to even to whole micro-dollars, `None` when it is not
// one or rounds past what the wire's integer holds. The sign is checked before rounding, since a
// figure just above -0.5 rounds to -0.0, which compares as not negative.
fn whole_usd_micros(usd_micros: f64) -> Option<UsdMicros> {
    if !usd_micros.is_finite() || usd_micros < 0.0 {
        return None;
    }
    let rounded = usd_micros.round_ties_even();
    // A float past `u64::MAX` saturates to it, which the wire's integer then refuses.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the value is whole, finite and non-negative, and the cast saturates"
    )]
    let whole = rounded as u64;
    SafeInt::new(whole).map(UsdMicros)
}

/// Window telemetry for one update. The counts travel both or neither, since a lone numerator or
/// denominator is an emitter bug; the source and `exceeded` are on every update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowTelemetry {
    /// The provider reported both counts.
    Counted {
        /// Where the figures came from.
        window_source: ContextWindowSource,
        /// Whether the used count reached the window.
        exceeded: bool,
        /// The tokens the conversation fills, as the provider reports them.
        window_used_tokens: u64,
        /// The window's ceiling.
        window_max_tokens: u64,
    },
    /// The frame carried at most one of the counts, so neither travels.
    CountsAbsent {
        /// Where the figures came from.
        window_source: ContextWindowSource,
        /// The wire's own limit signal.
        exceeded: bool,
    },
}

/// Derives one window-telemetry update. The used count is carried as reported, with nothing
/// subtracted. A frame with only half the pair yields the counts-absent arm, whose `exceeded` is
/// the caller's reading of the wire's own limit signal, since a fixed `false` would claim an
/// unmeasured window is not exceeded.
pub(crate) fn derive_window_telemetry(
    window_source: ContextWindowSource,
    window_used_tokens: Option<u64>,
    window_max_tokens: Option<u64>,
    exceeded_when_counts_absent: bool,
) -> WindowTelemetry {
    if let (Some(window_used_tokens), Some(window_max_tokens)) =
        (window_used_tokens, window_max_tokens)
    {
        WindowTelemetry::Counted {
            window_source,
            exceeded: window_used_tokens >= window_max_tokens,
            window_used_tokens,
            window_max_tokens,
        }
    } else {
        WindowTelemetry::CountsAbsent {
            window_source,
            exceeded: exceeded_when_counts_absent,
        }
    }
}

// Every usage diagnostic is about the session's provider with no single frame named, so the
// account and wire type are left out.
fn emit_usage_diagnostic<const N: usize>(
    provider: ProviderId,
    kind: DriverDiagnosticKind,
    disposition_reason: &str,
    details: [(&str, Value); N],
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider,
        provider_account_id: None,
        kind,
        raw_wire_type: None,
        disposition_reason: disposition_reason.to_owned(),
        details: details
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::diagnostics::RecordedEvents;
    use crate::driver::registry::test_provider;

    fn reading(thread_id: &str, input: u64) -> CumulativeUsageReading {
        CumulativeUsageReading {
            thread_id: thread_id.to_owned(),
            named_turn_id: None,
            cumulative: UsageAxisCounts {
                input: Some(input),
                ..UsageAxisCounts::default()
            },
            declared_per_turn: None,
            request: UsageRequestFacts::default(),
        }
    }

    fn input_delta(accountant: &mut UsageDeltaAccountant, thread_id: &str, input: u64) -> u64 {
        accountant
            .meter_reading(reading(thread_id, input))
            .and_then(|metered| metered.axis_deltas.input)
            .expect("the thread is established and the reading carries input")
    }

    #[test]
    fn meters_cumulative_readings_into_stream_ordered_deltas() {
        // Any provider: it only labels the accountant's diagnostics.
        let mut accountant = UsageDeltaAccountant::new(test_provider());
        accountant.establish_thread("fresh".to_owned(), ThreadBaseEstablishment::Fresh);
        assert_eq!(input_delta(&mut accountant, "fresh", 100), 100);
        assert_eq!(input_delta(&mut accountant, "fresh", 150), 50);

        // A repeat changes nothing, so it meters to no delta.
        assert_eq!(accountant.meter_reading(reading("fresh", 150)), None);

        // A decrease floors at zero, so it meters to no delta, and re-bases at the observed value.
        assert_eq!(accountant.meter_reading(reading("fresh", 50)), None);
        assert_eq!(input_delta(&mut accountant, "fresh", 70), 20);

        // A resume bases at the prior-emitted sum, never at zero.
        accountant.establish_thread(
            "resumed".to_owned(),
            ThreadBaseEstablishment::Resume {
                prior_emitted_cumulative: UsageAxisCounts {
                    input: Some(150),
                    ..UsageAxisCounts::default()
                },
            },
        );
        assert_eq!(input_delta(&mut accountant, "resumed", 200), 50);

        // A thread with no base is never metered.
        assert_eq!(accountant.meter_reading(reading("unknown", 10)), None);
    }

    #[test]
    fn subtracts_cache_reads_and_writes_from_input_contained_in_it() {
        let mut accountant = UsageDeltaAccountant::new(test_provider());
        accountant.establish_thread("thread".to_owned(), ThreadBaseEstablishment::Fresh);
        let metered = accountant
            .meter_reading(CumulativeUsageReading {
                thread_id: "thread".to_owned(),
                named_turn_id: None,
                cumulative: UsageAxisCounts {
                    input: Some(100),
                    cached_input: Some(30),
                    cache_write_input: Some(20),
                    output: Some(10),
                    total: Some(110),
                    ..UsageAxisCounts::default()
                },
                declared_per_turn: None,
                request: UsageRequestFacts::default(),
            })
            .expect("the thread is established");
        assert_eq!(metered.normalized_input_tokens, 50);
        assert_eq!(metered.containment, UsageContainment::ConfirmedSubtracted);
    }

    // Killed by the failed identity's diagnostic dropped, by one logged on every reading of a turn,
    // and by one logged for a reading that declares no total, which has no identity to check.
    #[test]
    fn a_disagreeing_total_is_diagnosed_once_per_thread_and_turn() {
        let reading = |turn: &str, scale: u64, total: Option<u64>| CumulativeUsageReading {
            thread_id: "thread".to_owned(),
            named_turn_id: Some(turn.to_owned()),
            cumulative: UsageAxisCounts {
                input: Some(100 * scale),
                cached_input: Some(30 * scale),
                output: Some(10 * scale),
                total: total.map(|total| total * scale),
                ..UsageAxisCounts::default()
            },
            declared_per_turn: None,
            request: UsageRequestFacts::default(),
        };
        let mut accountant = UsageDeltaAccountant::new(test_provider());
        accountant.establish_thread("thread".to_owned(), ThreadBaseEstablishment::Fresh);
        let recorded = RecordedEvents::default();

        let mut containments = Vec::new();
        recorded.record_during(|| {
            for (turn, scale, total) in [
                ("first", 1, Some(200)),
                ("first", 2, Some(200)),
                ("second", 3, Some(200)),
                ("second", 4, None),
            ] {
                let metered = accountant
                    .meter_reading(reading(turn, scale, total))
                    .expect("each reading grows every count");
                containments.push((metered.normalized_input_tokens, metered.containment));
            }
        });

        let unsubtracted = UsageContainment::UnconfirmedUnsubtracted;
        assert_eq!(
            containments,
            [
                (100, unsubtracted),
                (100, unsubtracted),
                (100, unsubtracted),
                (100, unsubtracted)
            ]
        );
        let containment_counter = DriverDiagnosticKind::UsageContainmentIdentityUnconfirmed
            .counter_name()
            .to_owned();
        assert_eq!(
            recorded.counters(),
            [containment_counter.clone(), containment_counter]
        );
    }

    #[test]
    fn refuses_a_negative_provider_cost_before_rounding_it() {
        let usd_micros = |whole| UsdMicros(SafeInt::new(whole).expect("a small whole figure"));
        let derived = || RequestPricing::Priced {
            cost_source: UsageCostSource::DerivedExact,
            shares: vec![usd_micros(7)],
        };

        // -0.4 rounds to -0.0, which a sign check made after rounding would let through.
        assert_eq!(
            resolve_cost_update_provenance(test_provider(), Some(-0.4), &[1], derived),
            derived()
        );
        assert_eq!(
            resolve_cost_update_provenance(test_provider(), Some(1_250.0), &[1], derived),
            RequestPricing::Priced {
                cost_source: UsageCostSource::ProviderReported,
                shares: vec![usd_micros(1_250)],
            }
        );
    }
}

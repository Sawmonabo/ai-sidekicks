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
//!   unsubtracted with a diagnostic.
//!
//! Readings arrive typed: a driver reports a usage member that is not a non-negative integer where
//! it reads the wire, so nothing here meets an unknown axis or a non-finite count.

use std::collections::HashMap;

use serde_json::{Value, json};
use sidekicks_contracts::context_window::ContextWindowSource;
use sidekicks_contracts::event::usage::UsageContainment;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::wire::integer::SafeInt;
use strum::{IntoStaticStr, VariantArray};

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

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
}

impl UsageDeltaAccountant {
    /// An accountant for one session on `provider`, with no thread established.
    pub(crate) fn new(provider: ProviderId) -> Self {
        Self {
            provider,
            base_registers_by_thread_id: HashMap::new(),
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
    }

    /// Meters one cumulative reading into a per-turn delta; `None` for a thread with no
    /// established base, since metering it would invent a zero base for a resume.
    pub(crate) fn meter_reading(
        &mut self,
        reading: CumulativeUsageReading,
    ) -> Option<MeteredUsageDelta> {
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

        self.cross_check_declared_per_turn(&reading, &axis_deltas);
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
        })
    }

    // A mismatch between the wire's per-turn figure and the derived interval is recorded, and the
    // derived figure is kept.
    fn cross_check_declared_per_turn(
        &self,
        reading: &CumulativeUsageReading,
        axis_deltas: &UsageAxisCounts,
    ) {
        let Some(declared_per_turn) = &reading.declared_per_turn else {
            return;
        };
        for &axis in UsageTokenAxis::VARIANTS {
            let (Some(derived_interval), Some(declared_value)) =
                (axis_deltas.get(axis), declared_per_turn.get(axis))
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
                        ("threadId", json!(reading.thread_id)),
                        ("namedTurnId", json!(reading.named_turn_id)),
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
    // the same thing. Otherwise input is emitted unsubtracted, an overstatement surfaced rather
    // than a silent understatement.
    fn normalize_input_tokens(
        &self,
        reading: &CumulativeUsageReading,
        axis_deltas: &UsageAxisCounts,
    ) -> (u64, UsageContainment) {
        let input_delta = axis_deltas.input.unwrap_or(0);
        let cached_input_delta = axis_deltas.cached_input.unwrap_or(0);
        let cache_write_delta = axis_deltas.cache_write_input.unwrap_or(0);
        let cumulative = &reading.cumulative;
        let is_containment_confirmed = if let (Some(total), Some(input), Some(output)) =
            (cumulative.total, cumulative.input, cumulative.output)
        {
            input.checked_add(output) == Some(total)
                && cumulative
                    .cached_input
                    .unwrap_or(0)
                    .checked_add(cumulative.cache_write_input.unwrap_or(0))
                    .is_some_and(|cached| cached <= input)
        } else {
            false
        };
        if is_containment_confirmed {
            return (
                input_delta
                    .saturating_sub(cached_input_delta)
                    .saturating_sub(cache_write_delta),
                UsageContainment::ConfirmedSubtracted,
            );
        }
        if cached_input_delta > 0 || cache_write_delta > 0 {
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

/// Where a cost update's figure came from.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the pricing step sets each request's cost and its source through this ladder"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageCostSource {
    /// The provider's own figure.
    ProviderReported,
    /// The price list's entry for the model's exact id, applied to the full breakdown.
    DerivedExact,
}

/// A price list's answer for one request: whole micro-dollars from the provider's full breakdown,
/// for a model the list carries by its exact id, never by family.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the pricing step sets each request's cost and its source through this ladder"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DerivedCostQuote {
    /// The derived cost.
    pub(crate) cost_usd_micros: UsdMicros,
}

/// The cost of one usage frame. A model the price list does not price gets no cost update: its
/// request is held with its exact tokens until the list prices it, never given a made-up or zero
/// cost.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the pricing step sets each request's cost and its source through this ladder"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CostUpdateResolution {
    /// A cost update with its figure and where the figure came from.
    CostUpdate {
        /// Where the figure came from.
        cost_source: UsageCostSource,
        /// The request's cost.
        cost_usd_micros: UsdMicros,
    },
    /// No figure yet; the request waits for the price list.
    HeldUntilPriced,
}

/// Resolves one cost update's source: a finite, non-negative provider figure (in micro-dollars,
/// converted from the provider's unit and rounded to a whole micro-dollar) is `providerReported`;
/// else a price-list quote is `derivedExact`; else the request is held until priced.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the pricing step sets each request's cost and its source through this ladder"
    )
)]
pub(crate) fn resolve_cost_update_provenance(
    provider: ProviderId,
    provider_reported_cost_usd_micros: Option<f64>,
    derived_quote: Option<DerivedCostQuote>,
) -> CostUpdateResolution {
    if let Some(reported_usd_micros) = provider_reported_cost_usd_micros {
        if let Some(cost_usd_micros) = whole_usd_micros(reported_usd_micros) {
            return CostUpdateResolution::CostUpdate {
                cost_source: UsageCostSource::ProviderReported,
                cost_usd_micros,
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
    match derived_quote {
        Some(quote) => CostUpdateResolution::CostUpdate {
            cost_source: UsageCostSource::DerivedExact,
            cost_usd_micros: quote.cost_usd_micros,
        },
        None => CostUpdateResolution::HeldUntilPriced,
    }
}

// A finite, non-negative figure rounded half to even to whole micro-dollars, `None` when it is not
// one or rounds past what the wire's integer holds. The sign is checked before rounding, since a
// figure just above -0.5 rounds to -0.0, which compares as not negative.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the pricing step sets each request's cost and its source through this ladder"
    )
)]
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
        assert_eq!(input_delta(&mut accountant, "fresh", 0), 0);
        assert_eq!(input_delta(&mut accountant, "fresh", 100), 100);
        assert_eq!(input_delta(&mut accountant, "fresh", 150), 50);

        // A decrease floors at zero and re-bases at the observed value.
        assert_eq!(input_delta(&mut accountant, "fresh", 50), 0);
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
            })
            .expect("the thread is established");
        assert_eq!(metered.normalized_input_tokens, 50);
        assert_eq!(metered.containment, UsageContainment::ConfirmedSubtracted);
    }

    #[test]
    fn refuses_a_negative_provider_cost_before_rounding_it() {
        let usd_micros = |whole| UsdMicros(SafeInt::new(whole).expect("a small whole figure"));
        let derived_quote = DerivedCostQuote {
            cost_usd_micros: usd_micros(7),
        };

        // -0.4 rounds to -0.0, which a sign check made after rounding would let through.
        assert_eq!(
            resolve_cost_update_provenance(test_provider(), Some(-0.4), Some(derived_quote)),
            CostUpdateResolution::CostUpdate {
                cost_source: UsageCostSource::DerivedExact,
                cost_usd_micros: usd_micros(7),
            }
        );
        assert_eq!(
            resolve_cost_update_provenance(test_provider(), Some(1_250.0), Some(derived_quote)),
            CostUpdateResolution::CostUpdate {
                cost_source: UsageCostSource::ProviderReported,
                cost_usd_micros: usd_micros(1_250),
            }
        );
    }
}

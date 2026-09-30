// Turns a provider's cumulative token counters into per-turn usage deltas.
//
// Both pinned providers report usage as a running total for the provider session. The counter
// resets at no turn boundary, no context compaction and no resume, so forwarding each reading as
// a per-turn figure re-counts every earlier turn (measured: 22x overstatement of session spend on
// a long thread). Each session's lifecycle band meters every usage frame through one accountant.
//
//   - One base register per provider thread and axis, advanced in stream order as each reading
//     is consumed. A base copied at turn dispatch would let two interleaved turns each re-count
//     the interval the other metered (readings 0, 100, 150 must yield 100 + 50).
//   - Each interval is attributed to the turn the frame itself names, not the turn open at
//     arrival: a usage frame routinely lands after the next turn has opened.
//   - A fresh provider session, replay-seeded included, bases at zero and its first reading
//     meters in full: the provider counter starts at zero and transcript injection spends
//     nothing. A provider-native resume bases at the daemon's own prior-emitted cumulative sum
//     for the thread, never at the first post-resume reading.
//   - There is no compaction re-base: compaction does not touch the provider's counter, and a
//     re-base would forgive every pre-boundary token.
//   - Where the wire declares a per-turn figure beside the cumulative one (the Codex breakdown's
//     `last`), the derived interval is compared with it. A mismatch is a diagnostic, never a
//     substitution, because the other pinned surface declares none and the declared figure's
//     behavior across resume and compaction is unprobed.
//   - A declared-cumulative axis never decreases within a session, so a decrease is a falsified
//     declaration: floored at zero, re-based at the observed value, and reported.
//   - The normalized input axis is uncached input. The cached count is subtracted only where the
//     breakdown's sum identity shows it sits inside the input figure (the vendor schema places
//     it beside the input member and proves nothing about nesting); otherwise input is emitted
//     unsubtracted with a diagnostic. Cache-read and cache-write stay on the diagnostic band,
//     because the `usage_telemetry` payload has no per-cache-axis member.

import type { ProviderName } from "@ai-sidekicks/contracts";

import { type DriverDiagnosticsEmitter } from "./driver-diagnostics.js";

// --------------------------------------------------------------------------
// Axes and readings.
// --------------------------------------------------------------------------

/**
 * The declared-cumulative token axes a provider reading may carry. The five non-total axes
 * mirror the Codex `TokenUsageBreakdown` members (`inputTokens`, `cachedInputTokens`,
 * `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`); `total` is its
 * `totalTokens`. The Claude driver carries a subset of the same axes.
 */
export type UsageTokenAxis =
  | "input"
  | "cachedInput"
  | "cacheWriteInput"
  | "output"
  | "reasoningOutput"
  | "total";

/** Cumulative counter values by axis, as read off one wire frame. */
export type CumulativeAxisReadings = Readonly<Partial<Record<UsageTokenAxis, number>>>;

// Readings come from untrusted provider output, so every entry is filtered against this list.
const USAGE_TOKEN_AXES: readonly UsageTokenAxis[] = Object.freeze([
  "input",
  "cachedInput",
  "cacheWriteInput",
  "output",
  "reasoningOutput",
  "total",
] as const);

const USAGE_TOKEN_AXIS_SET: ReadonlySet<string> = new Set<string>(USAGE_TOKEN_AXES);

/** Why one entry of a cumulative reading may not reach a base register. */
type RejectedAxisEntryReason = "unknown-axis" | "non-finite-value";

/** A cumulative reading split into the entries a register may accept and those it must not. */
interface PartitionedAxisEntries {
  readonly accepted: readonly (readonly [UsageTokenAxis, number])[];
  readonly rejected: readonly {
    readonly key: string;
    readonly reason: RejectedAxisEntryReason;
  }[];
}

// The one filter every register write and cross-check passes through. A non-finite value is
// rejected here because the floor arm cannot catch it: `NaN < 0` is false, so a NaN would enter
// the base register and make every later delta on that axis NaN, silently.
function partitionCumulativeAxisEntries(readings: CumulativeAxisReadings): PartitionedAxisEntries {
  const accepted: (readonly [UsageTokenAxis, number])[] = [];
  const rejected: { readonly key: string; readonly reason: RejectedAxisEntryReason }[] = [];
  for (const [key, value] of Object.entries(readings)) {
    if (!USAGE_TOKEN_AXIS_SET.has(key)) {
      rejected.push({ key, reason: "unknown-axis" });
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      rejected.push({ key, reason: "non-finite-value" });
      continue;
    }
    accepted.push([key as UsageTokenAxis, value]);
  }
  return { accepted, rejected };
}

/**
 * One cumulative usage reading, as consumed at the normalize boundary.
 *
 * `namedTurnId` is the turn the frame itself names (the Codex usage notification carries a
 * required `turnId`), or `null` where the wire names none; attribution then stays thread-scoped
 * and the consumer resolves the turn from its own dispatch scope. `declaredPerTurn` is the
 * wire's own per-turn figure (the Codex breakdown's `last`), used only as a cross-check.
 */
export interface CumulativeUsageReading {
  readonly threadId: string;
  readonly namedTurnId: string | null;
  readonly cumulative: CumulativeAxisReadings;
  readonly declaredPerTurn?: CumulativeAxisReadings | null;
}

// --------------------------------------------------------------------------
// The metered result.
// --------------------------------------------------------------------------

/**
 * The per-turn delta derived from one cumulative reading.
 *
 * `normalizedInputTokens` / `normalizedOutputTokens` are what the `usage_telemetry` payload
 * carries: input is uncached input where the containment identity confirmed subtraction, and the
 * raw input figure otherwise. `diagnosticBand` keeps the cache-read / cache-write split the
 * payload has no member for.
 */
export interface MeteredUsageDelta {
  readonly provider: ProviderName;
  readonly threadId: string;
  readonly attributedTurnId: string | null;
  /** Per-axis deltas against the thread's stream-ordered base registers. */
  readonly axisDeltas: Readonly<Partial<Record<UsageTokenAxis, number>>>;
  readonly normalizedInputTokens: number;
  readonly normalizedOutputTokens: number;
  readonly containment: "confirmed-subtracted" | "unconfirmed-unsubtracted";
  readonly diagnosticBand: {
    readonly cacheReadTokensDelta: number;
    readonly cacheWriteTokensDelta: number;
  };
}

/** How a thread's base registers are established. */
export type ThreadBaseEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedCumulative: CumulativeAxisReadings };

// --------------------------------------------------------------------------
// The accountant.
// --------------------------------------------------------------------------

/**
 * Meters cumulative provider readings into per-turn deltas, one set of base registers per
 * thread. Bad entries and inconsistent readings go to the diagnostics emitter, never to spend.
 */
export class UsageDeltaAccountant {
  readonly #provider: ProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  /** One base register per (thread, axis), advanced in stream order. */
  readonly #baseRegistersByThreadId = new Map<string, Map<UsageTokenAxis, number>>();

  constructor(options: {
    readonly provider: ProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
  }

  /**
   * Establish one thread's base registers. `fresh` (a daemon-created session, replay-seeded
   * included) bases every axis at zero. `resume` (a provider-native resume) bases each axis at
   * the prior-emitted cumulative sum rebuilt from the canonical record, so pre-resume spend is
   * never re-metered. Establishing an established thread replaces its registers, which is what
   * a resume of an already-metered thread needs.
   */
  establishThread(threadId: string, establishment: ThreadBaseEstablishment): void {
    const baseRegisters = new Map<UsageTokenAxis, number>();
    if (establishment.mode === "resume") {
      // Filtered like a metered reading: a non-finite prior sum would poison the base before any
      // reading, and the floor arm cannot recover a NaN base.
      const partitioned = partitionCumulativeAxisEntries(establishment.priorEmittedCumulative);
      for (const [axis, priorEmittedSum] of partitioned.accepted) {
        baseRegisters.set(axis, priorEmittedSum);
      }
      this.#reportRejectedAxisEntries(threadId, partitioned.rejected, "resume-establishment");
    }
    this.#baseRegistersByThreadId.set(threadId, baseRegisters);
  }

  /** Whether a thread's base registers have been established. */
  hasThread(threadId: string): boolean {
    return this.#baseRegistersByThreadId.has(threadId);
  }

  /** Drop a thread's registers when its provider session ends. */
  releaseThread(threadId: string): void {
    this.#baseRegistersByThreadId.delete(threadId);
  }

  /**
   * Meter one cumulative reading into a per-turn delta. Returns `null` for a thread with no
   * established base, because metering it would invent a zero base for a resume; the router
   * quarantines the frame.
   */
  meterReading(reading: CumulativeUsageReading): MeteredUsageDelta | null {
    const baseRegisters = this.#baseRegistersByThreadId.get(reading.threadId);
    if (baseRegisters === undefined) {
      return null;
    }

    const partitioned = partitionCumulativeAxisEntries(reading.cumulative);
    this.#reportRejectedAxisEntries(reading.threadId, partitioned.rejected, "metered-reading");

    const axisDeltas: Partial<Record<UsageTokenAxis, number>> = {};
    for (const [axis, cumulativeValue] of partitioned.accepted) {
      const baseValue = baseRegisters.get(axis) ?? 0;
      let axisDelta = cumulativeValue - baseValue;
      if (axisDelta < 0) {
        // A decrease is a falsified declaration, not a negative charge: floor at zero, re-base
        // at the observed value, and report.
        axisDelta = 0;
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "usage_delta_floor_hit",
          rawWireType: null,
          dispositionReason:
            "declared-cumulative token axis decreased; emission floored at zero and the base register re-set to the observed reading",
          details: {
            threadId: reading.threadId,
            axis,
            baseValue,
            observedValue: cumulativeValue,
          },
        });
      }
      axisDeltas[axis] = axisDelta;
      // Advance in stream order, as each reading is consumed.
      baseRegisters.set(axis, cumulativeValue);
    }

    this.#crossCheckDeclaredPerTurn(reading, axisDeltas);

    const partition = this.#partitionTokenAxes(reading, axisDeltas);

    return Object.freeze({
      provider: this.#provider,
      threadId: reading.threadId,
      attributedTurnId: reading.namedTurnId,
      axisDeltas: Object.freeze(axisDeltas),
      normalizedInputTokens: partition.normalizedInputTokens,
      normalizedOutputTokens: partition.normalizedOutputTokens,
      containment: partition.containment,
      diagnosticBand: Object.freeze({
        cacheReadTokensDelta: axisDeltas.cachedInput ?? 0,
        cacheWriteTokensDelta: axisDeltas.cacheWriteInput ?? 0,
      }),
    });
  }

  // Never silent: an axis that vanished from the emission is a measurement the daemon did not
  // take, and someone reconciling against a provider invoice needs the refusal on record.
  #reportRejectedAxisEntries(
    threadId: string,
    rejectedEntries: readonly { readonly key: string; readonly reason: RejectedAxisEntryReason }[],
    stage: "resume-establishment" | "metered-reading" | "declared-per-turn",
  ): void {
    for (const rejectedEntry of rejectedEntries) {
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "usage_axis_reading_rejected",
        rawWireType: null,
        dispositionReason:
          rejectedEntry.reason === "unknown-axis"
            ? "cumulative reading carried a key outside the closed axis list; refused before it reached a base register"
            : "cumulative reading carried a non-finite value; refused before it reached a base register, which the zero-floor arm cannot undo",
        details: { threadId, axisKey: rejectedEntry.key, reason: rejectedEntry.reason, stage },
      });
    }
  }

  // The wire-declared per-turn figure is compared with the derived interval; a mismatch is
  // recorded and the derived figure is kept.
  #crossCheckDeclaredPerTurn(
    reading: CumulativeUsageReading,
    axisDeltas: Readonly<Partial<Record<UsageTokenAxis, number>>>,
  ): void {
    const declaredPerTurn = reading.declaredPerTurn;
    if (declaredPerTurn === undefined || declaredPerTurn === null) {
      return;
    }
    const partitioned = partitionCumulativeAxisEntries(declaredPerTurn);
    this.#reportRejectedAxisEntries(reading.threadId, partitioned.rejected, "declared-per-turn");
    for (const [axis, declaredValue] of partitioned.accepted) {
      const derivedInterval = axisDeltas[axis];
      if (derivedInterval !== undefined && derivedInterval !== declaredValue) {
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "usage_cross_check_mismatch",
          rawWireType: null,
          dispositionReason:
            "wire-declared per-turn figure disagrees with the derived interval; recorded as a cross-check and never substituted for it",
          details: {
            threadId: reading.threadId,
            namedTurnId: reading.namedTurnId,
            axis,
            derivedInterval,
            declaredValue,
          },
        });
      }
    }
  }

  // Input is uncached input, subtracted only where `total === input + output` on the cumulative
  // members: a total used up by input plus output leaves the cached count nowhere to live but
  // inside input. Otherwise input is emitted unsubtracted with a diagnostic, an overstatement
  // that is surfaced rather than a silent understatement.
  #partitionTokenAxes(
    reading: CumulativeUsageReading,
    axisDeltas: Readonly<Partial<Record<UsageTokenAxis, number>>>,
  ): {
    normalizedInputTokens: number;
    normalizedOutputTokens: number;
    containment: "confirmed-subtracted" | "unconfirmed-unsubtracted";
  } {
    const inputDelta = axisDeltas.input ?? 0;
    const outputDelta = axisDeltas.output ?? 0;
    const cachedInputDelta = axisDeltas.cachedInput ?? 0;

    const cumulativeTotal = reading.cumulative.total;
    const cumulativeInput = reading.cumulative.input;
    const cumulativeOutput = reading.cumulative.output;
    const cumulativeCachedInput = reading.cumulative.cachedInput ?? 0;

    const containmentConfirmed =
      cumulativeTotal !== undefined &&
      cumulativeInput !== undefined &&
      cumulativeOutput !== undefined &&
      cumulativeTotal === cumulativeInput + cumulativeOutput &&
      cumulativeCachedInput <= cumulativeInput;

    if (containmentConfirmed) {
      return {
        normalizedInputTokens: Math.max(0, inputDelta - cachedInputDelta),
        normalizedOutputTokens: outputDelta,
        containment: "confirmed-subtracted",
      };
    }

    if (cachedInputDelta > 0) {
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "usage_containment_identity_unconfirmed",
        rawWireType: null,
        dispositionReason:
          "token breakdown satisfies no containment identity; input emitted unsubtracted (a conservative overstatement surfaced for repair, never a silent understatement)",
        details: {
          threadId: reading.threadId,
          namedTurnId: reading.namedTurnId,
          inputDelta,
          cachedInputDelta,
        },
      });
    }
    return {
      normalizedInputTokens: inputDelta,
      normalizedOutputTokens: outputDelta,
      containment: "unconfirmed-unsubtracted",
    };
  }
}

// --------------------------------------------------------------------------
// Cost-update provenance: three-tier cost resolution and native-cap provenance.
// --------------------------------------------------------------------------

/** The cost-status values of a cost update. */
type UsageCostStatus = "priced" | "unpriced";

/** The four cost-provenance values of a cost update. */
type UsageCostSource =
  | "provider_reported"
  | "derived_exact"
  | "derived_family_prefix"
  | "unpriced_native_cap";

/**
 * A pricing-table answer: whole micro-dollars derived from the provider's full breakdown, and
 * whether the model family matched exactly or by prefix. The lookup is injected; this module
 * owns provenance, never the price list.
 */
export interface DerivedCostQuote {
  readonly costUsdMicros: number;
  readonly familyMatch: "exact" | "prefix";
}

/**
 * The resolved outcome for one usage frame's cost. A genuinely unpriceable model is not a
 * `usage.cost_update`: it emits `usage.budget_warning { reason: 'unpriced-model' }`, so the
 * union keeps the two emissions apart. `costUsdMicros` is absent on the unpriced arm because no
 * per-update value is derivable; the USD bound lives on the run's `admittedUnpricedCapUsdMicros`.
 * The arms partition the two enums above, so widening an enum without placing the new value on
 * an arm is a compile error.
 */
export type CostUpdateResolution =
  | {
      readonly resolution: "cost-update";
      readonly costStatus: Extract<UsageCostStatus, "priced">;
      readonly costSource: Exclude<UsageCostSource, "unpriced_native_cap">;
      readonly costUsdMicros: number;
    }
  | {
      readonly resolution: "cost-update";
      readonly costStatus: Extract<UsageCostStatus, "unpriced">;
      readonly costSource: Extract<UsageCostSource, "unpriced_native_cap">;
      readonly costUsdMicros?: never;
    }
  | { readonly resolution: "budget-warning"; readonly reason: "unpriced-model" };

/**
 * Resolve one `usage.cost_update`'s provenance ladder: (a) a sanity-bounded provider-reported
 * cost (finite, non-negative, below the absurdity ceiling) is `provider_reported`, and gross
 * divergence from a derivable estimate is a diagnostic, never a halt; (b) else a cost derived
 * from the provider's full breakdown and the per-model-family pricing table is `derived_exact`
 * or `derived_family_prefix`; (c) a native-cap run is unpriced by provenance
 * (`unpriced_native_cap`, no `costUsdMicros`); (d) else a genuinely unpriceable model gets the
 * budget-warning arm, never a fabricated price or a zero cost. This never halts and never
 * branches on `costSource`.
 */
export function resolveCostUpdateProvenance(options: {
  readonly provider: ProviderName;
  /** The provider's own cost in micro-dollars, converted from its reported unit, or null. */
  readonly providerReportedCostUsdMicros: number | null;
  /** The pricing-table derivation, or null for an unpriceable model. */
  readonly derivedQuote: DerivedCostQuote | null;
  /** Whether this run was owner-admitted under a native cap. */
  readonly nativeCapAdmitted: boolean;
  readonly absurdityCeilingUsdMicros: number;
  /** Reported-vs-derived ratio beyond which divergence is diagnosed. */
  readonly grossDivergenceFactor: number;
  readonly diagnostics: DriverDiagnosticsEmitter;
}): CostUpdateResolution {
  const reportedUsdMicros = options.providerReportedCostUsdMicros;
  if (reportedUsdMicros !== null) {
    if (
      Number.isFinite(reportedUsdMicros) &&
      reportedUsdMicros >= 0 &&
      reportedUsdMicros < options.absurdityCeilingUsdMicros
    ) {
      const derivedUsdMicros = options.derivedQuote?.costUsdMicros ?? null;
      if (
        derivedUsdMicros !== null &&
        derivedUsdMicros > 0 &&
        (reportedUsdMicros > derivedUsdMicros * options.grossDivergenceFactor ||
          reportedUsdMicros * options.grossDivergenceFactor < derivedUsdMicros)
      ) {
        options.diagnostics.emit({
          provider: options.provider,
          kind: "usage_cross_check_mismatch",
          rawWireType: null,
          dispositionReason:
            "provider-reported cost grossly diverges from the derivable estimate; the reported provenance is kept and the divergence surfaced",
          details: {
            providerReportedCostUsdMicros: reportedUsdMicros,
            derivedEstimateUsdMicros: derivedUsdMicros,
            grossDivergenceFactor: options.grossDivergenceFactor,
          },
        });
      }
      return {
        resolution: "cost-update",
        costStatus: "priced",
        costSource: "provider_reported",
        costUsdMicros: reportedUsdMicros,
      };
    }
    // The sanity bound refused the wire's cost. Falling through silently would substitute a
    // daemon estimate for a provider figure with no record that they disagreed.
    options.diagnostics.emit({
      provider: options.provider,
      kind: "usage_cross_check_mismatch",
      rawWireType: null,
      dispositionReason:
        "provider-reported cost failed the sanity bound (non-finite, negative, or at/above the absurdity ceiling); discarded in favor of the derivation ladder and surfaced rather than dropped",
      details: {
        providerReportedCostUsdMicros: Number.isFinite(reportedUsdMicros)
          ? reportedUsdMicros
          : null,
        reportedCostIsFinite: Number.isFinite(reportedUsdMicros),
        absurdityCeilingUsdMicros: options.absurdityCeilingUsdMicros,
      },
    });
  }
  if (options.derivedQuote !== null) {
    return {
      resolution: "cost-update",
      costStatus: "priced",
      costSource:
        options.derivedQuote.familyMatch === "exact" ? "derived_exact" : "derived_family_prefix",
      costUsdMicros: options.derivedQuote.costUsdMicros,
    };
  }
  if (options.nativeCapAdmitted) {
    return { resolution: "cost-update", costStatus: "unpriced", costSource: "unpriced_native_cap" };
  }
  return { resolution: "budget-warning", reason: "unpriced-model" };
}

// --------------------------------------------------------------------------
// Window telemetry.
// --------------------------------------------------------------------------

/** Where a window figure came from. */
export type WindowSource = "provider_reported" | "model_default" | "estimated";

/**
 * Normalized window telemetry. The counts travel both or neither, since a lone numerator or
 * denominator is an emitter bug; `windowSource` and `exceeded` are on every emission.
 */
export type WindowTelemetry =
  | {
      readonly windowSource: WindowSource;
      readonly exceeded: boolean;
      readonly windowUsedTokens: number;
      readonly windowMaxTokens: number;
    }
  | {
      readonly windowSource: WindowSource;
      readonly exceeded: boolean;
      readonly windowUsedTokens?: never;
      readonly windowMaxTokens?: never;
    };

/**
 * Derive one window-telemetry update at the normalize boundary. The Codex driver supplies its
 * session baseline (a constant-overhead reading of about 12k tokens, taken from its capability
 * read) and the Claude driver supplies zero. A frame carrying only half the pair yields the
 * counts-absent arm, which fabricates no denominator and ships no lone numerator. There
 * `exceeded` is the caller's, taken from the wire's own limit signal, because a hard-coded
 * `false` would claim a window that was never measured is not exceeded.
 */
export function deriveWindowTelemetry(options: {
  readonly windowSource: WindowSource;
  /** The wire's used-tokens reading, or null where the frame carries none. */
  readonly rawUsedTokens: number | null;
  /** The window ceiling, or null where neither wire nor model declares one. */
  readonly windowMaxTokens: number | null;
  /** Session-constant overhead subtracted before use (Codex ~12k; Claude 0). */
  readonly sessionBaselineTokens: number;
  /** The wire's own limit signal, used only on the counts-absent arm. */
  readonly exceededWhenCountsAbsent: boolean;
}): WindowTelemetry {
  if (options.rawUsedTokens !== null && options.windowMaxTokens !== null) {
    const windowUsedTokens = Math.max(0, options.rawUsedTokens - options.sessionBaselineTokens);
    return {
      windowSource: options.windowSource,
      exceeded: windowUsedTokens >= options.windowMaxTokens,
      windowUsedTokens,
      windowMaxTokens: options.windowMaxTokens,
    };
  }
  return { windowSource: options.windowSource, exceeded: options.exceededWhenCountsAbsent };
}

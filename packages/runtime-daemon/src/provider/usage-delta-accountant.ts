// Usage-delta accountant (Plan-005 Phase 3, T3.11 — the NS-91 usage-delta leg).
//
// Both pinned providers report token usage as a RUNNING TOTAL for the provider
// session, not a figure for the turn that just completed: the counter resets at
// no turn boundary, at no context compaction, and on no resume. A normalizer
// forwarding each reading as though it described one turn re-counts every
// earlier turn on every later one — measured 22× overstatement of session
// spend on a long thread, landing on the `Spec-016 §Session Cost Receipt`
// committed-spend fold rather than on a display. This module is the single
// metering path both driver legs emit usage through — each session's lifecycle
// band constructs one and meters every routed usage frame through it — and it
// enforces
// I-005-11: a driver never emits a provider's cumulative counter as a per-turn
// figure, and no normalized token axis counts a token twice.
//
// The mechanism, per `Spec-005 §Required Behavior` (2026-08-28, PR #377
// round-1 fold):
//
//   - ONE BASE REGISTER PER PROVIDER THREAD AND AXIS, advanced in stream order
//     as each declared-cumulative reading is consumed. Never a base snapshot
//     copied at turn dispatch — two interleaved turns differencing against
//     copies of one starting value each re-count the interval the other
//     already metered (the 0 → 100 → 150 counterexample must yield 100 + 50).
//   - NAMED-TURN ATTRIBUTION: each interval attributes to the turn the metered
//     frame itself names, never to whichever turn is open at arrival. A usage
//     frame for one turn routinely lands after the next has opened; the
//     stream-ordered base with named-turn attribution meters that late
//     interval to its own turn instead of flooring it or crediting the newer
//     turn.
//   - TWO-ARMED BASE ESTABLISHMENT: a fresh provider session — replay-seeded
//     included — bases at ZERO and its first reading meters in full (the
//     provider counter starts at zero, transcript injection spends nothing,
//     and the first turn's large input is real billed spend); a
//     provider-native resume bases at THE DAEMON'S OWN PRIOR-EMITTED
//     CUMULATIVE SUM for that thread, rebuilt from the canonical record
//     (ADR-029), never at the first post-resume reading.
//   - NO COMPACTION RE-BASE: this class exposes no compaction entry point at
//     all — the provider's counter is unaffected by a compaction, and an API
//     that re-based there would silently forgive every pre-boundary token.
//   - CORROBORATING CROSS-CHECK: where the wire declares a per-turn figure
//     beside the cumulative one (the Codex breakdown's `last`), the derived
//     interval is asserted equal to it for the naming turn; a mismatch is a
//     diagnostic, never a substitution, because the other pinned surface
//     declares no per-turn figure and the declared figure's behavior across
//     resume and compaction is unprobed.
//   - FLOOR, NEVER NEGATIVE: a declared-cumulative axis is monotonic
//     non-decreasing within a session, so an observed decrease is a falsified
//     declaration — floored at zero, re-based at the observed value, and
//     reported as a diagnostic; never emitted as negative spend, never silent.
//   - PARTITION: the normalized input axis is UNCACHED input, subtracted only
//     where the breakdown's own sum identity confirms the cached component
//     sits inside the input figure (the vendor schema places the cached member
//     BESIDE the input member and proves nothing about nesting); an
//     unconfirmed identity emits the input figure unsubtracted with a
//     failed-identity diagnostic. Cache-read and cache-write stay separate
//     axes on the diagnostic band — the Spec-006 `usage_telemetry` payload
//     registers no per-cache-axis member and this module mints none.
//
// Verifies invariant: I-005-11 (Plan-005 §Invariants). Enforced as the single
// metering path; asserted by `__tests__/usage-delta-accountant.test.ts`.
//
// Refs: Plan-005 §Phase 3 / T3.11, `Spec-005 §Required Behavior`,
// `Spec-005 §Interfaces And Contracts`, ADR-029.

import { type DriverDiagnosticsEmitter, type DriverProviderName } from "./driver-diagnostics.js";

// --------------------------------------------------------------------------
// Axes and readings.
// --------------------------------------------------------------------------

/**
 * The declared-cumulative token axes a provider reading may carry. The five
 * non-total axes mirror the pinned Codex `TokenUsageBreakdown` members
 * (`inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`,
 * `outputTokens`, `reasoningOutputTokens`); `total` is the breakdown's own
 * `totalTokens`. The Claude leg carries a subset through the same axes.
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

/**
 * The closed axis list, frozen. Readings arrive from untrusted provider output,
 * so every entry is filtered against this list rather than trusted to carry
 * only declared keys.
 */
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

/**
 * A cumulative reading split into the entries a register may accept and the
 * entries it must not.
 */
interface PartitionedAxisEntries {
  readonly accepted: readonly (readonly [UsageTokenAxis, number])[];
  readonly rejected: readonly {
    readonly key: string;
    readonly reason: RejectedAxisEntryReason;
  }[];
}

/**
 * Split one cumulative reading's own entries against the closed axis list.
 *
 * The single filter every register write and every cross-check passes through.
 * A non-finite value is rejected here rather than floored downstream because
 * the floor arm cannot catch it — `NaN < 0` is false, so a NaN would be written
 * straight into the base register and every later delta on that axis would be
 * NaN with no diagnostic and no path back short of re-establishing the thread.
 */
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
 * `namedTurnId` is the turn the metered frame ITSELF names (the Codex usage
 * notification carries a required `turnId`), or `null` where the wire names
 * none — attribution then stays thread-scoped and the consumer resolves the
 * turn from its own dispatch scope. It is never "whichever turn is open".
 *
 * `declaredPerTurn` is the wire's own per-turn figure where one exists beside
 * the cumulative one (the Codex breakdown's `last`); consumed as a
 * corroborating cross-check only.
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
 * `normalizedInputTokens` / `normalizedOutputTokens` are the PARTITION the
 * `usage_telemetry` payload carries: input is uncached input where the
 * containment identity confirmed subtraction, and the raw input figure
 * otherwise. `diagnosticBand` retains what the payload deliberately does not
 * carry — the cache-read / cache-write split — observable here rather than
 * discarded, since Spec-006 registers no per-cache-axis member.
 */
export interface MeteredUsageDelta {
  readonly provider: DriverProviderName;
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

export class UsageDeltaAccountant {
  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  /** One base register per (thread, axis), advanced in stream order. */
  readonly #baseRegistersByThreadId = new Map<string, Map<UsageTokenAxis, number>>();

  constructor(options: {
    readonly provider: DriverProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
  }

  /**
   * Establish one thread's base registers.
   *
   * `fresh` — a daemon-created provider session, a REPLAY-SEEDED one included
   * — bases every axis at zero, so the first reading meters in full. `resume`
   * — a provider-native resume of a thread whose spend the daemon already
   * emitted — bases each axis at the prior-emitted cumulative sum rebuilt from
   * the canonical record, so pre-resume spend is never re-metered and the
   * first post-resume interval meters exactly the new spend.
   *
   * Establishing an already-established thread replaces its registers; the
   * one legitimate caller of that shape is a provider-native resume of a
   * thread this process already metered, and the resume arm's prior-emitted
   * sum is exactly the register state such a call restores.
   */
  establishThread(threadId: string, establishment: ThreadBaseEstablishment): void {
    const baseRegisters = new Map<UsageTokenAxis, number>();
    if (establishment.mode === "resume") {
      // The resume arm writes DIRECTLY into the registers, so it is filtered on
      // exactly the same terms as a metered reading: a non-finite prior-emitted
      // sum would poison the base before any reading is taken, and an unpriced
      // NaN base is not recoverable by the floor arm downstream.
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
   * Meter one cumulative reading into a per-turn delta.
   *
   * Refuses (returns `null`, with a quarantine left to the router) for a
   * thread with no established base — establishment is the registration path's
   * job and metering an unestablished thread would silently invent a zero
   * base for a resume case.
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
        // An observed decrease on a declared-cumulative axis is a falsified
        // declaration, not a negative charge: floor at zero, re-base at the
        // observed value so later readings meter against reality, and report.
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
      // Stream-ordered advance: the register moves to the observed reading as
      // this reading is consumed — never a snapshot copied at turn dispatch.
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

  /**
   * Record every entry the axis filter refused. Never silent: a reading whose
   * axis vanished from the emission is a measurement the daemon did not take,
   * and an operator reconciling a receipt against a provider invoice needs the
   * refusal in the channel rather than an unexplained gap.
   */
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

  /**
   * The wire-declared per-turn figure corroborates the derived interval —
   * asserted equal for the naming turn, mismatch recorded, NEVER substituted.
   */
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

  /**
   * The normalized axes are a partition: input is UNCACHED input, subtracted
   * only where the breakdown's own sum identity confirms containment
   * (`total === input + output` on the reading's cumulative members — a total
   * exhausted by input plus output leaves the cached member nowhere to live
   * but inside input). Where no identity holds, the input figure is emitted
   * unsubtracted with the failed-identity diagnostic — a conservative
   * overstatement surfaced for repair, never a silent understatement.
   */
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
// T3.11 P1-6-producer — 3-tier cost resolution + native-cap provenance.
// --------------------------------------------------------------------------

/** The `Spec-006 §Usage Telemetry (usage_telemetry)` cost-status enum. */
export type UsageCostStatus = "priced" | "unpriced";

/** The full four-value `Spec-006 §Usage Telemetry (usage_telemetry)` cost-provenance enum. */
export type UsageCostSource =
  | "provider_reported"
  | "derived_exact"
  | "derived_family_prefix"
  | "unpriced_native_cap";

/** A pricing-table answer: cents derived from the provider's full breakdown,
 * plus whether the model family matched exactly or by prefix fallback. The
 * lookup is injected — this module owns provenance, never the price list. */
export interface DerivedCostQuote {
  readonly costCents: number;
  readonly familyMatch: "exact" | "prefix";
}

/**
 * The resolved outcome for one usage frame's cost leg. The fail-closed arm
 * for a genuinely unpriceable model is NOT a `usage.cost_update` shape — the
 * ladder's arm (d) emits `usage.budget_warning { reason: 'unpriced-model' }`
 * instead, so the union separates the two emissions rather than smuggling a
 * fifth `costSource` value past the closed Spec-006 enum. `costCents` is
 * structurally absent on the unpriced arm: no per-update value is derivable
 * there, and the USD bound lives on the `run.queued`
 * `admittedUnpricedCapCents`, never on per-update rows.
 *
 * Both arms are stated as partitions of the Spec-006 enums above rather than as
 * re-spelled literals, so widening either enum without placing the new value on
 * an arm is a compile error here rather than a silently unreachable provenance.
 */
export type CostUpdateResolution =
  | {
      readonly resolution: "cost-update";
      readonly costStatus: Extract<UsageCostStatus, "priced">;
      readonly costSource: Exclude<UsageCostSource, "unpriced_native_cap">;
      readonly costCents: number;
    }
  | {
      readonly resolution: "cost-update";
      readonly costStatus: Extract<UsageCostStatus, "unpriced">;
      readonly costSource: Extract<UsageCostSource, "unpriced_native_cap">;
      readonly costCents?: never;
    }
  | { readonly resolution: "budget-warning"; readonly reason: "unpriced-model" };

/**
 * Resolve one `usage.cost_update`'s provenance per the Plan-005 T3.11
 * P1-6-producer ladder: (a) a provider-emitted cost, sanity-bounded
 * (non-negative, finite, below the configured absurdity ceiling; gross
 * divergence from a derivable estimate is a diagnostic, never a halt) →
 * `provider_reported`; (b) else daemon-derived from the provider's full
 * breakdown × the per-model-family pricing table → `derived_exact` /
 * `derived_family_prefix`; (c) an owner-admitted native-cap run is unpriced
 * BY PROVENANCE → `{ costStatus: 'unpriced', costSource:
 * 'unpriced_native_cap' }`, `costCents` absent; (d) else fail-closed for a
 * genuinely unpriceable model — the budget-warning arm, never a fabricated
 * price and never the surveyed fail-open zero-cost terminal, which is
 * deliberately not ported. The producer never halts and never branches on
 * `costSource` — the B15 accountant owns the single ceiling
 * (`Spec-016 §Budget Policies`).
 */
export function resolveCostUpdateProvenance(options: {
  readonly provider: DriverProviderName;
  /** The wire's own cost figure, or null where the frame carries none. */
  readonly providerReportedCostCents: number | null;
  /** The pricing-table derivation, or null for an unpriceable model. */
  readonly derivedQuote: DerivedCostQuote | null;
  /** Whether this run was owner-admitted under a native cap (the C-12 leg). */
  readonly nativeCapAdmitted: boolean;
  readonly absurdityCeilingCents: number;
  /** Reported-vs-derived ratio beyond which divergence is diagnosed. */
  readonly grossDivergenceFactor: number;
  readonly diagnostics: DriverDiagnosticsEmitter;
}): CostUpdateResolution {
  const reportedCents = options.providerReportedCostCents;
  if (reportedCents !== null) {
    if (
      Number.isFinite(reportedCents) &&
      reportedCents >= 0 &&
      reportedCents < options.absurdityCeilingCents
    ) {
      const derivedCents = options.derivedQuote?.costCents ?? null;
      if (
        derivedCents !== null &&
        derivedCents > 0 &&
        (reportedCents > derivedCents * options.grossDivergenceFactor ||
          reportedCents * options.grossDivergenceFactor < derivedCents)
      ) {
        options.diagnostics.emit({
          provider: options.provider,
          kind: "usage_cross_check_mismatch",
          rawWireType: null,
          dispositionReason:
            "provider-reported cost grossly diverges from the derivable estimate; the reported provenance is kept and the divergence surfaced",
          details: {
            providerReportedCostCents: reportedCents,
            derivedEstimateCents: derivedCents,
            grossDivergenceFactor: options.grossDivergenceFactor,
          },
        });
      }
      return {
        resolution: "cost-update",
        costStatus: "priced",
        costSource: "provider_reported",
        costCents: reportedCents,
      };
    }
    // The wire declared a cost and the sanity bound refused it. Falling through
    // to the derived arm silently would substitute a daemon estimate for a
    // provider figure with no record that the two ever disagreed — the same
    // never-substitute-in-silence rule the per-turn cross-check enforces.
    options.diagnostics.emit({
      provider: options.provider,
      kind: "usage_cross_check_mismatch",
      rawWireType: null,
      dispositionReason:
        "provider-reported cost failed the sanity bound (non-finite, negative, or at/above the absurdity ceiling); discarded in favour of the derivation ladder and surfaced rather than dropped",
      details: {
        providerReportedCostCents: Number.isFinite(reportedCents) ? reportedCents : null,
        reportedCostIsFinite: Number.isFinite(reportedCents),
        absurdityCeilingCents: options.absurdityCeilingCents,
      },
    });
  }
  if (options.derivedQuote !== null) {
    return {
      resolution: "cost-update",
      costStatus: "priced",
      costSource:
        options.derivedQuote.familyMatch === "exact" ? "derived_exact" : "derived_family_prefix",
      costCents: options.derivedQuote.costCents,
    };
  }
  if (options.nativeCapAdmitted) {
    return { resolution: "cost-update", costStatus: "unpriced", costSource: "unpriced_native_cap" };
  }
  return { resolution: "budget-warning", reason: "unpriced-model" };
}

// --------------------------------------------------------------------------
// T3.11 P2-6-producer — window telemetry.
// --------------------------------------------------------------------------

/** The `Spec-005 §Interfaces And Contracts` window-provenance vocabulary. */
export type WindowSource = "provider_reported" | "model_default" | "estimated";

/** Normalized window telemetry. Counts travel BOTH-OR-NEITHER — a lone
 * numerator or denominator is an emitter bug, so this shape cannot represent
 * one: either both `windowUsedTokens` and `windowMaxTokens` are present or
 * both are structurally absent, with `windowSource` / `exceeded` mandatory on
 * every emission. */
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
 * Derive one window-telemetry update at the normalize boundary (Plan-005
 * T3.11 P2-6-producer). The driver stamps `windowSource` and computes
 * `exceeded`; the Codex leg subtracts its session baseline before deriving
 * `windowUsedTokens` (the ~12k-token constant-overhead reading, supplied by
 * the caller from its capability read rather than hard-coded here — the
 * Claude leg supplies zero). A frame carrying only half the pair emits the
 * counts-absent arm — provenance and `exceeded` still travel, but no
 * denominator is fabricated and no numerator ships alone.
 *
 * On the counts-absent arm `exceeded` is the CALLER'S, because nothing here can
 * derive it: with no numerator or no denominator there is no comparison to
 * make, and a hard-coded `false` would assert "not exceeded" about a window
 * this function never measured. That arm exists precisely because the Spec-006
 * counts-absent update is a provenance-and-`exceeded` signal, so its caller
 * holds the wire's own limit signal and states it here.
 */
export function deriveWindowTelemetry(options: {
  readonly windowSource: WindowSource;
  /** The wire's used-tokens reading, or null where the frame carries none. */
  readonly rawUsedTokens: number | null;
  /** The window ceiling, or null where neither wire nor model declares one. */
  readonly windowMaxTokens: number | null;
  /** Session-constant overhead subtracted before use (Codex ~12k; Claude 0). */
  readonly sessionBaselineTokens: number;
  /**
   * The wire's own limit signal, consumed ONLY on the counts-absent arm. The
   * counts-present arm derives `exceeded` from the counts and ignores this.
   */
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

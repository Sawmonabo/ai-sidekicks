// Usage-delta accountant suite (Plan-005 T3.11 — the NS-91 usage-delta leg,
// plus the P1-6-producer / P2-6-producer decision functions).
//
// Spec coverage under test:
//   • `Spec-005 §Required Behavior` — per-axis deltas from one base register
//     per provider thread and axis, advanced in stream order; named-turn
//     attribution; two-armed establishment; no compaction re-base; the
//     corroborating cross-check; the floor rule; the containment partition.
//   • `Spec-006 §Usage Telemetry (usage_telemetry)` — the four-value cost
//     provenance enum and the both-or-neither window pair rule.
//
// Verifies invariant: I-005-11 (a driver never emits a provider's cumulative
// counter as a per-turn figure, and no normalized token axis counts a token
// twice).

import { describe, expect, it } from "vitest";

import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import {
  deriveWindowTelemetry,
  resolveCostUpdateProvenance,
  UsageDeltaAccountant,
} from "../usage-delta-accountant.js";

function makeAccountant() {
  const diagnostics = new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  const accountant = new UsageDeltaAccountant({ provider: "codex", diagnostics });
  return { accountant, diagnostics };
}

describe("UsageDeltaAccountant (T3.11, I-005-11)", () => {
  it("interleaved 0→100→150 two-turn sequence attributes exactly 100 and 50 by named turn", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });

    const firstDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 100 },
    });
    const secondDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-B",
      cumulative: { input: 150 },
    });

    expect(firstDelta?.attributedTurnId).toBe("turn-A");
    expect(firstDelta?.axisDeltas.input).toBe(100);
    expect(secondDelta?.attributedTurnId).toBe("turn-B");
    expect(secondDelta?.axisDeltas.input).toBe(50);
  });

  it("a recorded cumulative sequence re-sums to the newest reading minus the establishment base", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    const cumulativeReadings = [40, 90, 90, 210, 400];
    let metered = 0;
    for (const [index, cumulativeValue] of cumulativeReadings.entries()) {
      const delta = accountant.meterReading({
        threadId: "thread-1",
        namedTurnId: `turn-${index}`,
        cumulative: { output: cumulativeValue },
      });
      metered += delta?.axisDeltas.output ?? 0;
    }
    expect(metered).toBe(400);
  });

  it("a fresh session's first reading meters IN FULL from base zero", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    const delta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 12_000, output: 300 },
    });
    expect(delta?.axisDeltas.input).toBe(12_000);
    expect(delta?.axisDeltas.output).toBe(300);
  });

  it("a replay-seeded session is fresh: seeding meters nothing, the first turn's reading meters whole", () => {
    // Replay-seeding injects transcript, not billed spend — the provider's
    // counter starts at zero either way, so the establishment arm is the same
    // `fresh` arm and the first post-seed reading is entirely real spend.
    const { accountant } = makeAccountant();
    accountant.establishThread("replay-seeded-thread", { mode: "fresh" });
    const delta = accountant.meterReading({
      threadId: "replay-seeded-thread",
      namedTurnId: "turn-after-seeding",
      cumulative: { input: 55_000, output: 900 },
    });
    expect(delta?.axisDeltas.input).toBe(55_000);
    expect(delta?.axisDeltas.output).toBe(900);
  });

  it("a provider-native resume meters only the excess over the prior-emitted sum, and zero when there is none", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("resumed-thread", {
      mode: "resume",
      priorEmittedCumulative: { input: 80_000, output: 4_000 },
    });

    const idleDelta = accountant.meterReading({
      threadId: "resumed-thread",
      namedTurnId: null,
      cumulative: { input: 80_000, output: 4_000 },
    });
    expect(idleDelta?.axisDeltas.input).toBe(0);
    expect(idleDelta?.axisDeltas.output).toBe(0);

    const excessDelta = accountant.meterReading({
      threadId: "resumed-thread",
      namedTurnId: "turn-after-resume",
      cumulative: { input: 81_500, output: 4_100 },
    });
    expect(excessDelta?.axisDeltas.input).toBe(1_500);
    expect(excessDelta?.axisDeltas.output).toBe(100);
  });

  it("a compaction between two readings does not re-base — the interval stays exact", () => {
    // The accountant exposes no compaction entry point at all; this test pins
    // the observable consequence: readings straddling a compaction difference
    // exactly as if none had occurred.
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 90_000 },
    });
    // <-- provider-side compaction happens here; the counter is unaffected.
    const postCompactionDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-B",
      cumulative: { input: 95_000 },
    });
    expect(postCompactionDelta?.axisDeltas.input).toBe(5_000);
  });

  it("a turn-A usage frame delivered after turn B opened attributes to turn A, not floored, not credited to B", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    // Turn B has already opened dispatch-side; the late frame NAMES turn A,
    // and the stream-ordered base meters its interval to the named turn.
    const lateDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 700 },
    });
    expect(lateDelta?.attributedTurnId).toBe("turn-A");
    expect(lateDelta?.axisDeltas.input).toBe(700);
    const turnBDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-B",
      cumulative: { input: 1_000 },
    });
    expect(turnBDelta?.attributedTurnId).toBe("turn-B");
    expect(turnBDelta?.axisDeltas.input).toBe(300);
  });

  it("a synthetic decrease emits zero AND a floor-hit diagnostic, then re-bases at the observed value", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 500 },
    });
    const flooredDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-B",
      cumulative: { input: 200 },
    });
    expect(flooredDelta?.axisDeltas.input).toBe(0);
    expect(diagnostics.recentRecordsOfKind("usage_delta_floor_hit")).toHaveLength(1);
    // Re-based at the observed value: the next interval meters against 200.
    const recoveredDelta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-C",
      cumulative: { input: 260 },
    });
    expect(recoveredDelta?.axisDeltas.input).toBe(60);
  });

  it("a declared per-turn figure disagreeing with the derived interval records a cross-check diagnostic without substituting", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    const delta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 100 },
      declaredPerTurn: { input: 90 },
    });
    // The derived interval stands; the wire's own `last` figure is
    // corroboration only.
    expect(delta?.axisDeltas.input).toBe(100);
    const mismatchRecords = diagnostics.recentRecordsOfKind("usage_cross_check_mismatch");
    expect(mismatchRecords).toHaveLength(1);
    expect(mismatchRecords[0]?.details["declaredValue"]).toBe(90);
    expect(mismatchRecords[0]?.details["derivedInterval"]).toBe(100);
  });

  it("an agreeing declared per-turn figure records no diagnostic", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 100 },
      declaredPerTurn: { input: 100 },
    });
    expect(diagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toHaveLength(0);
  });

  it("a reading whose input contains its cached figure partitions to the uncached total exactly once", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    // total === input + output confirms containment: 1000 = 800 + 200, with
    // cachedInput 300 sitting inside the input figure.
    const delta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 800, cachedInput: 300, output: 200, total: 1_000 },
    });
    expect(delta?.containment).toBe("confirmed-subtracted");
    expect(delta?.normalizedInputTokens).toBe(500);
    expect(delta?.normalizedOutputTokens).toBe(200);
    // No token counted twice: uncached input + cache-read band = raw input.
    expect(
      (delta?.normalizedInputTokens ?? 0) + (delta?.diagnosticBand.cacheReadTokensDelta ?? 0),
    ).toBe(800);
  });

  it("a breakdown satisfying no containment identity emits unsubtracted with the failed-identity diagnostic", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    // 1000 !== 800 + 150 — the identity fails, so nothing proves the cached
    // member nests inside input; subtracting would risk undercounting.
    const delta = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 800, cachedInput: 300, output: 150, total: 1_000 },
    });
    expect(delta?.containment).toBe("unconfirmed-unsubtracted");
    expect(delta?.normalizedInputTokens).toBe(800);
    expect(diagnostics.recentRecordsOfKind("usage_containment_identity_unconfirmed")).toHaveLength(
      1,
    );
  });

  it("refuses to meter an unestablished thread — a foreign thread returns null, never an invented zero base", () => {
    const { accountant } = makeAccountant();
    expect(
      accountant.meterReading({
        threadId: "never-established",
        namedTurnId: "turn-A",
        cumulative: { input: 100 },
      }),
    ).toBeNull();
  });

  it("refuses a non-finite axis reading instead of writing it into a base register", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 100 },
    });

    // `NaN < 0` is false, so the floor arm cannot catch this: an unfiltered
    // NaN would be written to the register and every later reading on that
    // axis would difference against it and produce NaN forever.
    const metered = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cachedInput: 7 },
    });

    // The clean axis still meters; only the rejected ones are dropped, and
    // EACH rejected figure is recorded on its own — one aggregate record would
    // not say which axis the provider is publishing garbage on.
    expect(metered?.axisDeltas).toEqual({ cachedInput: 7 });
    expect(
      diagnostics
        .recentRecordsOfKind("usage_axis_reading_rejected")
        .map((record) => record.details["axisKey"]),
    ).toEqual(["input", "output"]);

    // The register is intact: a later good reading differences from 100, not NaN.
    const recovered = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: 160 },
    });
    expect(recovered?.axisDeltas.input).toBe(60);
  });

  it("refuses an axis the token vocabulary does not name rather than minting a register for it", () => {
    const { accountant, diagnostics } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    const metered = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      // A vendor adding a counter the corpus has no axis for. Metering it
      // would put an unnamed figure on a receipt; dropping it silently would
      // hide that the vendor's surface grew.
      cumulative: { input: 10, reasoningTokens: 5 } as Record<string, number>,
    });
    expect(metered?.axisDeltas).toEqual({ input: 10 });
    expect(diagnostics.recentRecordsOfKind("usage_axis_reading_rejected")).toHaveLength(1);
  });

  it("releases a thread's registers when its provider session ends", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    expect(accountant.hasThread("thread-1")).toBe(true);
    accountant.releaseThread("thread-1");
    expect(accountant.hasThread("thread-1")).toBe(false);
    expect(
      accountant.meterReading({
        threadId: "thread-1",
        namedTurnId: null,
        cumulative: { input: 1 },
      }),
    ).toBeNull();
  });
});

describe("resolveCostUpdateProvenance (T3.11 P1-6-producer)", () => {
  function makeDiagnostics() {
    return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  }
  const ladderDefaults = {
    provider: "codex" as const,
    absurdityCeilingCents: 100_000,
    grossDivergenceFactor: 10,
  };

  it("CONFORMANCE: the native-cap path emits exactly { costStatus: 'unpriced', costSource: 'unpriced_native_cap' } with costCents absent", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: null,
      derivedQuote: null,
      nativeCapAdmitted: true,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "unpriced",
      costSource: "unpriced_native_cap",
    });
    expect("costCents" in resolved).toBe(false);
  });

  it("a sane provider-emitted cost resolves provider_reported", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: 42,
      derivedQuote: { costCents: 40, familyMatch: "exact" },
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "priced",
      costSource: "provider_reported",
      costCents: 42,
    });
  });

  it("gross divergence from the derivable estimate keeps reported provenance and records a diagnostic", () => {
    const diagnostics = makeDiagnostics();
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: 5_000,
      derivedQuote: { costCents: 40, familyMatch: "exact" },
      nativeCapAdmitted: false,
      diagnostics,
    });
    expect(resolved.resolution).toBe("cost-update");
    if (resolved.resolution === "cost-update") {
      expect(resolved.costSource).toBe("provider_reported");
      expect(resolved.costCents).toBe(5_000);
    }
    expect(diagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toHaveLength(1);
  });

  it("an absurd or malformed reported cost falls through to derivation", () => {
    for (const badReportedCents of [Number.NaN, Number.POSITIVE_INFINITY, -1, 200_000]) {
      const resolved = resolveCostUpdateProvenance({
        ...ladderDefaults,
        providerReportedCostCents: badReportedCents,
        derivedQuote: { costCents: 40, familyMatch: "exact" },
        nativeCapAdmitted: false,
        diagnostics: makeDiagnostics(),
      });
      expect(resolved).toEqual({
        resolution: "cost-update",
        costStatus: "priced",
        costSource: "derived_exact",
        costCents: 40,
      });
    }
  });

  it("records the discarded reported cost rather than falling through silently", () => {
    const diagnostics = makeDiagnostics();
    resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: Number.NaN,
      derivedQuote: { costCents: 40, familyMatch: "exact" },
      nativeCapAdmitted: false,
      diagnostics,
    });

    // The provider SENT a cost and the daemon billed a different number. A
    // silent fall-through would make a provider emitting garbage on every turn
    // indistinguishable from one emitting no cost at all.
    expect(diagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toHaveLength(1);
  });

  it("an ABSENT reported cost is not a mismatch — nothing was discarded", () => {
    const diagnostics = makeDiagnostics();
    resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: null,
      derivedQuote: { costCents: 40, familyMatch: "exact" },
      nativeCapAdmitted: false,
      diagnostics,
    });
    expect(diagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toHaveLength(0);
  });

  it("family-prefix fallback resolves derived_family_prefix", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: null,
      derivedQuote: { costCents: 33, familyMatch: "prefix" },
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "priced",
      costSource: "derived_family_prefix",
      costCents: 33,
    });
  });

  it("a genuinely unpriceable model without native-cap admission fails closed to the budget-warning arm", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostCents: null,
      derivedQuote: null,
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({ resolution: "budget-warning", reason: "unpriced-model" });
  });
});

describe("deriveWindowTelemetry (T3.11 P2-6-producer)", () => {
  it("counts travel both-or-neither: a full pair emits both members", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 50_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: false,
    });
    expect(telemetry).toEqual({
      windowSource: "provider_reported",
      exceeded: false,
      windowUsedTokens: 50_000,
      windowMaxTokens: 200_000,
    });
  });

  it("counts travel both-or-neither: a half pair emits neither count, provenance still travels", () => {
    for (const halfPair of [
      { rawUsedTokens: 50_000, windowMaxTokens: null },
      { rawUsedTokens: null, windowMaxTokens: 200_000 },
    ]) {
      const telemetry = deriveWindowTelemetry({
        windowSource: "model_default",
        sessionBaselineTokens: 0,
        exceededWhenCountsAbsent: false,
        ...halfPair,
      });
      expect(telemetry).toEqual({ windowSource: "model_default", exceeded: false });
      expect("windowUsedTokens" in telemetry).toBe(false);
      expect("windowMaxTokens" in telemetry).toBe(false);
    }
  });

  it("the Codex leg subtracts the session baseline before deriving windowUsedTokens", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 62_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 12_000,
      exceededWhenCountsAbsent: false,
    });
    expect(telemetry.windowUsedTokens).toBe(50_000);
  });

  it("baseline subtraction never goes negative", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 8_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 12_000,
      exceededWhenCountsAbsent: false,
    });
    expect(telemetry.windowUsedTokens).toBe(0);
  });

  it("the counts-absent arm carries the wire's own limit signal instead of asserting false", () => {
    // The half-pair arm cannot derive `exceeded` — that is the whole reason the
    // counts do not travel. Hardcoding `false` there would have reported a
    // provider that HAD signalled its limit as comfortably under it, which is
    // the one reading this telemetry exists to prevent.
    const signalled = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: null,
      windowMaxTokens: null,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: true,
    });
    expect(signalled).toEqual({ windowSource: "provider_reported", exceeded: true });

    const unsignalled = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: null,
      windowMaxTokens: null,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: false,
    });
    expect(unsignalled).toEqual({ windowSource: "provider_reported", exceeded: false });
  });

  it("the counts-PRESENT arm ignores the wire signal and derives from the counts", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 10,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: true,
    });
    expect(telemetry.exceeded).toBe(false);
  });

  it("exceeded flips at the ceiling", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "estimated",
      rawUsedTokens: 200_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: false,
    });
    expect(telemetry.exceeded).toBe(true);
  });
});

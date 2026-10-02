// Usage-delta accountant, plus the cost-provenance and window-telemetry decision functions:
// the four-value cost provenance enum and the both-or-neither window pair rule.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../__fixtures__/silent-driver-diagnostics.js";
import {
  deriveWindowTelemetry,
  resolveCostUpdateProvenance,
  UsageDeltaAccountant,
} from "../usage-delta-accountant.js";

function makeAccountant() {
  const diagnostics = makeSilentDriverDiagnostics();
  const accountant = new UsageDeltaAccountant({ provider: "codex", diagnostics });
  return { accountant, diagnostics };
}

describe("UsageDeltaAccountant", () => {
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
    // The accountant has no compaction entry point; readings straddling a compaction difference
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
    // Turn B has already opened dispatch-side; the late frame names turn A, and the
    // stream-ordered base meters its interval to the named turn.
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
    // The derived interval stands; the wire's own `last` figure is corroboration only.
    expect(delta?.axisDeltas.input).toBe(100);
    const mismatchRecords = diagnostics.recentRecordsOfKind("usage_cross_check_mismatch");
    expect(mismatchRecords).toHaveLength(1);
    expect(mismatchRecords[0]?.details["declaredValue"]).toBe(90);
    expect(mismatchRecords[0]?.details["derivedInterval"]).toBe(100);
  });

  it("a reading whose input contains its cached figure partitions to the uncached total exactly once", () => {
    const { accountant } = makeAccountant();
    accountant.establishThread("thread-1", { mode: "fresh" });
    // total === input + output, with cachedInput (300) contained in input: 1000 = 800 + 200.
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
    // 1000 !== 800 + 150, so nothing proves the cached member nests inside input; subtracting
    // would risk undercounting.
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

    // `NaN < 0` is false, so the floor arm cannot catch this: an unfiltered NaN would enter the
    // register and every later reading on that axis would difference to NaN.
    const metered = accountant.meterReading({
      threadId: "thread-1",
      namedTurnId: "turn-A",
      cumulative: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cachedInput: 7 },
    });

    // The clean axis still meters; each rejected figure is recorded on its own so the record says
    // which axis the provider publishes garbage on.
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
});

describe("resolveCostUpdateProvenance", () => {
  function makeDiagnostics() {
    return makeSilentDriverDiagnostics();
  }
  const ladderDefaults = {
    provider: "codex" as const,
    absurdityCeilingUsdMicros: 100_000,
    grossDivergenceFactor: 10,
  };

  it("a sane provider-emitted cost resolves provider_reported", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: 42,
      derivedQuote: { costUsdMicros: 40 },
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costSource: "provider_reported",
      costUsdMicros: 42,
    });
  });

  it("an absurd or malformed reported cost falls through to derivation", () => {
    for (const badReportedUsdMicros of [Number.NaN, Number.POSITIVE_INFINITY, -1, 200_000]) {
      const resolved = resolveCostUpdateProvenance({
        ...ladderDefaults,
        providerReportedCostUsdMicros: badReportedUsdMicros,
        derivedQuote: { costUsdMicros: 40 },
        diagnostics: makeDiagnostics(),
      });
      expect(resolved).toEqual({
        resolution: "cost-update",
        costSource: "derived_exact",
        costUsdMicros: 40,
      });
    }
  });

  it("holds a request on a model the price list does not price, with no made-up cost", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: null,
      derivedQuote: null,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({ resolution: "held-until-priced" });
  });
});

describe("deriveWindowTelemetry", () => {
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

  it("the Codex leg subtracts the session baseline, never below zero", () => {
    const telemetry = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 62_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 12_000,
      exceededWhenCountsAbsent: false,
    });
    expect(telemetry.windowUsedTokens).toBe(50_000);

    const belowBaseline = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: 8_000,
      windowMaxTokens: 200_000,
      sessionBaselineTokens: 12_000,
      exceededWhenCountsAbsent: false,
    });
    expect(belowBaseline.windowUsedTokens).toBe(0);
  });

  it("the counts-absent arm carries the wire's own limit signal instead of asserting false", () => {
    // The half-pair arm cannot derive `exceeded`, which is why the counts do not travel;
    // hardcoding `false` would report a provider that signaled its limit as comfortably under it.
    const signaled = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: null,
      windowMaxTokens: null,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: true,
    });
    expect(signaled).toEqual({ windowSource: "provider_reported", exceeded: true });

    const unsignaled = deriveWindowTelemetry({
      windowSource: "provider_reported",
      rawUsedTokens: null,
      windowMaxTokens: null,
      sessionBaselineTokens: 0,
      exceededWhenCountsAbsent: false,
    });
    expect(unsignaled).toEqual({ windowSource: "provider_reported", exceeded: false });
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

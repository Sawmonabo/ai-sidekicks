// Usage-delta accountant, plus the cost-provenance and window-telemetry decision functions:
// the four-value cost provenance enum and the both-or-neither window pair rule.

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
    return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  }
  const ladderDefaults = {
    provider: "codex" as const,
    absurdityCeilingUsdMicros: 100_000,
    grossDivergenceFactor: 10,
  };

  it("the native-cap path emits an unpriced update with no costUsdMicros", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: null,
      derivedQuote: null,
      nativeCapAdmitted: true,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "unpriced",
      costSource: "unpriced_native_cap",
    });
    expect("costUsdMicros" in resolved).toBe(false);
  });

  it("a sane provider-emitted cost resolves provider_reported", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: 42,
      derivedQuote: { costUsdMicros: 40, familyMatch: "exact" },
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "priced",
      costSource: "provider_reported",
      costUsdMicros: 42,
    });
  });

  it("an absurd or malformed reported cost falls through to derivation", () => {
    for (const badReportedUsdMicros of [Number.NaN, Number.POSITIVE_INFINITY, -1, 200_000]) {
      const resolved = resolveCostUpdateProvenance({
        ...ladderDefaults,
        providerReportedCostUsdMicros: badReportedUsdMicros,
        derivedQuote: { costUsdMicros: 40, familyMatch: "exact" },
        nativeCapAdmitted: false,
        diagnostics: makeDiagnostics(),
      });
      expect(resolved).toEqual({
        resolution: "cost-update",
        costStatus: "priced",
        costSource: "derived_exact",
        costUsdMicros: 40,
      });
    }
  });

  it("family-prefix fallback resolves derived_family_prefix", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: null,
      derivedQuote: { costUsdMicros: 33, familyMatch: "prefix" },
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({
      resolution: "cost-update",
      costStatus: "priced",
      costSource: "derived_family_prefix",
      costUsdMicros: 33,
    });
  });

  it("a genuinely unpriceable model without native-cap admission fails closed to the budget-warning arm", () => {
    const resolved = resolveCostUpdateProvenance({
      ...ladderDefaults,
      providerReportedCostUsdMicros: null,
      derivedQuote: null,
      nativeCapAdmitted: false,
      diagnostics: makeDiagnostics(),
    });
    expect(resolved).toEqual({ resolution: "budget-warning", reason: "unpriced-model" });
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

// The CLI-version parse, which leaves anything short of a full semver unparsed, and the
// CapabilityRefresher, which reads only when asked and keeps a failed or hung read from stopping a
// sibling's read or a later refresh.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeSilentDriverDiagnostics } from "../../__fixtures__/silent-driver-diagnostics.js";
import type { DeclareDriverCapabilitiesResult } from "../../driver/driver-capabilities-writer.js";
import {
  CAPABILITY_REFRESH_READ_TIMEOUT_MS,
  CapabilityRefresher,
  parseCliVersionReport,
  type CapabilityRefreshDiagnostic,
  type CapabilityRefreshDriverEntry,
} from "../refresh.js";

describe("parseCliVersionReport", () => {
  it("derives the canonical semver from a prose-wrapped raw string, keeping raw verbatim", () => {
    const report = parseCliVersionReport("codex-cli 0.149.1 (build abc123)");
    expect(report).toStrictEqual({
      rawVersion: "codex-cli 0.149.1 (build abc123)",
      parsedVersion: "0.149.1",
    });

    const claudeReport = parseCliVersionReport("2.1.245 (Claude Code)");
    expect(claudeReport).toStrictEqual({
      rawVersion: "2.1.245 (Claude Code)",
      parsedVersion: "2.1.245",
    });
  });

  it.each(["garbage", "2.1"])(
    "keeps %j as the printed version with no parse (no coercion of partial versions)",
    (rawVersion) => {
      expect(parseCliVersionReport(rawVersion)).toStrictEqual({ rawVersion });
    },
  );
});

/** A controllable driver entry whose read history the assertions use. */
interface FakeDriverEntry {
  readonly entry: CapabilityRefreshDriverEntry;
  readonly refreshCalls: number[];
  setRefreshResult(result: DeclareDriverCapabilitiesResult | Error | "hang"): void;
}

function buildFakeDriverEntry(driverName: ProviderName): FakeDriverEntry {
  let refreshResult: DeclareDriverCapabilitiesResult | Error | "hang" = {
    snapshotChange: "unchanged",
    cliVersionRefreshed: false,
  };
  const refreshCalls: number[] = [];
  return {
    entry: {
      driverName,
      refreshDeclaration: () => {
        refreshCalls.push(Date.now());
        if (refreshResult === "hang") {
          return new Promise<DeclareDriverCapabilitiesResult>(() => undefined);
        }
        return refreshResult instanceof Error
          ? Promise.reject(refreshResult)
          : Promise.resolve(refreshResult);
      },
    },
    refreshCalls,
    setRefreshResult(result) {
      refreshResult = result;
    },
  };
}

/** One refresher over the given drivers, plus the diagnostics it reported. */
function buildRefresher(drivers: readonly FakeDriverEntry[]): {
  readonly refresher: CapabilityRefresher;
  readonly diagnostics: CapabilityRefreshDiagnostic[];
} {
  const diagnostics: CapabilityRefreshDiagnostic[] = [];
  const emitter = makeSilentDriverDiagnostics();
  const refresher = new CapabilityRefresher({
    drivers: drivers.map((driver) => driver.entry),
    diagnostics: emitter,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { refresher, diagnostics };
}

describe("CapabilityRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads every driver when asked and never on its own", async () => {
    const claude = buildFakeDriverEntry("claude");
    const codex = buildFakeDriverEntry("codex");
    const { refresher } = buildRefresher([claude, codex]);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(claude.refreshCalls).toHaveLength(0);

    await refresher.refreshNow();
    expect(claude.refreshCalls).toHaveLength(1);
    expect(codex.refreshCalls).toHaveLength(1);
  });

  it("reports one driver's failed read and still reads its sibling", async () => {
    const claude = buildFakeDriverEntry("claude");
    const codex = buildFakeDriverEntry("codex");
    claude.setRefreshResult(new Error("handshake failed"));
    const { refresher, diagnostics } = buildRefresher([claude, codex]);

    await refresher.refreshNow();

    expect(codex.refreshCalls).toHaveLength(1);
    expect(diagnostics).toEqual([
      {
        driverName: "claude",
        leg: "capability-refresh",
        code: undefined,
        message: "handshake failed",
        timedOut: false,
      },
    ]);
  });

  it("abandons a read that never settles, reports it, and lets the next refresh run", async () => {
    const codex = buildFakeDriverEntry("codex");
    codex.setRefreshResult("hang");
    const { refresher, diagnostics } = buildRefresher([codex]);

    const first = refresher.refreshNow();
    // A refresh asked for while one runs is dropped, not stacked.
    await refresher.refreshNow();
    expect(codex.refreshCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_READ_TIMEOUT_MS);
    await first;
    expect(diagnostics).toMatchObject([{ driverName: "codex", timedOut: true }]);

    codex.setRefreshResult({ snapshotChange: "changed", cliVersionRefreshed: false });
    await refresher.refreshNow();
    expect(codex.refreshCalls).toHaveLength(2);
  });

  it("reads nothing after shutdown", async () => {
    const codex = buildFakeDriverEntry("codex");
    const { refresher } = buildRefresher([codex]);

    refresher.shutdown();
    await refresher.refreshNow();

    expect(codex.refreshCalls).toHaveLength(0);
  });
});

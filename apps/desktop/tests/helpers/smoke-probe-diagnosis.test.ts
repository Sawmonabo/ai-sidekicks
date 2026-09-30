// Tests the smoke harness's pure parts without a launch: the breadcrumb scanner's buffering, the
// derived timing budgets and the missing-probe diagnosis. None needs Electron or a built bundle.

import { describe, expect, it } from "vitest";

import { READINESS_BREADCRUMB_TAG, SMOKE_PROBE_TAG } from "@shared/probe-tags.js";

import { DISPLAY_READY_TIMEOUT_MS } from "./display-readiness.js";
import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import {
  DIAGNOSTIC_BUDGET_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  DIAGNOSTIC_PROBE_TIMEOUT_MS,
  diagnoseMissingProbe,
  ReadinessLineScanner,
} from "./smoke-probe-diagnosis.js";
import {
  BOOT_TEST_TIMEOUT_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
  type SpawnResult,
} from "./smoke-probe-harness.js";

// A breadcrumb split across a chunk boundary must not vanish, or the trail goes missing exactly
// when load fragments the process's writes.
describe("ReadinessLineScanner", () => {
  const emit = (event: string, offsetMs: number): string =>
    `${READINESS_BREADCRUMB_TAG} ${event} +${String(offsetMs)}ms\n`;

  it("recovers a breadcrumb split across two chunks", () => {
    const line = emit("dom-ready", 133);
    // Splits inside the tag itself, which a per-chunk `split("\n")` cannot recover.
    const splitAt = READINESS_BREADCRUMB_TAG.length - 3;
    const scanner = new ReadinessLineScanner();
    expect(scanner.push(line.slice(0, splitAt))).toEqual([]);
    expect(scanner.push(line.slice(splitAt))).toEqual(["dom-ready +133ms"]);
  });

  it("recovers a breadcrumb split at every possible boundary", () => {
    const line = emit("ready-to-show", 148);
    for (let splitAt = 0; splitAt <= line.length; splitAt += 1) {
      const scanner = new ReadinessLineScanner();
      const seen = [...scanner.push(line.slice(0, splitAt)), ...scanner.push(line.slice(splitAt))];
      expect(seen).toEqual(["ready-to-show +148ms"]);
    }
  });

  it("holds an unterminated line until its newline arrives", () => {
    const scanner = new ReadinessLineScanner();
    // No newline yet: reporting now would record a truncated offset as fact.
    expect(scanner.push(`${READINESS_BREADCRUMB_TAG} did-finish-load +12`)).toEqual([]);
    expect(scanner.push("34ms\n")).toEqual(["did-finish-load +1234ms"]);
  });

  it("reports several breadcrumbs arriving in one chunk, in order", () => {
    const scanner = new ReadinessLineScanner();
    expect(scanner.push(emit("dom-ready", 1) + emit("ready-to-show", 2))).toEqual([
      "dom-ready +1ms",
      "ready-to-show +2ms",
    ]);
  });

  it("ignores untagged output and never emits for it", () => {
    const scanner = new ReadinessLineScanner();
    expect(scanner.push("some unrelated stderr\nmore of it\n")).toEqual([]);
  });

  it("keeps two streams' partial lines apart", () => {
    // A shared instance would splice stdout's tail onto stderr's head and invent a line.
    const stdoutScanner = new ReadinessLineScanner();
    const stderrScanner = new ReadinessLineScanner();
    expect(stdoutScanner.push(`${READINESS_BREADCRUMB_TAG} dom-`)).toEqual([]);
    expect(stderrScanner.push(`${READINESS_BREADCRUMB_TAG} ready-to-show +2ms\n`)).toEqual([
      "ready-to-show +2ms",
    ]);
    expect(stdoutScanner.push("ready +1ms\n")).toEqual(["dom-ready +1ms"]);
  });
});

// Asserts the budget arithmetic. Each timing constant derives from another so that raising a
// phase raises every enclosure. A collection measured from one instant but bounded from a later
// one exceeds its own budget, and only an assertion catches that.
describe("derived timing budgets", () => {
  it("leaves the close-event reserve intact above the largest legal collection", () => {
    // The slack sits on top of the ceiling. An enclosure that spends the slack to contain the
    // ceiling leaves nothing for the spawn, the `close` event and profile cleanup, so a slow legal
    // collection would lose its dump to vitest's timeout. The weaker "contains the ceiling" form
    // would pass against a derivation that spends the slack.
    expect(BOOT_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DISPLAY_READY_TIMEOUT_MS +
        SPAWN_TIMEOUT_MS +
        DIAGNOSTIC_COLLECTION_CEILING_MS +
        TERMINATION_GRACE_MS +
        TEST_TIMEOUT_SLACK_MS,
    );
    expect(FORCED_STALL_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DISPLAY_READY_TIMEOUT_MS +
        FORCED_STALL_SPAWN_TIMEOUT_MS +
        DIAGNOSTIC_COLLECTION_CEILING_MS +
        TERMINATION_GRACE_MS +
        TEST_TIMEOUT_SLACK_MS,
    );
  });

  it("counts every bounded phase a spawn can spend, not only the ones after it starts", () => {
    // The display gate runs before the spawn deadline is armed, so the spawn budget does not
    // contain it; every enclosure must.
    for (const enclosure of [BOOT_TEST_TIMEOUT_MS, FORCED_STALL_TEST_TIMEOUT_MS]) {
      expect(enclosure).toBeGreaterThan(
        DISPLAY_READY_TIMEOUT_MS + DIAGNOSTIC_COLLECTION_CEILING_MS,
      );
    }
  });

  it("keeps the shared wall budget binding rather than decorative", () => {
    // Two probes: a wall budget above the sum of their caps could never bind.
    const boundedProbeCount = 2;
    expect(DIAGNOSTIC_BUDGET_MS).toBeLessThanOrEqual(
      DIAGNOSTIC_PROBE_TIMEOUT_MS * boundedProbeCount,
    );
  });

  it("keeps the collection ceiling tight enough to catch the shape it replaced", () => {
    // Two independent 5 s `spawnSync` timeouts would sum to 10 s; the ceiling must stay below it.
    const supersededIndependentProbeTimeoutMs = 5_000;
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeLessThan(supersededIndependentProbeTimeoutMs * 2);
    // And above the budget, so the reserve keeps the control from being a wall-clock flake.
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeGreaterThan(DIAGNOSTIC_BUDGET_MS);
  });
});

// Drives the diagnosis over synthetic output, since a real spawn reaches an arm only by failing
// that way. Arm order matters: overlapping evidence (a timed-out process with `did-finish-load`
// matches two arms) is asserted with both arms' evidence present, the only setup that catches a
// reordering.
describe("diagnoseMissingProbe", () => {
  /** A spawn that produced no probe line, with only the evidence a case names. */
  function failedSpawn(overrides: Partial<SpawnResult> = {}): SpawnResult {
    return {
      probe: null,
      stdout: "",
      stderr: "",
      combinedOutput: "",
      exitCode: 0,
      signal: null,
      elapsedMs: 1_234,
      readinessBreadcrumbs: [],
      diagnostics: [],
      spawnBudgetMs: SPAWN_TIMEOUT_MS,
      timedOut: false,
      diagnosticCollectionMs: null,
      childDisplay: undefined,
      ...overrides,
    };
  }

  it.each([
    [
      "a display that never answered",
      { combinedOutput: "…did not answer within 10000ms" },
      "X display",
    ],
    [
      "a lost single-instance lock",
      { combinedOutput: "SingletonLock: File exists" },
      "single-instance lock",
    ],
    [
      "a bundle that never loaded over the renderer scheme",
      { combinedOutput: "failed to load sidekicks-renderer://app/index.html: ERR_FAILED" },
      "never loaded over the renderer",
    ],
    [
      "a probe expression that never evaluated",
      { combinedOutput: `${SMOKE_PROBE_TAG} executeJavaScript failed: boom` },
      "never evaluated in it",
    ],
    [
      "a main-process index fetch that failed",
      { combinedOutput: `${SMOKE_PROBE_TAG} index fetch failed: 404` },
      "fetch `sidekicks-renderer://app/index.html` back",
    ],
    [
      "a startup that rejected",
      { exitCode: 1, combinedOutput: "Error: boom" },
      "`app.whenReady()` rejected",
    ],
    ["a silent exit 0", { exitCode: 0, combinedOutput: "   \n" }, "printed nothing at all"],
    [
      "output that matches no marker",
      { exitCode: 3, combinedOutput: "some unrelated chatter" },
      "without a recognized failure marker",
    ],
  ] as const)("names %s", (_label, overrides, expectedFragment) => {
    expect(diagnoseMissingProbe(failedSpawn(overrides))).toContain(expectedFragment);
  });

  it("reports a hung round trip when did-finish-load fired and the deadline passed", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        timedOut: true,
        signal: "SIGTERM",
        readinessBreadcrumbs: ["dom-ready +120ms", "did-finish-load +300ms"],
      }),
    );

    expect(diagnosis).toContain("hung probe");
    // Negative control for the ordering: the generic deadline arm would say the opposite.
    expect(diagnosis).not.toContain("`did-finish-load` never fired");
  });

  // Evidence for both arms at once (a completed load and a failed readback); the specific arm
  // wins.
  it("prefers the index-fetch arm over the hung-round-trip arm", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        combinedOutput: `${SMOKE_PROBE_TAG} index fetch failed: 404`,
        timedOut: true,
        readinessBreadcrumbs: ["dom-ready +120ms", "did-finish-load +300ms"],
      }),
    );

    expect(diagnosis).toContain("could not fetch");
    expect(diagnosis).not.toContain("hung probe");
  });

  // The reverse overlap: a bundle that never loaded also times out, and the marker is the more
  // specific reading.
  it("prefers the renderer-scheme arm over the deadline arm", () => {
    const diagnosis = diagnoseMissingProbe(
      failedSpawn({
        combinedOutput: "failed to load sidekicks-renderer://app/index.html: ERR_FAILED",
        timedOut: true,
        signal: "SIGTERM",
      }),
    );

    expect(diagnosis).toContain("never loaded over the renderer");
    expect(diagnosis).not.toContain("deadline");
  });

  describe("the generic deadline arm", () => {
    it("says no readiness event fired when there are no breadcrumbs", () => {
      const diagnosis = diagnoseMissingProbe(failedSpawn({ timedOut: true, signal: "SIGTERM" }));

      expect(diagnosis).toContain("`did-finish-load` never fired");
      expect(diagnosis).toContain("No readiness event fired at all");
      expect(diagnosis).toContain("terminated (SIGTERM)");
    });

    it("lists the breadcrumbs that did fire", () => {
      const diagnosis = diagnoseMissingProbe(
        failedSpawn({
          timedOut: true,
          signal: "SIGTERM",
          readinessBreadcrumbs: ["dom-ready +120ms"],
        }),
      );

      expect(diagnosis).toContain("Readiness reached: dom-ready +120ms.");
    });

    // A `signal !== null` test would send this to the `exitCode === 1` arm and report a startup
    // failure that did not happen.
    it("reads a shim-forwarded SIGTERM as a deadline kill, not a startup failure", () => {
      const diagnosis = diagnoseMissingProbe(
        failedSpawn({ timedOut: true, signal: null, exitCode: 1 }),
      );

      expect(diagnosis).toContain("the electron shim forwarded it and exited 1");
      expect(diagnosis).not.toContain("`app.whenReady()` rejected");
    });
  });
});

// The smoke harness's pure parts, driven without a launch: the breadcrumb scanner's
// line buffering, the derived timing budgets, and the diagnosis of a missing probe
// line. None of them spawns Electron or needs a built bundle, so they run in
// `main-unit`, the project a person runs before pushing.

import { describe, expect, it } from "vitest";

import { DISPLAY_READY_TIMEOUT_MS } from "./display-readiness.js";
import { TEST_TIMEOUT_SLACK_MS } from "./electron-child.js";
import { TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import {
  DIAGNOSTIC_BUDGET_MS,
  DIAGNOSTIC_COLLECTION_CEILING_MS,
  DIAGNOSTIC_PROBE_TIMEOUT_MS,
  diagnoseMissingProbe,
  READINESS_BREADCRUMB_TAG,
  ReadinessLineScanner,
  SMOKE_PROBE_TAG,
} from "./smoke-probe-diagnosis.js";
import {
  BOOT_TEST_TIMEOUT_MS,
  FORCED_STALL_SPAWN_TIMEOUT_MS,
  FORCED_STALL_TEST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
  type SpawnResult,
} from "./smoke-probe-harness.js";

// Unit coverage for the breadcrumb scanner's line buffering.
//
// This is the failure the buffer exists to stop: a breadcrumb straddling a
// chunk boundary was previously split into two fragments, NEITHER of which
// matched the tag, so the breadcrumb vanished. That is the worst possible
// outcome for a diagnostic trail — it goes missing precisely when the process
// is under enough load to fragment its own writes, which is the load that
// produces the stalls it is there to explain.
describe("ReadinessLineScanner", () => {
  const emit = (event: string, offsetMs: number): string =>
    `${READINESS_BREADCRUMB_TAG} ${event} +${String(offsetMs)}ms\n`;

  it("recovers a breadcrumb split across two chunks", () => {
    const line = emit("dom-ready", 133);
    // Split inside the TAG itself, which is the case a naive per-chunk
    // `split("\n")` cannot recover from at all.
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
    // No trailing newline: the breadcrumb is not complete and must NOT be
    // reported yet, or a truncated offset would be recorded as fact.
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
    // The reason each stream gets its own instance: a shared one would splice
    // stdout's tail onto stderr's head and synthesise a line neither emitted.
    const stdoutScanner = new ReadinessLineScanner();
    const stderrScanner = new ReadinessLineScanner();
    expect(stdoutScanner.push(`${READINESS_BREADCRUMB_TAG} dom-`)).toEqual([]);
    expect(stderrScanner.push(`${READINESS_BREADCRUMB_TAG} ready-to-show +2ms\n`)).toEqual([
      "ready-to-show +2ms",
    ]);
    expect(stdoutScanner.push("ready +1ms\n")).toEqual(["dom-ready +1ms"]);
  });
});

// The budget arithmetic, asserted rather than trusted to a comment.
//
// Every timing constant the smoke harness holds is derived from another one so that
// raising a phase raises everything that must contain it. That property is
// only worth having if it is checked: the defect that produced this block was
// exactly a derivation that read plausibly and did not hold — the diagnostic
// collection was MEASURED from one instant and BOUNDED from a later one, so a
// collection whose probes each ran to their cap exceeded the budget it was
// asserted to honour, and the control meant to produce the dump failed instead.
// A comment cannot catch that returning; these can.
describe("derived timing budgets", () => {
  it("leaves the close-event reserve intact above the largest legal collection", () => {
    // The hole this closes, and the reason it is stated as "slack ON TOP of the
    // ceiling" rather than "contains the ceiling": the superseded derivation
    // (`spawn + DIAGNOSTIC_BUDGET_MS + grace + slack`) does contain the ceiling
    // — but only by spending the slack to do it, leaving nothing for the
    // unbounded terms that slack exists for (the spawn itself, the `close`
    // event after SIGTERM, temp-profile cleanup). A legal-but-slow collection
    // would then fail on the runner's generic test timeout, losing the dump in
    // precisely the case the dump exists for.
    //
    // Written in the weaker "contains the ceiling" form, this test would pass
    // against the very derivation it exists to reject — which is worth saying
    // out loud, because an arithmetic guard over constants in its own file is
    // worth its line count only if it fails on the state it replaced. This one
    // was run against that state and does.
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
    // The display-readiness gate is the phase this guard was added for: it runs
    // inside `spawnElectron` BEFORE the spawn deadline timer is armed, so it is
    // invisible to the spawn budget and was for a while invisible to both
    // enclosures too. Every separately-bounded phase belongs in the enclosure
    // of any test that can reach it, and the negative control's own budget
    // already names its (overridden) display term, which is what made the
    // omission in the other two legible.
    for (const enclosure of [BOOT_TEST_TIMEOUT_MS, FORCED_STALL_TEST_TIMEOUT_MS]) {
      expect(enclosure).toBeGreaterThan(
        DISPLAY_READY_TIMEOUT_MS + DIAGNOSTIC_COLLECTION_CEILING_MS,
      );
    }
  });

  it("keeps the shared wall budget binding rather than decorative", () => {
    // The collection's worst case is `min(wall budget, sum of the per-probe
    // caps)`. If the wall exceeded that sum it could never bind, and the
    // collection's worst case would once again be a sum of independent
    // timeouts — the shape that started this. There are two probes.
    const boundedProbeCount = 2;
    expect(DIAGNOSTIC_BUDGET_MS).toBeLessThanOrEqual(
      DIAGNOSTIC_PROBE_TIMEOUT_MS * boundedProbeCount,
    );
  });

  it("keeps the collection ceiling tight enough to catch the shape it replaced", () => {
    // The superseded collection carried two independent 5 s `spawnSync`
    // timeouts. The ceiling must stay below that sum, or the assertion stops
    // being a regression guard and becomes a formality.
    const supersededIndependentProbeTimeoutMs = 5_000;
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeLessThan(supersededIndependentProbeTimeoutMs * 2);
    // And loose enough to hold the budget plus a real reserve, so the control
    // is not itself a wall-clock flake.
    expect(DIAGNOSTIC_COLLECTION_CEILING_MS).toBeGreaterThan(DIAGNOSTIC_BUDGET_MS);
  });
});

// `diagnoseMissingProbe` turns "no probe line arrived" into a named cause, and
// it is the one part of the harness a real spawn cannot exercise: reaching an
// arm needs a boot that failed in that specific way, and a green run reaches
// none of them. These cases drive it directly over synthetic output.
//
// The ORDER of the arms is the substance, not decoration. Several failure
// shapes leave overlapping evidence — a timed-out process with a
// `did-finish-load` breadcrumb matches both the round-trip arm and the generic
// deadline arm — so each ordering-sensitive pair below is asserted with the
// evidence of BOTH arms present, which is the only arrangement that can catch a
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
      "without a recognised failure marker",
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
    // The negative control for the ordering: the generic deadline arm would
    // report the opposite of what happened.
    expect(diagnosis).not.toContain("`did-finish-load` never fired");
  });

  // Both arms' evidence is present at once — a completed load AND a failed
  // main-process readback — which is exactly the shape that made the ordering
  // load-bearing. The specific arm must win.
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

  // The other direction of the same overlap: a bundle that never loaded also
  // times out, and the marker is the more specific reading.
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

    // The shim disposition. A `signal !== null` test would have handed this to
    // the `exitCode === 1` arm and reported a startup failure that never
    // happened — see `SpawnResult.timedOut`.
    it("reads a shim-forwarded SIGTERM as a deadline kill, not a startup failure", () => {
      const diagnosis = diagnoseMissingProbe(
        failedSpawn({ timedOut: true, signal: null, exitCode: 1 }),
      );

      expect(diagnosis).toContain("the electron shim forwarded it and exited 1");
      expect(diagnosis).not.toContain("`app.whenReady()` rejected");
    });
  });
});

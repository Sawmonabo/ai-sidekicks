// What the capability read does and does not decide, per run.
//
// The claim under test is that one driver's declaration never answers for another
// driver's run. It is asserted on the pure resolvers rather than through a tree,
// because the rule is arithmetic over a reply and a rendered row would put a
// component between the assertion and it — the pane's own suite covers the
// rendering half.

import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import {
  boundDriverNameForRun,
  driverCapabilityForRun,
  isControlOffered,
  type DeclaredDriverFlags,
  type DriverCapabilityReadout,
} from "./run-control-gating.js";

const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const CODEX_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

/**
 * One driver's record: the named flags true, every other flag false.
 *
 * Derived from the shipped closed set rather than hand-listed, exactly as the
 * fixture's own scenario does: `DriverCapabilities.flags` is a total record parsed
 * `.strict()`, so a hand list would go stale the day the set grows.
 */
function declaredFlags(declared: readonly DriverCapabilityFlag[]): DeclaredDriverFlags {
  const asserted = new Set<DriverCapabilityFlag>(declared);
  return Object.fromEntries(
    DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, asserted.has(flag)]),
  ) as DeclaredDriverFlags;
}

/** A readout over the named reports, with the named run bindings. */
function readout(
  reports: readonly (readonly [string, readonly DriverCapabilityFlag[]])[],
  bindings: readonly (readonly [string, string])[] = [],
): DriverCapabilityReadout {
  return {
    flagsByDriverName: new Map(
      reports.map(([driverName, declared]) => [driverName, declaredFlags(declared)]),
    ),
    driverNameByRunId: new Map(bindings),
  };
}

describe("capability gating resolves the run's own bound driver", () => {
  it("keeps Rewind on a Claude run while a Codex driver reports rollback false", () => {
    const capabilities = readout(
      [
        ["claude", ["steer", "rollback"]],
        ["codex", ["steer"]],
      ],
      [
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ],
    );
    expect(driverCapabilityForRun(capabilities, CLAUDE_RUN, "rollback")).toBe(true);
    expect(isControlOffered("rollback", capabilities, CLAUDE_RUN)).toBe(true);
  });

  it("hides Rewind on the run whose own driver declared it absent", () => {
    const capabilities = readout(
      [
        ["claude", ["steer", "rollback"]],
        ["codex", ["steer"]],
      ],
      [
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ],
    );
    expect(driverCapabilityForRun(capabilities, CODEX_RUN, "rollback")).toBe(false);
    expect(isControlOffered("rollback", capabilities, CODEX_RUN)).toBe(false);
  });

  it("negative control: the session-wide intersection would have hidden both", () => {
    // The old rule, spelled out so the two cases above fail on it rather than
    // passing over a gate that never had the defect.
    const reports = [declaredFlags(["steer", "rollback"]), declaredFlags(["steer"])];
    expect(reports.every((report) => report.rollback)).toBe(false);
  });

  it("resolves every run to the only driver a single-report reply admits", () => {
    // One driver reported for the session is the only binding any run in it can
    // hold, so this is a resolution rather than a guess.
    const capabilities = readout([["claude", ["steer", "rollback"]]]);
    expect(boundDriverNameForRun(capabilities, CLAUDE_RUN)).toBe("claude");
    expect(driverCapabilityForRun(capabilities, CLAUDE_RUN, "steer")).toBe(true);
  });
});

describe("an unnameable binding says so rather than guessing", () => {
  it("answers undefined for a run no binding names when several drivers reported", () => {
    const capabilities = readout([
      ["claude", ["steer", "rollback"]],
      ["codex", ["steer", "rollback"]],
    ]);
    expect(boundDriverNameForRun(capabilities, CLAUDE_RUN)).toBeUndefined();
    expect(driverCapabilityForRun(capabilities, CLAUDE_RUN, "rollback")).toBeUndefined();
    expect(isControlOffered("rollback", capabilities, CLAUDE_RUN)).toBe(false);
  });

  it("answers undefined for a binding naming a driver that filed no report", () => {
    const capabilities = readout([["claude", ["steer", "rollback"]]], [[CODEX_RUN, "codex"]]);
    expect(driverCapabilityForRun(capabilities, CODEX_RUN, "rollback")).toBeUndefined();
  });

  it("answers undefined before the read has come back", () => {
    expect(driverCapabilityForRun(undefined, CLAUDE_RUN, "rollback")).toBeUndefined();
    expect(isControlOffered("rollback", undefined, CLAUDE_RUN)).toBe(false);
  });

  it("negative control: an ungated control is offered through every one of those arms", () => {
    // Without this the cases above would pass over a gate that hid everything, and
    // would prove nothing about the two flags that are actually gated.
    for (const capabilities of [
      undefined,
      readout([
        ["claude", []],
        ["codex", []],
      ]),
    ]) {
      expect(isControlOffered("cancel", capabilities, CLAUDE_RUN)).toBe(true);
      expect(isControlOffered("interrupt", capabilities, CLAUDE_RUN)).toBe(true);
    }
  });
});

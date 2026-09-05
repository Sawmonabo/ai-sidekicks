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
  readingForRun,
  withRunDriverBindings,
  type DriverCapabilityReadout,
} from "../../../bridge/index.js";
// The declaring modules rather than the door: both names are read only from this
// suite, and a door line no production module imports is a dead export.
import { foldRunDriverBindings } from "../../../bridge/run-driver-binding.js";
import type { DeclaredDriverFlags } from "../../../bridge/driver-capability-read.js";
import type { ConsoleEntity, ConsoleSessionEvent } from "../../../store/index.js";
import { isControlOffered } from "./run-control-gating.js";

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
    readRefusal: undefined,
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
    expect(readingForRun(capabilities, CLAUDE_RUN, "rollback")).toBe("declared");
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
    expect(readingForRun(capabilities, CODEX_RUN, "rollback")).toBe("undeclared");
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
    expect(readingForRun(capabilities, CLAUDE_RUN, "steer")).toBe("declared");
  });
});

describe("an unnameable binding says so rather than guessing", () => {
  it("answers undefined for a run no binding names when several drivers reported", () => {
    const capabilities = readout([
      ["claude", ["steer", "rollback"]],
      ["codex", ["steer", "rollback"]],
    ]);
    expect(readingForRun(capabilities, CLAUDE_RUN, "rollback")).toBe("unknown");
    expect(isControlOffered("rollback", capabilities, CLAUDE_RUN)).toBe(false);
  });

  it("answers undefined for a binding naming a driver that filed no report", () => {
    const capabilities = readout([["claude", ["steer", "rollback"]]], [[CODEX_RUN, "codex"]]);
    expect(readingForRun(capabilities, CODEX_RUN, "rollback")).toBe("unknown");
  });

  it("answers undefined before the read has come back", () => {
    expect(readingForRun(undefined, CLAUDE_RUN, "rollback")).toBe("unknown");
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

// Where the binding comes from. The two blocks above are handed one; this one builds
// it out of a session the way the pane does, because the defect was that nothing did
// — the readout published an empty map, and a node with both drivers installed
// therefore lost every run's gated controls however loudly its own driver declared
// them.
describe("the session's own projection is what names a run's driver", () => {
  const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
  const CLAUDE_AGENT = "agent-claude";
  const CODEX_AGENT = "agent-codex";

  const BOTH_DRIVERS_INSTALLED = [
    ["claude", ["steer", "rollback"]],
    ["codex", ["steer"]],
  ] as const;

  function agentAttached(
    sequence: number,
    agentId: string,
    driverName: string,
  ): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      kind: "agent.attached",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { sessionId: SESSION_ID, agentId, name: "Ada", driverName, state: "ready" },
    };
  }

  function runsBoundTo(
    ...pairs: readonly (readonly [string, string])[]
  ): Readonly<Record<string, ConsoleEntity>> {
    return Object.fromEntries(
      pairs.map(([runId, agentId]) => [
        runId,
        { kind: "run", id: runId, state: "running", body: { agentId } } satisfies ConsoleEntity,
      ]),
    );
  }

  it("gates each run on its own agent's driver on a node running both", () => {
    const bindings = foldRunDriverBindings(
      runsBoundTo([CLAUDE_RUN, CLAUDE_AGENT], [CODEX_RUN, CODEX_AGENT]),
      [agentAttached(1, CLAUDE_AGENT, "claude"), agentAttached(2, CODEX_AGENT, "codex")],
    );
    const capabilities = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), bindings);

    // The Codex run's own driver declared rollback absent, which is a DECLARATION
    // rather than an absence of one — and Steer, which it did declare, is offered.
    expect(readingForRun(capabilities, CODEX_RUN, "rollback")).toBe("undeclared");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(true);
    expect(isControlOffered("rollback", capabilities, CLAUDE_RUN)).toBe(true);
  });

  it("withholds the control for a run whose agent nothing attached, and says which fact that is", () => {
    // Three answers and they are three different facts. This is `undefined` — the
    // console cannot say — and never the `false` the case above asserts, so a row
    // whose binding is unknown is never reported as a driver that declined.
    const bindings = foldRunDriverBindings(runsBoundTo([CODEX_RUN, "agent-nobody-attached"]), [
      agentAttached(1, CLAUDE_AGENT, "claude"),
    ]);
    const capabilities = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), bindings);

    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("unknown");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(false);
  });

  it("negative control: with no join, a two-driver node names no run's driver at all", () => {
    // The shipped behaviour before this producer existed, spelled out so the case
    // above fails on it rather than passing over a resolution that never had the
    // defect.
    const unjoined = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), new Map());
    expect(isControlOffered("steer", unjoined, CLAUDE_RUN)).toBe(false);
    expect(isControlOffered("rollback", unjoined, CODEX_RUN)).toBe(false);
  });
});

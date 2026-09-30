// What the capability read decides per run: one driver's declaration never answers for another
// driver's run. Asserted on the pure resolvers; the pane's own suite covers rendering.

import { describe, expect, it } from "vitest";

import {
  readingForRun,
  withRunDriverBindings,
} from "@renderer/store/driver-capabilities/driver-capability-readings.js";
import { foldRunDriverBindings } from "./run-driver-bindings.js";
import type { StoredEntity } from "@renderer/store/session/entities/entities.js";
import { definitionAgentQueuedBeat, leadCreatedBeat } from "./agent-entry-beats.test-support.js";
import {
  capabilityReadout as readout,
  declaredFlags,
} from "./driver-capability-readout.test-support.js";
import { isControlOffered, offeredRunControls } from "./run-control-gating.js";

const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const CODEX_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

describe("capability gating resolves the run's own bound driver", () => {
  it("keeps Steer on a Claude run while a Codex driver reports steer false", () => {
    const capabilities = readout(
      [
        ["claude", ["steer"]],
        ["codex", []],
      ],
      [
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ],
    );
    expect(readingForRun(capabilities, CLAUDE_RUN, "steer")).toBe("declared");
    expect(isControlOffered("steer", capabilities, CLAUDE_RUN)).toBe(true);
  });

  it("hides Steer on the run whose own driver declared it absent", () => {
    const capabilities = readout(
      [
        ["claude", ["steer"]],
        ["codex", []],
      ],
      [
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ],
    );
    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("undeclared");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(false);
  });

  it("negative control: the session-wide intersection would have hidden both", () => {
    // The wrong rule, spelled out so the cases above fail on it.
    const reports = [declaredFlags(["steer"]), declaredFlags([])];
    expect(reports.every((report) => report.steer)).toBe(false);
  });

  it("resolves every run to the only driver a single-report reply admits", () => {
    // One driver reported for the session is the only binding any run in it can hold.
    const capabilities = readout([["claude", ["steer"]]]);
    expect(readingForRun(capabilities, CLAUDE_RUN, "steer")).toBe("declared");
  });
});

describe("an unnameable binding says so rather than guessing", () => {
  it("answers undefined for a run no binding names when several drivers reported", () => {
    const capabilities = readout([
      ["claude", ["steer"]],
      ["codex", ["steer"]],
    ]);
    expect(readingForRun(capabilities, CLAUDE_RUN, "steer")).toBe("unknown");
    expect(isControlOffered("steer", capabilities, CLAUDE_RUN)).toBe(false);
  });

  it("answers undefined for a binding naming a driver that filed no report", () => {
    const capabilities = readout([["claude", ["steer"]]], [[CODEX_RUN, "codex"]]);
    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("unknown");
  });

  it("answers undefined before the read has come back", () => {
    expect(readingForRun(undefined, CLAUDE_RUN, "steer")).toBe("unknown");
    expect(isControlOffered("steer", undefined, CLAUDE_RUN)).toBe(false);
  });

  it("negative control: an ungated control is offered through every one of those arms", () => {
    // Without this the cases above would pass over a gate that hid everything.
    for (const capabilities of [
      undefined,
      readout([
        ["claude", []],
        ["codex", []],
      ]),
    ]) {
      expect(isControlOffered("pause", capabilities, CLAUDE_RUN)).toBe(true);
      expect(isControlOffered("resume", capabilities, CLAUDE_RUN)).toBe(true);
      expect(isControlOffered("interrupt", capabilities, CLAUDE_RUN)).toBe(true);
    }
  });
});

// Where the binding comes from: this block builds it from a session as the pane does, since
// an empty map loses every run's gated controls on a node with both drivers installed.
describe("the session's own projection is what names a run's driver", () => {
  const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
  const LEAD_AGENT = "019b7a33-3300-7a6e-8110-d1a4c1150301";
  const OTHER_AGENT = "019b7a33-3300-7a6e-8120-d1a4c1150302";

  const BOTH_DRIVERS_INSTALLED = [
    ["claude", ["steer"]],
    ["codex", []],
  ] as const;

  function runsBoundTo(
    ...pairs: readonly (readonly [string, string])[]
  ): Readonly<Record<string, StoredEntity>> {
    return Object.fromEntries(
      pairs.map(([runId, agentId]) => [
        runId,
        { kind: "run", id: runId, state: "running", body: { agentId } } satisfies StoredEntity,
      ]),
    );
  }

  it("gates each run on its own agent's driver in one session running both", () => {
    // A Codex lead and a Claude agent started from its saved definition: each run is gated
    // by its own driver.
    const bindings = foldRunDriverBindings(
      runsBoundTo([CODEX_RUN, LEAD_AGENT], [CLAUDE_RUN, OTHER_AGENT]),
      [
        leadCreatedBeat({ sessionId: SESSION_ID, leadAgentId: LEAD_AGENT, driverName: "codex" }),
        definitionAgentQueuedBeat({
          sessionId: SESSION_ID,
          runId: CLAUDE_RUN,
          agentId: OTHER_AGENT,
          leadAgentId: LEAD_AGENT,
          driverName: "claude",
        }),
      ],
    );
    const capabilities = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), bindings);

    // The Codex driver declared steer absent, which is a declaration, not an absence of one.
    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("undeclared");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(false);
    expect(isControlOffered("steer", capabilities, CLAUDE_RUN)).toBe(true);
  });

  it("withholds the control for a run whose agent no row brings into the session, and says which fact that is", () => {
    // `undefined` (the console cannot say) is a different fact from the `false` above; an
    // unknown binding is never reported as a driver that declined.
    const bindings = foldRunDriverBindings(runsBoundTo([CODEX_RUN, OTHER_AGENT]), [
      leadCreatedBeat({ sessionId: SESSION_ID, leadAgentId: LEAD_AGENT, driverName: "claude" }),
    ]);
    const capabilities = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), bindings);

    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("unknown");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(false);
  });

  it("negative control: with no join, a two-driver node names no run's driver at all", () => {
    // An empty binding map, spelled out so the case above fails on it.
    const unjoined = withRunDriverBindings(readout(BOTH_DRIVERS_INSTALLED), new Map());
    expect(isControlOffered("steer", unjoined, CLAUDE_RUN)).toBe(false);
  });
});

describe("the row's offer reading, which the palette contributes from", () => {
  const CAPABLE = readout([["claude", ["steer"]]], [[CLAUDE_RUN, "claude"]]);

  it("offers pause, stop and steer on a running run", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "running" }, CAPABLE);

    expect(offered.primary).toEqual(["pause", "interrupt"]);
    expect(offered.overflow).toEqual(["steer"]);
  });

  it("offers resume in place of pause once the run is paused", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "paused" }, CAPABLE);

    expect(offered.primary).toEqual(["resume", "interrupt"]);
  });

  it("offers no pause, resume or stop on a terminal run", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "completed" }, CAPABLE);

    expect(offered.primary).toEqual([]);
  });

  it("keeps steer off a run whose driver did not declare it", () => {
    const bare = readout([["codex", []]], [[CODEX_RUN, "codex"]]);

    const offered = offeredRunControls({ runId: CODEX_RUN, state: "running" }, bare);

    expect(offered.overflow).toEqual([]);
  });

  it("keeps steer off a run whose capabilities were never read", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "running" }, undefined);

    expect(offered.overflow).toEqual([]);
  });
});

// What the fixture answers a roster read with, driven over the real scenario engine.
//
// Three claims, and each one is a way the arm could look right and be wrong:
//
//   • **A frame is chosen by the frozen clock, not by array position.** A fixture that
//     always answered with the last frame would pass every "the roster is served"
//     assertion and make the whole snapshot-plus-signal discipline unobservable. The
//     selection is by the latest `atMs` that has fallen due, so a scenario whose frames
//     are declared out of order is answered correctly too — which the sorted literals
//     this repository ships could never show.
//   • **The two refusals are different facts.** "Nobody scripted a roster" and "that is
//     not the session this scenario plays" are drawn differently, and a surface that
//     collapsed them would tell a person her machines are unknown when the read was
//     never about her session at all.
//   • **The two health axes move independently.** The frame pair either side of the
//     departure beat has to disagree in OPPOSITE directions on the two axes, which is
//     the state the never-mask rule exists for and the reason both scenarios carry a
//     roster at all.
//
// The seam's own vocabulary — the procedure name, the presence event set, the shipped
// frames' conformance to the registered response schema — is the suite beside
// `runtime-nodes/runtime-node-roster.ts`, which is where those live.

import { describe, expect, it } from "vitest";

import type { NodeId, RuntimeNodeRosterEntry, SessionId } from "@ai-sidekicks/contracts";

import {
  readRuntimeNodeRosterFromScenario,
  RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES,
} from "./fixture-runtime-node-roster.js";
import { RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN } from "../runtime-nodes/runtime-node-roster.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { SETTINGS_SCENARIO } from "../scenarios/settings.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ConsoleScenario, ScenarioRuntimeNodeRosterFrame } from "../scenario-runtime/index.js";
import type { RuntimeNodeRosterOutcome } from "../runtime-nodes/index.js";

/** A session id no scenario plays, for the wrong-session arm. */
const FOREIGN_SESSION_ID = "019b7904-8ce0-75e5-8510-000000000000" as SessionId;

/** Read one scenario's roster at a tick, driving the real engine to get there. */
function rosterAt(scenario: ConsoleScenario, elapsedMs: number): RuntimeNodeRosterOutcome {
  const engine = new ScenarioEngine({ scenario });
  engine.advance(elapsedMs);
  return readRuntimeNodeRosterFromScenario(engine, {
    sessionId: scenario.sessionId as SessionId,
  });
}

/** The served node set, or a failure naming what the read answered instead. */
function servedNodes(outcome: RuntimeNodeRosterOutcome): readonly RuntimeNodeRosterEntry[] {
  expect(
    outcome.status,
    outcome.status === "refused" ? `the read refused: ${outcome.code}` : "",
  ).toBe("served");
  return outcome.status === "served" ? outcome.value.nodes : [];
}

/** One node's two health axes, as the frame reports them. */
function axesOf(
  nodes: readonly RuntimeNodeRosterEntry[],
  nodeId: string,
): { state: string; healthState: string | null } {
  const entry = nodes.find((node) => node.nodeId === nodeId);
  expect(entry, `no roster row for ${nodeId}`).toBeDefined();
  return { state: entry?.state ?? "", healthState: entry?.healthState ?? null };
}

describe("the fixture roster read", () => {
  it("serves the empty reading a session with no attachments has", () => {
    // Not a refusal, and the distinction is the point: the read WAS answered and
    // what it found was nothing. A surface draws that; it does not draw "nobody
    // asked".
    expect(servedNodes(rosterAt(SETTINGS_SCENARIO, 0))).toStrictEqual([]);
  });

  it("serves the reading in which the liveness axis has nothing to say yet", () => {
    // Both machines admitted, neither heartbeating: the read LEFT-JOINs presence on
    // the attachment, so both liveness members are NULL together. A scenario that
    // could not express this would leave the page's only "not measured yet" state
    // unreachable, and a page built without it renders a verdict nobody reached.
    const nodes = servedNodes(rosterAt(SETTINGS_SCENARIO, 60));
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.healthState === null)).toBe(true);
    expect(nodes.every((node) => node.lastHeartbeatAt === null)).toBe(true);
    // The negative control for the pair above: a later reading has both, so the
    // nulls are this frame's rather than the factory's.
    const later = servedNodes(rosterAt(SETTINGS_SCENARIO, 200));
    expect(later.every((node) => node.healthState !== null)).toBe(true);
    expect(later.every((node) => node.lastHeartbeatAt !== null)).toBe(true);
  });

  it("serves the reading current at the tick the clock has reached", () => {
    expect(servedNodes(rosterAt(SETTINGS_SCENARIO, 200))).toHaveLength(2);
    expect(servedNodes(rosterAt(COLLABORATION_SCENARIO, 600))).toHaveLength(3);
  });

  it("answers a later tick with a later reading", () => {
    // The negative control for the case above: a fixture that ignored the clock and
    // always returned one frame would satisfy every "serves N nodes" assertion.
    const before = axesOf(servedNodes(rosterAt(SETTINGS_SCENARIO, 200)), "node-builder");
    const after = axesOf(servedNodes(rosterAt(SETTINGS_SCENARIO, 320)), "node-builder");
    expect(before).not.toStrictEqual(after);
  });

  it("refuses when the scenario names no roster at all", () => {
    const outcome = rosterAt(FLAGSHIP_SCENARIO, 400);
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.code : "").toBe("roster-unscripted");
    expect(outcome.status === "refused" ? outcome.origin : "").toBe(
      RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN,
    );
  });

  it("refuses a session this scenario is not playing", () => {
    const engine = new ScenarioEngine({ scenario: SETTINGS_SCENARIO });
    engine.advance(320);
    const outcome = readRuntimeNodeRosterFromScenario(engine, { sessionId: FOREIGN_SESSION_ID });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.code : "").toBe("session-not-played");
  });

  it("raises every code it declares, and declares every code it raises", () => {
    const raised = new Set(
      [rosterAt(FLAGSHIP_SCENARIO, 400)].map((outcome) =>
        outcome.status === "refused" ? outcome.code : "",
      ),
    );
    const engine = new ScenarioEngine({ scenario: SETTINGS_SCENARIO });
    const foreign = readRuntimeNodeRosterFromScenario(engine, { sessionId: FOREIGN_SESSION_ID });
    raised.add(foreign.status === "refused" ? foreign.code : "");
    expect([...raised].sort()).toStrictEqual(
      [...RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES].sort(),
    );
  });
});

describe("the frame current at a tick", () => {
  /** A scenario carrying exactly the frames a case names, in the order it names them. */
  function scenarioWithFrames(frames: readonly ScenarioRuntimeNodeRosterFrame[]): ConsoleScenario {
    return { ...SETTINGS_SCENARIO, runtimeNodeRoster: frames };
  }

  /** The `atMs` of the frame the read answered with, read back off its single node. */
  function answeredFrameId(scenario: ConsoleScenario, elapsedMs: number): string {
    return servedNodes(rosterAt(scenario, elapsedMs))[0]?.nodeId ?? "";
  }

  /**
   * One frame, identified by the node id it carries, claimed at `atMs`.
   *
   * Built by widening a SHIPPED frame rather than by writing a row here, so this
   * fixture cannot drift from the registered response shape the suite next door holds
   * every shipped frame to. `as NodeId` is the assertion every scenario literal makes
   * for the same identifier.
   */
  function frameAt(atMs: number, nodeId: string): ScenarioRuntimeNodeRosterFrame {
    // The first POPULATED frame, not the first: that scenario opens on an empty roster,
    // which is a reading in its own right and carries no row to widen.
    const node = (SETTINGS_SCENARIO.runtimeNodeRoster ?? []).flatMap((frame) => frame.nodes)[0];
    if (node === undefined) {
      throw new Error("the settings scenario carries no populated roster frame to build from");
    }
    return { atMs, nodes: [{ ...node, nodeId: nodeId as NodeId }], controlHolder: null };
  }

  it("negative control: is the latest due frame even where the literal is unsorted", () => {
    // The case the replaced fold could not answer. It kept the last ARRAY entry whose
    // `atMs` had fallen due, which equals "the newest due frame" only while the
    // literal happens to be ascending — nothing states, asserts, or enforces that. A
    // family appending a late frame above an earlier one got a silently stale roster
    // for every read past both ticks, with no gate reporting it.
    const unsorted = scenarioWithFrames([
      frameAt(0, "node-first"),
      frameAt(600, "node-latest"),
      frameAt(300, "node-middle"),
    ]);
    expect(answeredFrameId(unsorted, 900)).toBe("node-latest");
    expect(answeredFrameId(unsorted, 450)).toBe("node-middle");
    expect(answeredFrameId(unsorted, 0)).toBe("node-first");
  });

  it("answers the later declaration where two frames claim one instant", () => {
    // A tie has nothing but declaration order to decide it, and the later one is what
    // the previous fold answered for the sorted case it was right about.
    const tied = scenarioWithFrames([frameAt(300, "node-earlier"), frameAt(300, "node-later")]);
    expect(answeredFrameId(tied, 300)).toBe("node-later");
  });

  it("refuses before the first frame has fallen due", () => {
    const late = scenarioWithFrames([frameAt(300, "node-first")]);
    const outcome = rosterAt(late, 299);
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.code : "").toBe("roster-unscripted");
  });
});

describe("the two health axes", () => {
  it("move independently across the beat that changes one of them", () => {
    // The settings story: the builder's SLOT degrades at 320 while its LIVENESS
    // recovers. A page collapsing the two would have to report one of these.
    const before = axesOf(servedNodes(rosterAt(SETTINGS_SCENARIO, 200)), "node-builder");
    const after = axesOf(servedNodes(rosterAt(SETTINGS_SCENARIO, 320)), "node-builder");
    expect(before).toStrictEqual({ state: "online", healthState: "degraded" });
    expect(after).toStrictEqual({ state: "degraded", healthState: "online" });
  });

  it("can disagree outright, which the wire admits by construction", () => {
    // The collaboration story: the runner's attachment reaches its departure
    // verdict while the sweep still finds the machine healthy.
    const after = axesOf(servedNodes(rosterAt(COLLABORATION_SCENARIO, 640)), "node-tomas-runner");
    expect(after).toStrictEqual({ state: "offline", healthState: "online" });
  });

  it("keeps a below-floor machine in the set rather than hiding it", () => {
    // Admit-not-eject: a node whose reported wire version is below the session's
    // floor is rendered read-only, never dropped. A roster that filtered it would
    // pass a node-count assertion and hide a participant's own machine from her.
    const nodes = servedNodes(rosterAt(COLLABORATION_SCENARIO, 640));
    expect(nodes.filter((node) => node.readOnly)).toHaveLength(1);
    expect(nodes).toHaveLength(3);
  });
});

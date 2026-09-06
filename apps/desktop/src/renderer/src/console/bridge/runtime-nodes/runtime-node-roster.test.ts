// The runtime-node seam, held to the wire it claims to speak.
//
// Four claims, and each one is a way the seam could look right and be wrong:
//
//   • **The subscribed name set is the contract's, minus a partition the contract
//     itself draws.** This file imports the census as a VALUE — a test is not
//     bundled, so it can read what the seam may only reference as a type — and
//     derives the expected set from `RUNTIME_NODE_EVENT_NAMES` rather than listing
//     five strings a second time. A hand-list would go on passing over a name the
//     contract added and the seam never subscribed to.
//   • **A frame is chosen by the frozen clock, not by array position.** A fixture
//     that always answered with the last frame would pass every "the roster is
//     served" assertion and make the whole snapshot-plus-signal discipline
//     unobservable.
//   • **Every shipped roster frame is a reading the wire could actually return.**
//     The scenarios assert branded identifiers with `as`, which the compiler takes
//     on trust; `RuntimeNodeRosterResponseSchema` is what discharges the claim, and
//     it is `.strict()`, so an invented member fails here too.
//   • **The two health axes move independently.** The frame pair either side of the
//     departure beat has to disagree in OPPOSITE directions on the two axes, which
//     is the state the never-mask rule exists for and the reason both scenarios
//     carry a roster at all.

import { describe, expect, it } from "vitest";

import {
  RUNTIME_NODE_EVENT_NAMES,
  RuntimeNodeRosterResponseSchema,
  type RuntimeNodeRosterEntry,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { CONSOLE_SCENARIOS } from "../scenarios/index.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { SETTINGS_SCENARIO } from "../scenarios/settings.js";
import {
  RUNTIME_NODE_PRESENCE_EVENT_NAMES,
  RUNTIME_NODE_ROSTER_PROCEDURE,
  RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES,
  RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN,
  readRuntimeNodeRosterFromScenario,
  type RuntimeNodeRosterOutcome,
} from "./runtime-node-roster.js";
import { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

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

describe("the presence subscription's name set", () => {
  it("carries every registered name that announces a node-state transition", () => {
    // Derived from the census, not listed: the two excluded names are the two whose
    // registered payload uses the REDUCED base and carries no state transition at
    // all, so the partition is the contract's own and an eighth registered name
    // would land in whichever half this derivation puts it in — and fail the
    // seam's own `satisfies` table first if nobody classified it.
    const capabilityNames = RUNTIME_NODE_EVENT_NAMES.filter((name) =>
      name.startsWith("runtime_node.capability_"),
    );
    const expected = RUNTIME_NODE_EVENT_NAMES.filter((name) => !capabilityNames.includes(name));
    expect([...RUNTIME_NODE_PRESENCE_EVENT_NAMES].sort()).toStrictEqual([...expected].sort());
    // The negative control for the derivation above: a partition that selected
    // everything would make the assertion vacuous.
    expect(capabilityNames).toHaveLength(2);
    expect(RUNTIME_NODE_PRESENCE_EVENT_NAMES.length).toBeLessThan(RUNTIME_NODE_EVENT_NAMES.length);
  });

  it("names only strings the contract registers", () => {
    for (const eventName of RUNTIME_NODE_PRESENCE_EVENT_NAMES) {
      expect(RUNTIME_NODE_EVENT_NAMES).toContain(eventName);
    }
  });
});

describe("the registered procedure name", () => {
  it("is the runtime-node namespace's separator-free method name", () => {
    // Spelled out once here, deliberately: this string is the whole coupling point
    // between the console and a control-plane router, and a test that read it back
    // off the constant it is asserting would check nothing.
    expect(RUNTIME_NODE_ROSTER_PROCEDURE).toBe("runtimenode.roster");
    // The `runtime_node.*` EVENT names use an underscore; the METHOD namespace does
    // not. Confusing the two is the mistake this pair of assertions catches.
    expect(RUNTIME_NODE_ROSTER_PROCEDURE).not.toContain("_");
  });
});

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

describe("every shipped roster frame", () => {
  it("is a reading the registered response schema accepts", () => {
    // What discharges the scenarios' `as NodeId` / `as ParticipantId` /
    // `as EventEnvelopeVersion` assertions. The schema is `.strict()`, so a member
    // the wire does not carry fails here as loudly as a malformed identifier.
    let framesChecked = 0;
    for (const scenario of CONSOLE_SCENARIOS) {
      for (const frame of scenario.runtimeNodeRoster ?? []) {
        expect(() =>
          RuntimeNodeRosterResponseSchema.parse({ nodes: [...frame.nodes] }),
        ).not.toThrow();
        framesChecked += 1;
      }
    }
    // The negative control: with no scenario carrying a roster this loop would pass
    // by never running.
    expect(framesChecked).toBeGreaterThan(0);
  });

  it("is rejected by that same schema once a member is invented", () => {
    const [frame] = SETTINGS_SCENARIO.runtimeNodeRoster ?? [];
    expect(frame).toBeDefined();
    expect(() =>
      RuntimeNodeRosterResponseSchema.parse({
        nodes: [...(frame?.nodes ?? [])],
        health: "green",
      }),
    ).toThrow();
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

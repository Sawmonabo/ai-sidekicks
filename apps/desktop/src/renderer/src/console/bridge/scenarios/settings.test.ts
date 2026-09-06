// What this scenario has to keep being, for the pages built on it.
//
// Two claims, and the second is the one an edit is most likely to break quietly.
// The first is that both node health stories are present at once, because a page
// that renders two independent health axes needs a moment where they disagree. The
// second is that this scenario scripts NOTHING for the settings reads the wire does
// not register — the pages below the rail are designed against the growth port's
// refusal, and a helpful-looking scripted row would make the fixture show a working
// surface nobody can reach.

import { describe, expect, it } from "vitest";

import { SETTINGS_SCENARIO } from "./settings.js";

/** Every node-state transition the script plays, in beat order. */
function nodeStateTransitions(): readonly { nodeId: string; newState: string }[] {
  return SETTINGS_SCENARIO.beats.flatMap((beat) => {
    const payload = beat.event.payload;
    if (payload === undefined) {
      return [];
    }
    const { nodeId, newState } = payload;
    return typeof nodeId === "string" && typeof newState === "string" ? [{ nodeId, newState }] : [];
  });
}

describe("the settings scenario", () => {
  it("brings one node up and lets another fall into the degraded band", () => {
    const transitions = nodeStateTransitions();
    const degraded = transitions.filter((transition) => transition.newState === "degraded");
    expect(degraded).toHaveLength(1);
    const online = transitions.filter((transition) => transition.newState === "online");
    expect(online).toHaveLength(2);
    // Two DIFFERENT machines, so the healthy reading and the degraded one are
    // simultaneously true. One node degrading after being the only node online is a
    // different story and does not exercise the two-axis rendering.
    expect(new Set(online.map((transition) => transition.nodeId)).size).toBe(2);
    const [onlyDegradedNode] = degraded;
    expect(onlyDegradedNode).toBeDefined();
    expect(online.map((transition) => transition.nodeId)).toContain(onlyDegradedNode?.nodeId);
  });

  it("never reports a node offline, which is not the band it models", () => {
    // `degraded` is reversible hysteresis and `offline` is a departure verdict.
    // Scripting the second would tell an operator a machine is gone when the point
    // of the scenario is that it is merely late.
    expect(nodeStateTransitions().some((transition) => transition.newState === "offline")).toBe(
      false,
    );
  });

  it("scripts nothing for the settings reads the wire does not register", () => {
    const scriptedCalls = SETTINGS_SCENARIO.replies.map((reply) => reply.call);
    // The whole scripted surface, stated by enumeration rather than by exclusion: a
    // reply added for an unregistered settings read fails here, which is the point.
    expect(scriptedCalls).toStrictEqual(["agent.list"]);
  });

  it("states a viewer the session actually joins", () => {
    const { viewingParticipantId, participantIdsInJoinOrder } = SETTINGS_SCENARIO;
    expect(viewingParticipantId).toBeDefined();
    expect(participantIdsInJoinOrder).toContain(viewingParticipantId);
  });

  it("reads a transition only from a payload that carries both members", () => {
    // The negative control for the fold above: a beat carrying a node id and no new
    // state is some other event that merely mentions a node, and counting it would
    // inflate every assertion in this file.
    expect(nodeStateTransitions().length).toBeLessThan(SETTINGS_SCENARIO.beats.length);
  });
});

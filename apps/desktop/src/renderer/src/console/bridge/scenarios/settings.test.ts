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

  it("scripts the roster and the three unbound planes, and nothing else", () => {
    const scriptedCalls = SETTINGS_SCENARIO.replies.map((reply) => reply.call);
    // The whole scripted surface, stated by enumeration rather than by exclusion: a
    // reply added for a settings read this scenario has not decided about fails here,
    // which is the point.
    //
    // Three planes are scripted, and each for the same reason: it is the whole content
    // of a settings surface, so every region of that page was otherwise reachable only
    // in its absence — the node's health, the provider-account registry with its
    // sign-in handoff and its per-limit quota, and the unified governance inventory
    // with the two mutations the operator page sends. Every OTHER settings read this
    // console makes stays unscripted on purpose: each of those pages renders the
    // growth port's refusal, which is exactly what the shipped build does.
    expect(scriptedCalls).toStrictEqual([
      "agent.list",
      // The one MUTATION on this deck, and the only reply here that is a control-plane
      // procedure rather than a daemon method: the nodes page mounts the shipped attach
      // flow against the declaration this scenario supplies, and a control whose click
      // reached an unscripted call would render the fixture's own authoring refusal in
      // place of the settled verdict a person is meant to review.
      "runtimenode.attach",
      "health.statusRead",
      "health.stuckRunInspect",
      "health.failureDetailRead",
      "health.recoveryActionRequest",
      "health.redactionPolicyRead",
      "providerAccount.list",
      "providerAccount.login",
      "providerAccount.loginCancel",
      "providerAccount.register",
      "mcp.list",
      "mcp.setEnabled",
      "mcp.setTrust",
    ]);
  });

  it("scripts the interesting arm of each diagnostics read, not the calm one", () => {
    // The claim that makes scripting them worth it. The unscripted fallbacks already
    // answer a healthy machine and the default retention posture, so a deck that
    // scripted those too would leave the degraded banner, the suspected stall, and the
    // override notice unreachable in the one place they are reviewed.
    const resultFor = (call: string): Record<string, unknown> => {
      const reply = SETTINGS_SCENARIO.replies.find((candidate) => candidate.call === call);
      return (reply?.result ?? {}) as Record<string, unknown>;
    };

    expect(resultFor("health.statusRead")["overall"]).toBe("degraded");
    expect(resultFor("health.stuckRunInspect")["healthSignal"]).toBe("stuck-suspected");
    expect(resultFor("health.redactionPolicyRead")["retentionPolicyOverrideActive"]).toBe(true);
  });

  it("addresses the stall and the recovery to one run, and the failure to another", () => {
    // The page asks two different questions of two different runs, because only a
    // moving run can have stalled and only a failed run has a failure to detail. The
    // stall and the recovery ARE one story about one run — the recovery is offered on
    // the run the inspection was about — and the failure is a second run entirely, so
    // a scenario naming one id for all three could reach only one of the two regions.
    const runIdFor = (call: string): string | undefined => {
      const reply = SETTINGS_SCENARIO.replies.find((candidate) => candidate.call === call);
      return (reply?.result as { runId?: string } | undefined)?.runId;
    };
    const stalledRunId = runIdFor("health.stuckRunInspect");

    expect(stalledRunId).toBeDefined();
    expect(runIdFor("health.recoveryActionRequest")).toBe(stalledRunId);
    expect(runIdFor("health.failureDetailRead")).not.toBe(stalledRunId);
  });

  it("gives the page a moving run and a failed one to address those reads to", () => {
    // The subjects are resolved from the session's own run partition, so a scenario
    // with no run reaches only the "nothing was asked" arm of both regions. The two
    // terminal states these beats settle on are what make both reachable.
    const finalStateByRunId = new Map<string, string>();
    for (const beat of SETTINGS_SCENARIO.beats) {
      const payload = beat.event.payload as { runId?: string; newState?: string };
      if (payload.runId !== undefined && payload.newState !== undefined) {
        finalStateByRunId.set(payload.runId, payload.newState);
      }
    }

    expect([...finalStateByRunId.values()].toSorted()).toStrictEqual(["failed", "running"]);
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

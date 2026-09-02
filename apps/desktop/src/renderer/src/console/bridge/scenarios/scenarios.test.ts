// What the browser and terminal scenarios promise the panes built against them.
//
// ONE FILE FOR TWO MODULES, DELIBERATELY. Both are scenario DATA in one directory,
// and every check below is the same check run against two scripts — wire truth,
// ordering, closed-vocabulary reachability. Splitting them would mean writing the
// registered-event-type oracle twice, and a helper written twice is the thing
// `apps/desktop/AGENTS.md` §Shared code names first. It stays here rather than
// moving to `test/console/<tier>/` because it needs no harness, no DOM, and no
// spawn: it reads two exported constants and a contracts map.
//
// THE ORACLE IS THE CONTRACTS PACKAGE, NOT A LIST IN THIS FILE. A scenario's whole
// value is that it is shape-identical to something real, so the strongest thing a
// test can say about one is that every event kind it scripts is a kind the wire
// registers. `SESSION_EVENT_CATEGORY_BY_TYPE` is the compiled `Spec-006` taxonomy,
// so a beat naming a plausible-but-unregistered type — `run.started`,
// `participant.joined` — fails here rather than at the first pane that subscribes.
// That is why the check lives beside the data and not beside a pane: a hand-copied
// allow-list is only ever as fresh as the last person who edited it.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RE-CHECK. `console/terminal/index.test.ts`
// already holds the terminal scenario to reaching all five `pty.control_changed`
// reasons and to the present-and-null holder member; repeating either here would be
// the second implementation `AGENTS.md` §Tests rejects. What is here is what nothing
// else covers.
//
// Every clean assertion below has a negative control that fails, because a
// predicate that accepted everything would satisfy the positive half of all of
// them.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "./browser.js";
import { TERMINAL_SCENARIO } from "./terminal.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";

/** Whether the wire registers this event type. */
function isRegisteredEventType(kind: string): boolean {
  return SESSION_EVENT_CATEGORY_BY_TYPE.has(kind as SessionEventType);
}

/** Every payload member value the beats of one kind carry under one member name. */
function payloadValuesOf(scenario: ConsoleScenario, kind: string, member: string): string[] {
  return scenario.beats
    .filter((beat) => beat.event.kind === kind)
    .map((beat) => beat.event.payload?.[member])
    .filter((value): value is string => typeof value === "string");
}

/** Numbered from one, and never moving backwards in time. */
function beatsInPlayableOrder(beats: readonly ScenarioBeat[]): boolean {
  return beats.every(
    (beat, index) =>
      beat.event.sequence === index + 1 &&
      (index === 0 || beat.atMs >= (beats[index - 1]?.atMs ?? 0)),
  );
}

const BOTH_SCENARIOS = [
  [BROWSER_SCENARIO.id, BROWSER_SCENARIO],
  [TERMINAL_SCENARIO.id, TERMINAL_SCENARIO],
] as const;

describe("scenario scripts stay wire-true", () => {
  it.each(BOTH_SCENARIOS)("%s scripts only registered Spec-006 event types", (_id, scenario) => {
    const unregistered = scenario.beats
      .map((beat) => beat.event.kind)
      .filter((kind) => !isRegisteredEventType(kind));
    expect(unregistered).toStrictEqual([]);
  });

  it("rejects the plausible names the taxonomy does not carry", () => {
    // The negative control, and not a hypothetical one: `run.started` and
    // `participant.joined` are both names a reader expects to exist and neither is
    // registered — the taxonomy spells them `run.starting` and `membership.created`.
    // Without this the check above would be vacuous over an oracle that said yes.
    expect(isRegisteredEventType("run.started")).toBe(false);
    expect(isRegisteredEventType("participant.joined")).toBe(false);
    expect(isRegisteredEventType("browser.page_opened")).toBe(false);
  });

  it.each(BOTH_SCENARIOS)(
    "%s numbers its beats from one and never moves backwards in time",
    (_id, scenario) => {
      expect(beatsInPlayableOrder(scenario.beats)).toBe(true);
    },
  );

  it("fails an out-of-order script", () => {
    expect(beatsInPlayableOrder([...TERMINAL_SCENARIO.beats].reverse())).toBe(false);
  });

  it.each(BOTH_SCENARIOS)(
    "%s scripts each call at most once, so no reply is silently dead",
    (_id, scenario) => {
      // `ScenarioEngine.replyFor` returns the FIRST match, so a second entry for one
      // call is unreachable data that reads like scripted behaviour.
      const calls = scenario.replies.map((reply) => reply.call);
      expect(calls).toHaveLength(new Set(calls).size);
    },
  );

  it("would catch a duplicated call", () => {
    const calls = [...TERMINAL_SCENARIO.replies, ...TERMINAL_SCENARIO.replies].map(
      (reply) => reply.call,
    );
    expect(calls.length).not.toBe(new Set(calls).size);
  });

  it.each(BOTH_SCENARIOS)(
    "%s delays at least one reply, so a loading state is reachable",
    (_id, scenario) => {
      // The frozen clock is the only clock, so a scripted latency is the fixture's
      // only loading state. A scenario whose every read answers instantly leaves its
      // surface's loading rendering unexercised.
      expect(scenario.replies.some((reply) => (reply.afterMs ?? 0) > 0)).toBe(true);
    },
  );

  it.each(BOTH_SCENARIOS)("%s still answers something instantly", (_id, scenario) => {
    // The control for the case above: if every reply were delayed, that assertion
    // would pass over a scenario with no settled opening frame at all, and the
    // predicate would be reading a constant rather than a decision.
    expect(scenario.replies.some((reply) => reply.afterMs === undefined)).toBe(true);
  });
});

describe("the browser scenario reaches every artifact state a row renders", () => {
  // `ArtifactState`, closed at three by
  // `docs/architecture/contracts/api-payload-contracts.md`. The pane renders a
  // different row for each — an ingest in flight, a settled object, a superseded
  // predecessor — so a scenario missing one leaves that row untested.
  const ARTIFACT_STATES = ["pending", "published", "superseded"] as const;

  const scriptedStates = [
    ...payloadValuesOf(BROWSER_SCENARIO, "artifact.published", "state"),
    ...payloadValuesOf(BROWSER_SCENARIO, "artifact.superseded", "state"),
  ];

  /** How many `artifact.published` beats name one artifact id. */
  function publishBeatCountFor(artifactId: string): number {
    return payloadValuesOf(BROWSER_SCENARIO, "artifact.published", "artifactId").filter(
      (id) => id === artifactId,
    ).length;
  }

  it("scripts all three", () => {
    for (const state of ARTIFACT_STATES) {
      expect(scriptedStates).toContain(state);
    }
  });

  it("would notice a state the script never reaches", () => {
    // The same array asked for a fourth value nothing mints. If it answered yes,
    // every case above would pass over a scenario that scripted nothing at all.
    expect(scriptedStates).not.toContain("reclaimed");
  });

  it("settles the in-flight capture onto its own row rather than a second one", () => {
    // The loading row and the settled row are one produced object, so the same id
    // is published twice — once `pending`, once `published`. A pane keying a new
    // row off the settling beat would show the capture twice, which is the failure
    // the shared id exists to prevent.
    const pendingCaptureId = BROWSER_SCENARIO.beats.find(
      (beat) => beat.event.payload?.["state"] === "pending",
    )?.event.payload?.["artifactId"];
    expect(pendingCaptureId).toBeTypeOf("string");
    expect(publishBeatCountFor(pendingCaptureId as string)).toBe(2);
  });

  it("would notice a settling beat that minted a second id", () => {
    // The same predicate over an artifact that genuinely lands once. If it also
    // answered two, the check above would pass for any id and prove nothing.
    expect(publishBeatCountFor("artifact-download-release-notes")).toBe(1);
  });
});

describe("the terminal scenario ends held, then loses its host", () => {
  /** Who holds the lease once these beats have played, or `null` for a free one. */
  function holderAfter(beats: readonly ScenarioBeat[]): unknown {
    return beats
      .filter((beat) => beat.event.kind === "pty.control_changed")
      .map((beat) => beat.event.payload?.["holderParticipantId"])
      .at(-1);
  }

  /**
   * The last lease transition the script plays.
   *
   * Found rather than named by sequence: the script grows beats when a transition
   * gains the acquisition it needed, and a hard-coded ordinal turns that into a
   * silently vacuous filter — the control below would then remove nothing and pass
   * against the very script it exists to reject.
   */
  function finalLeaseTransition(): ScenarioBeat {
    const transitions = TERMINAL_SCENARIO.beats.filter(
      (beat) => beat.event.kind === "pty.control_changed",
    );
    const newest = transitions.at(-1);
    if (newest === undefined) {
      throw new Error("the terminal scenario scripts no lease transition");
    }
    return newest;
  }

  /** The lease transitions scripted strictly after the first beat of this kind. */
  function transitionsAfter(kind: string): readonly ScenarioBeat[] {
    const index = TERMINAL_SCENARIO.beats.findIndex((beat) => beat.event.kind === kind);
    expect(index).toBeGreaterThan(-1);
    return TERMINAL_SCENARIO.beats
      .slice(index + 1)
      .filter((beat) => beat.event.kind === "pty.control_changed");
  }

  it("leaves the lease held at the last transition", () => {
    // The take the offline beat below degrades. It is the last transition, so a
    // script that ended on a plain release would drop the host under a lease nobody
    // held — and the degraded state, which is the frame `runToCompletion()` pins,
    // would have no holder to take away.
    expect(holderAfter(TERMINAL_SCENARIO.beats)).toBe(
      TERMINAL_SCENARIO.participantIdsInJoinOrder[0],
    );
  });

  it("would notice a script that ended free", () => {
    // The same function over the script with its final take removed — which is
    // exactly the mistake it exists to catch, and which a run of automatic releases
    // makes easy to leave behind.
    const withoutFinalTake = TERMINAL_SCENARIO.beats.filter(
      (beat) => beat !== finalLeaseTransition(),
    );
    expect(holderAfter(withoutFinalTake)).toBeNull();
  });

  it("drops the host after the final take and authors no transition for it", () => {
    // The degraded state arrives WITHOUT a `pty.control_changed`: the roster read
    // suppresses `controlHolder` while the producing node is offline and writes
    // nothing, so nothing transitioned and a read authors no events. A surface
    // deriving the unheld rendering from a transition would never reach it.
    expect(transitionsAfter("runtime_node.offline")).toStrictEqual([]);
  });

  it("would notice transitions after a beat that does have some", () => {
    // The same slice over the node coming ONLINE, which every lease transition
    // follows. An implementation that always answered empty would satisfy the check
    // above and say nothing.
    expect(transitionsAfter("runtime_node.online").length).toBeGreaterThan(0);
  });

  it("names one node across the presence beats and the roster reply", () => {
    // The degraded line names a node, and it has to be the node whose presence
    // dropped — telling a person to go look at the wrong machine is worse than
    // saying nothing.
    const presenceNodeIds = new Set([
      ...payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.online", "nodeId"),
      ...payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.offline", "nodeId"),
    ]);
    expect(presenceNodeIds.size).toBe(1);

    const rosterReply = TERMINAL_SCENARIO.replies.find(
      (reply) => reply.call === "runtimenode.roster",
    );
    expect(rosterReply).toBeDefined();
    const roster = rosterReply?.result as { nodes: { nodeId: string }[] } | undefined;
    expect(roster?.nodes.map((node) => node.nodeId)).toStrictEqual([...presenceNodeIds]);
  });

  it("would notice a roster naming a node no beat mentions", () => {
    const presenceNodeIds = new Set(
      payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.online", "nodeId"),
    );
    expect(presenceNodeIds.has("node-somewhere-else")).toBe(false);
  });
});

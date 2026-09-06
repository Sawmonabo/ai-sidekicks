// What the browser and terminal scenarios promise the panes built against them.
//
// ONE FILE FOR TWO MODULES, DELIBERATELY. Both are scenario DATA in one directory,
// and the claims below are the same claims run against two scripts. It stays here
// rather than moving to `test/console/<tier>/` because it needs no harness, no DOM,
// and no spawn: it reads two exported constants and their replies.
//
// WIRE TRUTH IS NOT HERE, AND DELIBERATELY SO. `bridge/scenarios/wire-truth.ts` is
// the one predicate every scenario on the seat board is measured through — the
// `Spec-006` census, the canonical envelope, the log position and tick each beat
// takes, one scripted answer per call, the memberships a scenario declares — and
// both scripts below sit on that board, so every one of those legs already runs
// against them. This file once carried its own census, its own ordering rule, and
// its own duplicate-call check. Each was a second implementation of a rule that
// module owns, which `apps/desktop/AGENTS.md` §Tests rejects, and the ordering copy
// was also the weaker one: it demanded a first beat at sequence 1, where the shipped
// rule demands the log position the fixture's own session read leaves off at.
//
// WHAT IS HERE IS WHAT NOTHING ELSE COVERS. The two reply timings a loading state
// and a settled opening frame need — `wire-truth/reply-walk.ts` holds a latency to
// being spendable, not to being present — the artifact states a row renders, and the
// lease the terminal script has to end on. `console/terminal/index.test.ts` already
// holds that scenario to reaching all five `pty.control_changed` reasons and to the
// present-and-null holder member; repeating either here would be the same second
// implementation.
//
// Every clean assertion below has a negative control that fails, because a
// predicate that accepted everything would satisfy the positive half of all of
// them.

import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "./browser.js";
import { TERMINAL_SCENARIO } from "./terminal.js";
import { TERMINAL_HOST_NODE_ID } from "./terminal-cast.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario-runtime/index.js";

/** Every payload member value the beats of one kind carry under one member name. */
function payloadValuesOf(scenario: ConsoleScenario, kind: string, member: string): string[] {
  return scenario.beats
    .filter((beat) => beat.event.kind === kind)
    .map((beat) => beat.event.payload?.[member])
    .filter((value): value is string => typeof value === "string");
}

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

  it("names one node across the presence beats, and it is the host", () => {
    // The degraded line names a node, and it has to be the node whose presence
    // dropped — telling a person to go look at the wrong machine is worse than
    // saying nothing. The family reads presence off the log, so the beats are the
    // only place the scenario names a node at all.
    const presenceNodeIds = new Set([
      ...payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.online", "nodeId"),
      ...payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.offline", "nodeId"),
    ]);
    expect([...presenceNodeIds]).toStrictEqual([TERMINAL_HOST_NODE_ID]);
  });

  it("would notice a presence beat naming a node the cast does not", () => {
    const presenceNodeIds = new Set(
      payloadValuesOf(TERMINAL_SCENARIO, "runtime_node.online", "nodeId"),
    );
    expect(presenceNodeIds.has("node-somewhere-else")).toBe(false);
  });
});

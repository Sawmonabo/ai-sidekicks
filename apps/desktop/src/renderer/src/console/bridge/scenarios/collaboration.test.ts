// What this scenario has to keep being, for the surfaces built on it.
//
// The wire-truth predicate already holds every beat to the census and the strict
// layer, and the architecture tier runs it over every shipped scenario — so nothing
// here re-checks that. What is checked is the DESIGN content that makes this
// scenario worth having: four presence states, an archived channel, and one
// invitation that is still pending. Each of those is a claim a surface was built
// against, and each would go silently false under an edit that still parsed.

import { describe, expect, it } from "vitest";

import { parseInstant } from "../../core/index.js";
import { PRESENCE_STATE_RENDER_ORDER } from "../../collaboration/members/presence-model.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import type { ScenarioReply, ScenarioResolvingReply } from "../scenario.js";

/** The resolving reply for one call, or a failure naming the call that is missing. */
function resolvingReplyFor(call: string): ScenarioResolvingReply {
  const reply: ScenarioReply | undefined = COLLABORATION_SCENARIO.replies.find(
    (candidate) => candidate.call === call,
  );
  expect(reply, `the scenario scripts no "${call}" reply`).toBeDefined();
  const resolving = reply as ScenarioResolvingReply;
  expect(resolving.result, `"${call}" refuses rather than resolving`).toBeDefined();
  return resolving;
}

describe("the collaboration scenario", () => {
  it("covers every presence state the roster renders", () => {
    const { participants } = resolvingReplyFor("presence.read").result as {
      participants: readonly { state: string }[];
    };
    const covered = new Set(participants.map((participant) => participant.state));
    expect([...covered].sort()).toStrictEqual([...PRESENCE_STATE_RENDER_ORDER].sort());
  });

  it("names a viewer the session actually joins", () => {
    const { viewingParticipantId, participantIdsInJoinOrder } = COLLABORATION_SCENARIO;
    expect(viewingParticipantId).toBeDefined();
    expect(participantIdsInJoinOrder).toContain(viewingParticipantId);
  });

  it("serves an archived channel beside the live ones", () => {
    const { channels } = resolvingReplyFor("channel.list").result as {
      channels: readonly { state: string }[];
    };
    expect(channels.some((channel) => channel.state === "archived")).toBe(true);
    expect(channels.some((channel) => channel.state !== "archived")).toBe(true);
  });

  it("serves one pending invitation with an expiry", () => {
    const invites = resolvingReplyFor("invite.list").result as readonly {
      state: string;
      expiresAt: string;
    }[];
    const pending = invites.filter((invite) => invite.state === "pending");
    expect(pending).toHaveLength(1);
    const [onlyPendingInvite] = pending;
    expect(onlyPendingInvite).toBeDefined();
    // Through the console's own reader rather than a `NaN` check: that check passes
    // for a day that does not exist, which normalizes into the next one instead of
    // refusing, so it never asserted what this line claims.
    expect(parseInstant(onlyPendingInvite?.expiresAt ?? "").kind).toBe("instant");
  });

  it("scripts no reply for a call it does not make", () => {
    // The negative control for every assertion above: `resolvingReplyFor` reports a
    // missing call rather than returning a reply that happens to be `undefined`, so
    // a scenario that quietly lost `presence.read` would fail those tests instead of
    // vacuously passing them.
    expect(() => resolvingReplyFor("presence.detail")).toThrow();
  });
});

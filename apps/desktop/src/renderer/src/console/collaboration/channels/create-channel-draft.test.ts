// What the create form holds, and the one request it composes from it.
//
// Driven directly rather than through the rendered form, because what this decides is
// what goes ON THE WIRE: which members an untouched field contributes, which arm
// carries a policy at all, and what order a pair is sent in. A component test can see
// a control; only this can see the request.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ChannelCreateRequest } from "./channel-writes.js";
import { CreateChannelDraft, canonicalMemberPair } from "./create-channel-draft.js";
import { PARTICIPANT_OTHER, PARTICIPANT_YOU, SESSION_ID } from "./channels.test-support.js";

/** The request this draft composes, or a failure naming what it is still missing. */
function requestOf(draft: CreateChannelDraft, viewerParticipantId?: string): ChannelCreateRequest {
  const readiness = draft.readiness(SESSION_ID, viewerParticipantId ?? PARTICIPANT_YOU);
  if (readiness.status !== "ready") {
    throw new Error(`the draft is still missing: ${readiness.missing.join(", ")}`);
  }
  return readiness.request;
}

/** What the draft says it is still waiting on. */
function missingFrom(draft: CreateChannelDraft, viewerParticipantId?: string): readonly string[] {
  const readiness = draft.readiness(SESSION_ID, viewerParticipantId);
  return readiness.status === "incomplete" ? readiness.missing : [];
}

/** A named general draft, which is the shortest thing that composes a request. */
function namedDraft(name = "review"): CreateChannelDraft {
  const draft = new CreateChannelDraft();
  draft.setName(name);
  return draft;
}

describe("create channel draft — where the form opens", () => {
  it("opens on a general channel whose audience is participants", () => {
    const draft = new CreateChannelDraft();
    expect(draft.kind).toBe("general");
    expect(draft.audience).toBe("participants");
  });

  it("opens holding nothing else at all", () => {
    // Every other member is the SESSION's default, which is what an absent member on
    // this wire means — a console that pre-picked one would be choosing on a person's
    // behalf and reporting it as their choice.
    const draft = new CreateChannelDraft();
    expect(draft.turnPolicy).toBeUndefined();
    expect(draft.roundRobinOrder).toBe("");
    expect(draft.turnsPerAgent).toBe("");
    expect(draft.moderationValue("preTurnGate")).toBeUndefined();
    expect(draft.moderationValue("postTurnReview")).toBeUndefined();
    expect(draft.otherParticipantId).toBeUndefined();
  });

  it("composes nothing until it has a name", () => {
    expect(missingFrom(new CreateChannelDraft(), PARTICIPANT_YOU)).toContain("a name");
  });
});

describe("create channel draft — the reserved bootstrap name", () => {
  it("refuses the session's own channel name against the name field", () => {
    const readiness = namedDraft(MAIN_CHANNEL_NAME).readiness(SESSION_ID, PARTICIPANT_YOU);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.nameRefusal : "").toContain(
      MAIN_CHANNEL_NAME,
    );
  });

  it("refuses it around the whitespace a person types with it", () => {
    expect(
      namedDraft(`  ${MAIN_CHANNEL_NAME}  `).readiness(SESSION_ID, PARTICIPANT_YOU).status,
    ).toBe("incomplete");
  });

  it("negative control: any other name composes a request", () => {
    // Without this, the two cases above would pass over a draft that refused every
    // name it was given.
    expect(requestOf(namedDraft(`${MAIN_CHANNEL_NAME}-thread`)).name).toBe(
      `${MAIN_CHANNEL_NAME}-thread`,
    );
  });
});

describe("create channel draft — what a general channel sends", () => {
  it("sends the audience the form holds and no member nobody touched", () => {
    const request = requestOf(namedDraft());
    expect(request.kind).toBe("general");
    expect(request.config).toStrictEqual({ audience: "participants" });
    expect(request.memberPair).toBeUndefined();
  });

  it("sends a moderation member a person unchecked, rather than dropping it", () => {
    // A person who unchecked a box has SAID something. A form that could not send
    // `false` would silently leave the session's own gate on.
    const draft = namedDraft();
    draft.setModeration("preTurnGate", false);
    expect(requestOf(draft).config?.moderation).toStrictEqual({ preTurnGate: false });
  });

  it("sends no moderation at all where neither box was touched", () => {
    expect(requestOf(namedDraft()).config?.moderation).toBeUndefined();
  });

  it("sends the round-robin order as a list, dropping what a person typed around it", () => {
    const draft = namedDraft();
    draft.setRoundRobinOrder(" reviewer , , builder ");
    expect(requestOf(draft).config?.roundRobinOrder).toStrictEqual(["reviewer", "builder"]);
  });

  it("sends no per-agent cap where the field is empty", () => {
    expect(requestOf(namedDraft()).config?.turnsPerAgent).toBeUndefined();
  });

  it("composes nothing while the per-agent cap is a value it cannot read", () => {
    // Not the same fact as an empty field: this is something a person meant, and
    // sending the session's default for it would discard what they asked for.
    const draft = namedDraft();
    draft.setTurnsPerAgent("two");
    expect(missingFrom(draft, PARTICIPANT_YOU).join(" ")).toContain("whole number");
  });

  it("sends the cap a person did type", () => {
    const draft = namedDraft();
    draft.setTurnsPerAgent("3");
    expect(requestOf(draft).config?.turnsPerAgent).toBe(3);
  });

  it("sends no configuration at all where every member was cleared", () => {
    const draft = namedDraft();
    draft.setAudience(undefined);
    expect(requestOf(draft).config).toBeUndefined();
  });
});

describe("create channel draft — what a direct channel sends", () => {
  function directDraft(otherParticipantId: string): CreateChannelDraft {
    const draft = namedDraft("with Dana");
    draft.setKind("direct");
    draft.setOtherParticipantId(otherParticipantId);
    return draft;
  }

  it("sends the pair and no policy whatsoever", () => {
    const request = requestOf(directDraft(PARTICIPANT_OTHER));
    expect(request.kind).toBe("direct");
    expect(request.memberPair).toStrictEqual([PARTICIPANT_OTHER, PARTICIPANT_YOU]);
    expect(request.config).toBeUndefined();
  });

  it("sends no policy even where the general arm's fields were filled in first", () => {
    // The rule that makes the absent fields honest: the wire couples the kind to the
    // pair, so a direct request carrying an audience is one the daemon has to reject.
    // The entries are LEFT STANDING in the draft — a person who tries `direct` and
    // comes back finds their turn policy — and simply never composed.
    const draft = directDraft(PARTICIPANT_OTHER);
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder("reviewer");
    draft.setModeration("postTurnReview", true);
    draft.setTurnsPerAgent("2");

    expect(requestOf(draft).config).toBeUndefined();
    expect(draft.turnPolicy).toBe("round-robin");
  });

  it("sends one pair however it was picked", () => {
    // The same two people, with the roles of picker and picked swapped. Unsorted, the
    // second of these would send `[you, other]` and read as a second channel.
    const picked = requestOf(directDraft(PARTICIPANT_OTHER), PARTICIPANT_YOU);
    const pickedTheOtherWay = requestOf(directDraft(PARTICIPANT_YOU), PARTICIPANT_OTHER);
    expect(picked.memberPair).toStrictEqual(pickedTheOtherWay.memberPair);
  });

  it("orders any two ids the same way whichever position they arrive in", () => {
    expect(canonicalMemberPair(PARTICIPANT_YOU, PARTICIPANT_OTHER)).toStrictEqual([
      PARTICIPANT_OTHER,
      PARTICIPANT_YOU,
    ]);
    expect(canonicalMemberPair(PARTICIPANT_OTHER, PARTICIPANT_YOU)).toStrictEqual([
      PARTICIPANT_OTHER,
      PARTICIPANT_YOU,
    ]);
  });

  it("composes nothing until somebody is picked", () => {
    const draft = namedDraft("with nobody");
    draft.setKind("direct");
    expect(missingFrom(draft, PARTICIPANT_YOU)).toContain("the other person in the pair");
  });

  it("composes nothing while this window's own participant is unread", () => {
    // Fail-closed: a pair composed from a caller identity nobody established would put
    // two people in a room neither of them chose.
    expect(missingFrom(directDraft(PARTICIPANT_OTHER), undefined)).toContain(
      "which participant this window is",
    );
  });
});

describe("create channel draft — what Cancel does", () => {
  it("puts every field back where the form opened", () => {
    const draft = namedDraft();
    draft.setKind("direct");
    draft.setOtherParticipantId(PARTICIPANT_OTHER);
    draft.setAudience("humans-only");
    draft.setTurnPolicy("moderated");
    draft.setRoundRobinOrder("reviewer");
    draft.setTurnsPerAgent("4");
    draft.setModeration("preTurnGate", true);

    draft.reset();

    expect(draft.name).toBe("");
    expect(draft.kind).toBe("general");
    expect(draft.audience).toBe("participants");
    expect(draft.turnPolicy).toBeUndefined();
    expect(draft.roundRobinOrder).toBe("");
    expect(draft.turnsPerAgent).toBe("");
    expect(draft.moderationValue("preTurnGate")).toBeUndefined();
    expect(draft.otherParticipantId).toBeUndefined();
  });

  it("tells its readers that something changed", () => {
    const draft = namedDraft();
    let changeCount = 0;
    draft.onChange(() => {
      changeCount += 1;
    });

    draft.setName("relay");
    draft.reset();

    expect(changeCount).toBe(2);
  });
});

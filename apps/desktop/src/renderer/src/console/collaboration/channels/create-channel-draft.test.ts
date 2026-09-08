// What the create form holds, and the one request it composes from it.
//
// Driven directly rather than through the rendered form, because what this decides is
// what goes ON THE WIRE: which members an untouched field contributes, which arm
// carries a policy at all, and what order a pair is sent in. A component test can see
// a control; only this can see the request.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CreateChannelDraft } from "./create-channel-draft.js";
import { canonicalMemberPair } from "./create-channel-pair.js";
import { PARTICIPANT_OTHER, PARTICIPANT_YOU } from "./channels.test-support.js";
import {
  contextWith,
  missingFrom,
  namedDraft,
  requestOf,
} from "./create-channel-draft.test-support.js";

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
    const readiness = namedDraft(MAIN_CHANNEL_NAME).readiness(contextWith(PARTICIPANT_YOU));
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.nameRefusal : "").toContain(
      MAIN_CHANNEL_NAME,
    );
  });

  it("refuses it around the whitespace a person types with it", () => {
    expect(
      namedDraft(`  ${MAIN_CHANNEL_NAME}  `).readiness(contextWith(PARTICIPANT_YOU)).status,
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

describe("create channel draft — the per-agent cap a number can actually hold", () => {
  /** The largest whole number JavaScript represents exactly, as a person would type it. */
  const LARGEST_EXACT_CAP = String(Number.MAX_SAFE_INTEGER);

  /** One past it: still every character a digit, and no longer the value it spells. */
  const FIRST_INEXACT_CAP = "9007199254740993";

  /** Long enough that no number holds it at all — `Number` answers `Infinity`. */
  const CAP_NO_NUMBER_HOLDS = "1".repeat(400);

  it("composes nothing for a cap past the range a number holds exactly", () => {
    // A digit string is not the same fact as a number: past the safe-integer range
    // `Number` answers the nearest value it can represent, so a form that accepted
    // this would send a cap the person did not type and report it as their choice.
    const draft = namedDraft();
    draft.setTurnsPerAgent(FIRST_INEXACT_CAP);
    expect(missingFrom(draft, PARTICIPANT_YOU).join(" ")).toContain("whole number");
  });

  it("composes nothing for a digit string no number holds at all", () => {
    // The other end of the same defect, and the one the wire cannot even carry:
    // `Number` answers `Infinity`, which JSON has no form for.
    const draft = namedDraft();
    draft.setTurnsPerAgent(CAP_NO_NUMBER_HOLDS);
    expect(missingFrom(draft, PARTICIPANT_YOU).join(" ")).toContain("whole number");
  });

  it("negative control: the largest exactly-held cap still composes", () => {
    // Without this the two cases above would pass over a draft that refused every cap
    // of more than a few digits, which would be a rule about length rather than about
    // what a number can carry.
    const draft = namedDraft();
    draft.setTurnsPerAgent(LARGEST_EXACT_CAP);
    expect(requestOf(draft).config?.turnsPerAgent).toBe(Number.MAX_SAFE_INTEGER);
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

  it("composes nothing once the person picked is no longer in this session", () => {
    // The defect: a membership ends without asking the form. The candidate list stopped
    // offering them, the draft went on holding their id, and readiness only checked that
    // it held SOME id — so Create stayed open on a pair the daemon would have to refuse,
    // and the person met that refusal after the press.
    const departed = missingFrom(directDraft(PARTICIPANT_OTHER), PARTICIPANT_YOU, [
      PARTICIPANT_YOU,
    ]);

    expect(departed.join(" ")).toContain("no longer");
    // A DIFFERENT sentence from the unpicked one, because they are different facts: one
    // is about nobody and this one is about somebody the person did choose.
    expect(departed).not.toContain("the other person in the pair");
  });

  it("composes nothing where the pick is the viewer's own participant", () => {
    // The wire requires two DISTINCT humans, and the picker subtracts the viewer — so a
    // draft holding the reader's own id is one the candidate rule already refuses, with
    // no second predicate to keep in step with it.
    expect(missingFrom(directDraft(PARTICIPANT_YOU), PARTICIPANT_YOU).join(" ")).toContain(
      "no longer",
    );
  });

  it("negative control: the same pick composes while that person is still here", () => {
    // Without this the two cases above would pass over a draft that refused every pick
    // whatever the session held, which would be a rule about direct channels rather
    // than one about membership.
    expect(requestOf(directDraft(PARTICIPANT_OTHER)).memberPair).toStrictEqual([
      PARTICIPANT_OTHER,
      PARTICIPANT_YOU,
    ]);
  });
});

describe("create channel draft — what Cancel does", () => {
  it("puts every field back where the form opened", () => {
    const draft = namedDraft();
    draft.setKind("direct");
    draft.setOtherParticipantId(PARTICIPANT_OTHER);
    draft.setAudience("humans-only");
    draft.setTurnPolicy("request-based");
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

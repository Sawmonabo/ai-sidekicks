// What the create form holds, and the one request it composes from it.
//
// Driven directly rather than through the rendered form, because what this decides is
// what goes ON THE WIRE: which members an untouched field contributes, and which it
// leaves out. A component test can see a control; only this can see the request.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CreateChannelDraft } from "./create-channel-draft.js";
import { SESSION_ID } from "./channels.test-support.js";
import { missingFrom, namedDraft, requestOf } from "./create-channel-draft.test-support.js";

describe("create channel draft — where the form opens", () => {
  it("opens with the audience on users", () => {
    expect(new CreateChannelDraft().audience).toBe("users");
  });

  it("opens holding nothing else at all", () => {
    // Every other member is the SESSION's default, which is what an absent member on
    // this wire means — a console that pre-picked one would be choosing on a person's
    // behalf and reporting it as their choice.
    const draft = new CreateChannelDraft();
    expect(draft.turnsPerAgent).toBe("");
    expect(draft.moderationValue("preTurnGate")).toBeUndefined();
    expect(draft.moderationValue("postTurnReview")).toBeUndefined();
  });

  it("composes nothing until it has a name", () => {
    expect(missingFrom(new CreateChannelDraft())).toContain("a name");
  });

  it("composes nothing while it is addressed at no session", () => {
    expect(namedDraft().readiness(undefined).status).toBe("incomplete");
  });
});

describe("create channel draft — the reserved bootstrap name", () => {
  it("refuses the session's own channel name against the name field", () => {
    const readiness = namedDraft(MAIN_CHANNEL_NAME).readiness(SESSION_ID);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.nameRefusal : "").toContain(
      MAIN_CHANNEL_NAME,
    );
  });

  it("refuses it around the whitespace a person types with it", () => {
    expect(namedDraft(`  ${MAIN_CHANNEL_NAME}  `).readiness(SESSION_ID).status).toBe("incomplete");
  });

  it("negative control: any other name composes a request", () => {
    // Without this, the two cases above would pass over a draft that refused every
    // name it was given.
    expect(requestOf(namedDraft(`${MAIN_CHANNEL_NAME}-thread`)).name).toBe(
      `${MAIN_CHANNEL_NAME}-thread`,
    );
  });
});

describe("create channel draft — what a channel sends", () => {
  it("sends the audience the form holds and no member nobody touched", () => {
    expect(requestOf(namedDraft()).config).toStrictEqual({ audience: "users" });
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
    expect(missingFrom(draft).join(" ")).toContain("whole number");
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
    expect(missingFrom(draft).join(" ")).toContain("whole number");
  });

  it("composes nothing for a digit string no number holds at all", () => {
    // The other end of the same defect, and the one the wire cannot even carry:
    // `Number` answers `Infinity`, which JSON has no form for.
    const draft = namedDraft();
    draft.setTurnsPerAgent(CAP_NO_NUMBER_HOLDS);
    expect(missingFrom(draft).join(" ")).toContain("whole number");
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

describe("create channel draft — what Cancel does", () => {
  it("puts every field back where the form opened", () => {
    const draft = namedDraft();
    draft.setAudience("humans-only");
    draft.setTurnsPerAgent("4");
    draft.setModeration("preTurnGate", true);

    draft.reset();

    expect(draft.name).toBe("");
    expect(draft.audience).toBe("users");
    expect(draft.turnsPerAgent).toBe("");
    expect(draft.moderationValue("preTurnGate")).toBeUndefined();
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

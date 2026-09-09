// The composition the screenshot tier pins, asserted element by element.
//
// `Spec-023 §Console Test Tiers` puts the flagship frame at its frozen tick on that
// tier, and a reference image cannot say WHY it is the right frame: a capture of a
// session missing half its story is a perfectly stable image that compares green
// forever. So the elements are named here, in the file that owns the script, and the
// image pins how they look rather than whether they are there.
//
// EVERY CASE READS THE SCRIPT AND NOT A CONSTANT. The scenario is data, and a test
// that restated the beats it expects would pass over a script that had lost them.
//
// The wire-truth predicate is asserted elsewhere and is not repeated here: whether a
// beat is a shape a daemon can emit is `wire-truth.*.test.ts`'s question, and whether
// the session tells the whole story is this one's.

import { describe, expect, it } from "vitest";

import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";

/** Every kind the flagship plays, in script order. */
const SCRIPTED_KINDS: readonly string[] = FLAGSHIP_SCENARIO.beats.map((beat) => beat.event.kind);

/** The payloads of every beat of one kind. */
function payloadsOfKind(kind: string): readonly Readonly<Record<string, unknown>>[] {
  return FLAGSHIP_SCENARIO.beats
    .filter((beat) => beat.event.kind === kind)
    .map((beat) => (beat.event.payload ?? {}) as Readonly<Record<string, unknown>>);
}

/**
 * The census, widened to string keys so an unregistered name can be ASKED about.
 *
 * The map is keyed by `SessionEventType`, so the absence below is a compile error
 * before it is a runtime one — which is the strongest form of the claim and also the
 * reason it cannot be written directly: a name outside the union is not a key the
 * type admits. The widening asks the question at runtime instead, so the case fails
 * loudly on the day the union gains the type rather than silently compiling.
 */
const CENSUS_BY_NAME: ReadonlyMap<string, unknown> = SESSION_EVENT_CATEGORY_BY_TYPE;

/** The scripted answer to one call, or `undefined`. */
function replyTo(call: string): unknown {
  return FLAGSHIP_SCENARIO.replies.find((reply) => reply.call === call)?.result;
}

describe("the flagship frame — the approval it asks and grants", () => {
  it("carries the approval pair and the run pair, both", () => {
    // Four beats about one moment, and neither pair is derivable from the other: a
    // run can block on an ask nobody answers, and the card renders from the approval
    // rows alone. A session with only the run pair leaves the approvals surface with
    // nothing to draw, which is what this scenario used to ship.
    expect(SCRIPTED_KINDS).toContain("approval.requested");
    expect(SCRIPTED_KINDS).toContain("approval.approved");
    expect(SCRIPTED_KINDS).toContain("run.waiting_for_approval");
  });

  it("asks and grants the SAME request, and says who did each", () => {
    // Two ids would be two approvals — one never answered, one answered without
    // having been asked — and the card would render a request that stays pending
    // forever beside a grant for nothing.
    const [requested] = payloadsOfKind("approval.requested");
    const [approved] = payloadsOfKind("approval.approved");

    expect(requested?.["approvalRequestId"]).toBe(approved?.["approvalRequestId"]);
    expect(requested?.["requestedBy"]).toBeDefined();
    expect(requested?.["resourceDescriptor"]).toBeDefined();
    expect(approved?.["approver"]).toBeDefined();
  });

  it("grants it after it is asked, and releases the run after that", () => {
    const positionOf = (kind: string): number => SCRIPTED_KINDS.indexOf(kind);

    expect(positionOf("approval.requested")).toBeLessThan(positionOf("run.waiting_for_approval"));
    expect(positionOf("run.waiting_for_approval")).toBeLessThan(positionOf("approval.approved"));
  });
});

describe("the flagship frame — the park, counting down", () => {
  it("parks a lane on a quota reading that names when it resets", () => {
    // The countdown a person reads is `resetsAt`, and it is the only member on either
    // beat that names a future instant — the run row carries no park members at all,
    // so a script that suspended a run without the reading would park a lane with
    // nothing to count down to.
    const [reading] = payloadsOfKind("usage.rate_limit_update");

    expect(reading?.["resetsAt"]).toBeDefined();
    expect(reading?.["usedPercent"]).toBe(100);
    expect(SCRIPTED_KINDS).toContain("run.paused");
  });

  it("keeps the quota reading on the account plane, with no run on it", () => {
    // The registered payload carries no `runId` — quota is account-scoped and has no
    // run to join through — so a scenario that put one there would teach a meter to
    // read a shape no daemon sends.
    const [reading] = payloadsOfKind("usage.rate_limit_update");

    expect(reading?.["runId"]).toBeUndefined();
    expect(reading?.["providerAccountId"]).toBeDefined();
  });

  it("negative control: the park does not stop the session", () => {
    // One lane of four. A park that ended the session would be a different frame —
    // and a still one, which is the opposite of what this composition is for.
    const parkPosition = SCRIPTED_KINDS.indexOf("run.paused");

    expect(SCRIPTED_KINDS.slice(parkPosition + 1).length).toBeGreaterThan(0);
  });
});

describe("the flagship frame — the cast and the receipt", () => {
  it("seats at least five participants, so the bar has a cast to show", () => {
    expect(FLAGSHIP_SCENARIO.participantIdsInJoinOrder.length).toBeGreaterThanOrEqual(5);
  });

  it("answers the accountant, so the bar's figure is the receipt's own", () => {
    // The past-tense receipt. Without this reply the all-clear line renders the
    // "not checked" absence, which is honest and is not the frame this pins.
    const budget = replyTo("orchestration.budgetRead") as Record<string, unknown> | undefined;

    expect(budget?.["committedSpendCents"]).toBeGreaterThan(0);
    expect(budget?.["costStatus"]).toBe("priced");
  });

  it("names itself, so the identity is more than an id", () => {
    const read = replyTo("session.read") as { session?: { metadata?: { title?: string } } };

    expect(read.session?.metadata?.title).toBeDefined();
  });
});

describe("the flagship frame — what it deliberately cannot show", () => {
  it("plays no provider switch, because this workspace registers none", () => {
    // The one element of the designed composition that is absent, and it is absent
    // for a reason a reader can check rather than by omission: the census does not
    // carry the type, so a beat for it would be a frame of a wire that does not
    // exist. The day the census gains it, this case fails and the script gains a beat.
    expect(CENSUS_BY_NAME.has("agent.provider_switched")).toBe(false);
    expect(SCRIPTED_KINDS).not.toContain("agent.provider_switched");
  });

  it("negative control: the census this reads is one that carries the kinds it plays", () => {
    // Without this the case above would pass over an empty object, or over a census
    // read from the wrong module — and every absence in this file would be vacuous.
    expect(CENSUS_BY_NAME.has("approval.requested")).toBe(true);
    expect(CENSUS_BY_NAME.has("usage.rate_limit_update")).toBe(true);
    expect(CENSUS_BY_NAME.has("run.paused")).toBe(true);
  });
});

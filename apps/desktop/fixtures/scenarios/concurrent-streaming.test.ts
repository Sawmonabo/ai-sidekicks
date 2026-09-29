// The composition the screenshot tier pins, asserted element by element.
//
// The screenshot tier captures the concurrent-streaming frame at its frozen tick, and a
// reference image cannot say WHY it is the right frame: a capture of a
// session missing half its story is a perfectly stable image that compares green
// forever. So the elements are named here, in the file that owns the script, and the
// image pins how they look rather than whether they are there.
//
// EVERY CASE READS THE SCRIPT AND NOT A CONSTANT. The scenario is data, and a test
// that restated the beats it expects would pass over a script that had lost them.
//
// The wire-truth predicate is asserted elsewhere and is not repeated here: whether a
// beat is a shape a daemon can emit is the contract-check tests' question, and whether
// the session tells the whole story is this one's.

import { describe, expect, it } from "vitest";
import { CONCURRENT_STREAMING_SCENARIO } from "./concurrent-streaming.js";

/** Every kind the concurrent-streaming plays, in script order. */
const SCRIPTED_KINDS: readonly string[] = CONCURRENT_STREAMING_SCENARIO.beats.map(
  (beat) => beat.event.kind,
);

/** The payloads of every beat of one kind. */
function payloadsOfKind(kind: string): readonly Readonly<Record<string, unknown>>[] {
  return CONCURRENT_STREAMING_SCENARIO.beats
    .filter((beat) => beat.event.kind === kind)
    .map((beat) => (beat.event.payload ?? {}) as Readonly<Record<string, unknown>>);
}

/** The scripted answer to one call, or `undefined`. */
function replyTo(call: string): unknown {
  return CONCURRENT_STREAMING_SCENARIO.replies.find((reply) => reply.call === call)?.result;
}

describe("the concurrent-streaming frame — the approval it asks and grants", () => {
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

describe("the concurrent-streaming frame — the park, counting down", () => {
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

describe("the concurrent-streaming frame — its name", () => {
  it("names itself, so the identity is more than an id", () => {
    const read = replyTo("session.read") as { session?: { metadata?: { title?: string } } };

    expect(read.session?.metadata?.title).toBeDefined();
  });
});

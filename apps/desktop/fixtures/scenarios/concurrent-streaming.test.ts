// The composition the screenshot tier pins, asserted element by element.
//
// A reference image cannot say why it is the right frame: a capture of a session missing half
// its story compares green forever. So the elements are named here and the image pins how
// they look. Every case reads the script, not a restated constant. Whether a beat is a shape a
// daemon can emit is the contract-check tests' question.

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

describe("the concurrent-streaming frame — the approval it asks and grants", () => {
  it("carries the approval pair and the run pair, both", () => {
    // Neither pair is derivable from the other: a run can block on an ask nobody answers,
    // and the card renders from the approval rows alone.
    expect(SCRIPTED_KINDS).toContain("approval.requested");
    expect(SCRIPTED_KINDS).toContain("approval.approved");
    expect(SCRIPTED_KINDS).toContain("run.waiting_for_approval");
  });

  it("asks and grants the SAME request, and says who did each", () => {
    // Two ids would be two approvals: a request pending forever beside a grant for nothing.
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
    // The countdown comes from `resetsAt`, and the run row carries no park members, so a pause
    // without the reading would park a lane with nothing to count down to.
    const [reading] = payloadsOfKind("usage.rate_limit_update");

    expect(reading?.["resetsAt"]).toBeDefined();
    expect(reading?.["usedPercent"]).toBe(100);
    expect(SCRIPTED_KINDS).toContain("run.paused");
  });

  it("keeps the quota reading on the account plane, with no run on it", () => {
    // Quota is account-scoped, so the registered payload carries no `runId`.
    const [reading] = payloadsOfKind("usage.rate_limit_update");

    expect(reading?.["runId"]).toBeUndefined();
    expect(reading?.["providerAccountId"]).toBeDefined();
  });

  it("negative control: the park does not stop the session", () => {
    // One lane of four parks; a park that ended the session would be a still frame.
    const parkPosition = SCRIPTED_KINDS.indexOf("run.paused");

    expect(SCRIPTED_KINDS.slice(parkPosition + 1).length).toBeGreaterThan(0);
  });
});

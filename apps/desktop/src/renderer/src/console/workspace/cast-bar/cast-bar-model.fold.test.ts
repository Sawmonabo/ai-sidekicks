// What the BAR is, as a whole: which chips it draws, what it folds past the cap, and
// when it is allowed to say nothing needs anybody.
//
// Beside `cast-bar-model.test.ts` rather than inside it, because the two suites answer
// two questions about one derivation. That file is about the VOCABULARY and one chip —
// every verb and label key checked against the contracts census, and the sentence a
// screen reader hears for a member. This one is about the roster and the line: the
// wheel's order, the fold to "+N", and the three conjuncts the all-clear stands on.
//
// The all-clear's third conjunct is the one that reaches outside the log. The bar draws
// an amber mark this fold cannot see — the node's health — so the verdict is an input
// here rather than a second derivation in the component, and the cases below are what
// says the strip can no longer contradict itself.

import { describe, expect, it } from "vitest";

import { deriveCastBar } from "./cast-bar-model.js";
import { castEvent, wheelFor, withRun } from "./cast-bar-model.test-support.js";

describe("deriveCastBar — one chip per participant, in join-log order", () => {
  it("keeps the wheel's order and never reorders by activity", () => {
    const wheel = wheelFor(["participant-you", "participant-priya", "agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [castEvent(1, "agent-architect", "run.running")],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members.map((member) => member.participantId)).toStrictEqual([
      "participant-you",
      "participant-priya",
      "agent-architect",
    ]);
  });

  it("takes the verb from the participant's NEWEST row", () => {
    const wheel = wheelFor(["agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        castEvent(1, "agent-architect", "run.queued"),
        castEvent(2, "agent-architect", "tool.invoked"),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.verb).toBe("running a tool");
  });

  it("invents no verb for a participant with no row, and none for an unmapped kind", () => {
    const wheel = wheelFor(["participant-you", "agent-scout"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [castEvent(1, "agent-scout", "run.completed")],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.verb).toBeUndefined();
    expect(model.members[1]?.verb).toBeUndefined();
    expect(model.members[1]?.newestEventKind).toBe("run.completed");
  });

  it("negative control: a mapped kind DOES produce a verb", () => {
    // Without this, the case above would pass over a derivation that never produced
    // a verb at all.
    const wheel = wheelFor(["agent-scout"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [castEvent(1, "agent-scout", "run.running")],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.verb).toBe("working");
  });
});

describe("deriveCastBar — the fold and the all-clear line", () => {
  it("shows the cap and folds the rest into a count", () => {
    const wheel = wheelFor(
      Array.from({ length: 11 }, (_unused, index) => `participant-${String(index)}`),
    );
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members).toHaveLength(8);
    expect(model.foldedMemberCount).toBe(3);
  });

  it("says nothing needs you only when nothing does", () => {
    const wheel = wheelFor(["participant-you", "agent-architect"]);
    expect(
      deriveCastBar({
        assignments: wheel.assignments(),
        timeline: [castEvent(1, "agent-architect", "run.running")],
        isDegraded: false,
        isNodeUnwell: false,
        chipCap: 8,
      }).isAllClear,
    ).toBe(true);

    expect(
      deriveCastBar({
        assignments: wheel.assignments(),
        timeline: [castEvent(1, "agent-architect", "run.waiting_for_approval")],
        isDegraded: false,
        isNodeUnwell: false,
        chipCap: 8,
      }).isAllClear,
    ).toBe(false);
  });

  it("counts a FOLDED participant's block, because folding hides the person not the fact", () => {
    const participantIds = Array.from(
      { length: 10 },
      (_unused, index) => `participant-${String(index)}`,
    );
    const wheel = wheelFor(participantIds);
    const blocked = wheel.assignments()[9]?.participantId ?? "";
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [castEvent(1, blocked, "approval.requested")],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.foldedMemberCount).toBeGreaterThan(0);
    expect(model.isAllClear).toBe(false);
  });

  // What this case checks is the DERIVATION — that the member keeps its attention
  // flag. Whether the chip then wears it is the renderer's claim and is asserted in
  // `CastBar.test.tsx`; a case here titled as though it read a chip would leave that
  // seam looking covered while nothing rendered the flag at all.
  it("keeps a member's attention while its own run is blocked, whatever a parallel run does", () => {
    // The defect: attention was read off each participant's NEWEST row, so an agent
    // waiting on an approval in one run and working in another looked clear, and the
    // bar said "Nothing needs you" over a run that was still blocked.
    const wheel = wheelFor(["participant-you", "agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withRun(castEvent(1, "agent-architect", "run.waiting_for_approval"), "run-a"),
        withRun(castEvent(2, "agent-architect", "run.running"), "run-b"),
        withRun(castEvent(3, "agent-architect", "tool.invoked"), "run-b"),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.isAllClear).toBe(false);
    expect(model.members[1]?.needsAttention).toBe(true);
    // The verb still comes from the newest row: what the actor is DOING and what is
    // outstanding are two questions, and this chip answers both without conflating
    // them.
    expect(model.members[1]?.verb).toBe("running a tool");
  });

  it("negative control: the block clears once that run itself moves on", () => {
    // Without this, the case above would pass over a fold that never cleared
    // anything, which would leave the bar permanently amber.
    const wheel = wheelFor(["participant-you", "agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withRun(castEvent(1, "agent-architect", "run.waiting_for_approval"), "run-a"),
        withRun(castEvent(2, "agent-architect", "run.running"), "run-b"),
        withRun(castEvent(3, "agent-architect", "run.running"), "run-a"),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.isAllClear).toBe(true);
    expect(model.members[1]?.needsAttention).toBe(false);
  });

  it("refuses to claim all-clear over an incomplete projection", () => {
    // A store with a sequence gap cannot know whether something needs a person, and
    // "Nothing needs you." over an incomplete projection is a claim the console has
    // no standing to make.
    const wheel = wheelFor(["participant-you"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [],
      isDegraded: true,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.isAllClear).toBe(false);
    expect(model.members[0]?.isVerbStale).toBe(true);
  });

  it("refuses to claim all-clear while the node's health mark is amber", () => {
    // The mark the bar draws beside this line is one this fold cannot see, and a line
    // saying nothing is amber printed next to an amber mark is the strip contradicting
    // itself. The log here is spotless: the verdict alone decides it.
    const wheel = wheelFor(["participant-you"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [],
      isDegraded: false,
      isNodeUnwell: true,
      chipCap: 8,
    });

    expect(model.isAllClear).toBe(false);
  });

  it("negative control: the same spotless log with a healthy node IS the all-clear", () => {
    // Without this the case above would pass over a fold that had stopped saying the
    // line at all, which is the failure the line exists to avoid from the other side.
    const wheel = wheelFor(["participant-you"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });

    expect(model.isAllClear).toBe(true);
  });
});

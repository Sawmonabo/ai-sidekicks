// The cast bar's derivation, and the claim that makes it honest.
//
// The first case is the load-bearing one: every key in the verb table is checked
// against the contracts package's own event census. Without it this module could put
// a verb on a chip for a kind the wire does not have, which is exactly the invented
// verb `cast-bar-model.ts` forbids — and no rendering test would ever notice, because
// the fixture would simply never produce that kind.
//
// Attention is no longer a second kind table here: it is folded by each ask's own
// lifecycle in `outstanding-asks.ts`, whose co-located test makes the same census
// claim over the kinds that fold. The case below is the seam — that this derivation
// reads that fold rather than the newest row.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../store/index.js";
import { ParticipantHueAllocator } from "../tokens/index.js";
import {
  CAST_LABEL_SOURCE_BY_EVENT_KIND,
  CAST_VERB_BY_EVENT_KIND,
  castChipAccessibleName,
  deriveCastBar,
} from "./cast-bar-model.js";

const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
);

function wheelFor(participantIds: readonly string[]): ParticipantHueAllocator {
  const allocator = new ParticipantHueAllocator();
  for (const participantId of participantIds) {
    allocator.admit(participantId);
  }
  return allocator;
}

function event(sequence: number, actorId: string, kind: string): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: "session-1",
    sequence,
    kind,
    occurredAt: "2026-01-01T14:20:00.000Z",
    actorId,
  };
}

/** The same event, carrying the run identity an ask's lifecycle correlates on. */
function withRun(base: ConsoleSessionEvent, runId: string): ConsoleSessionEvent {
  return { ...base, payload: { runId } };
}

/** The same event, carrying the payload a label is read off. */
function withPayload(
  base: ConsoleSessionEvent,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return { ...base, payload };
}

describe("the verb vocabulary — wire truth", () => {
  it("names only event kinds the contracts package registers", () => {
    const unregistered = Object.keys(CAST_VERB_BY_EVENT_KIND).filter(
      (kind) => !REGISTERED_EVENT_TYPES.has(kind),
    );
    expect(unregistered).toStrictEqual([]);
  });

  it("negative control: the census is a real set, and a made-up kind is not in it", () => {
    // Without this, an empty or wrongly-imported census would make both assertions
    // above pass over nothing at all.
    expect(REGISTERED_EVENT_TYPES.size).toBeGreaterThan(100);
    expect(REGISTERED_EVENT_TYPES.has("run.started")).toBe(false);
  });
});

describe("the label vocabulary — wire truth", () => {
  it("names only event kinds the contracts package registers", () => {
    const unregistered = Object.keys(CAST_LABEL_SOURCE_BY_EVENT_KIND).filter(
      (kind) => !REGISTERED_EVENT_TYPES.has(kind),
    );
    expect(unregistered).toStrictEqual([]);
  });
});

describe("deriveCastBar — the name each participant was given", () => {
  it("takes the identity handle off a membership beat's own payload", () => {
    const wheel = wheelFor(["participant-priya"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(event(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "priya",
        }),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBe("priya");
  });

  it("keys an agent's name off the payload's agent id and never off the actor", () => {
    // The person who attached the agent is the actor. Keying on the envelope would
    // put the agent's name on that person's chip and leave the agent unnamed.
    const wheel = wheelFor(["participant-you", "agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(event(1, "participant-you", "agent.attached"), {
          agentId: "agent-architect",
          name: "Architect",
        }),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBeUndefined();
    expect(model.members[1]?.label).toBe("Architect");
  });

  it("lets a later config update rename an agent, because the fold's last writer wins", () => {
    const wheel = wheelFor(["agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(event(1, "participant-you", "agent.attached"), {
          agentId: "agent-architect",
          name: "Architect",
        }),
        withPayload(event(2, "participant-you", "agent.config_updated"), {
          agentId: "agent-architect",
          name: "Planner",
        }),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBe("Planner");
  });

  it("negative control: an unnamed participant, and an empty handle, carry no label", () => {
    // Without this, the cases above would pass over a fold that invented a label
    // from the id — and an empty string would blank the chip rather than leave the
    // id on it.
    const wheel = wheelFor(["participant-you", "participant-priya"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(event(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "",
        }),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBeUndefined();
    expect(model.members[1]?.label).toBeUndefined();
  });
});

describe("castChipAccessibleName — the identifier and the verb", () => {
  it("speaks the label and the verb, which is the name the model composes", () => {
    const wheel = wheelFor(["participant-priya"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(event(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "priya",
        }),
        withRun(event(2, "participant-priya", "run.waiting_for_approval"), "run-a"),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    const member = model.members[0];
    expect(member).toBeDefined();
    // The documented example is the head of the name. The clause after it is the
    // attention fold, which is not suppressed as redundant when the verb happens to
    // be a waiting one: the two are folded from different questions.
    expect(member === undefined ? "" : castChipAccessibleName(member)).toBe(
      "priya, waiting on approval, needs you",
    );
  });

  it("falls back to the id, and adds the frozen clause when the projection is stale", () => {
    const wheel = wheelFor(["participant-you"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [event(1, "participant-you", "run.running")],
      isDegraded: true,
      chipCap: 8,
    });
    const member = model.members[0];
    expect(member).toBeDefined();
    expect(member === undefined ? "" : castChipAccessibleName(member)).toBe(
      "participant-you, working, the connection dropped, so this may be out of date",
    );
  });
});

describe("deriveCastBar — one chip per participant, in join-log order", () => {
  it("keeps the wheel's order and never reorders by activity", () => {
    const wheel = wheelFor(["participant-you", "participant-priya", "agent-architect"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [event(1, "agent-architect", "run.running")],
      isDegraded: false,
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
        event(1, "agent-architect", "run.queued"),
        event(2, "agent-architect", "tool.invoked"),
      ],
      isDegraded: false,
      chipCap: 8,
    });
    expect(model.members[0]?.verb).toBe("running a tool");
  });

  it("invents no verb for a participant with no row, and none for an unmapped kind", () => {
    const wheel = wheelFor(["participant-you", "agent-scout"]);
    const model = deriveCastBar({
      assignments: wheel.assignments(),
      timeline: [event(1, "agent-scout", "run.completed")],
      isDegraded: false,
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
      timeline: [event(1, "agent-scout", "run.running")],
      isDegraded: false,
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
        timeline: [event(1, "agent-architect", "run.running")],
        isDegraded: false,
        chipCap: 8,
      }).isAllClear,
    ).toBe(true);

    expect(
      deriveCastBar({
        assignments: wheel.assignments(),
        timeline: [event(1, "agent-architect", "run.waiting_for_approval")],
        isDegraded: false,
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
      timeline: [event(1, blocked, "approval.requested")],
      isDegraded: false,
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
        withRun(event(1, "agent-architect", "run.waiting_for_approval"), "run-a"),
        withRun(event(2, "agent-architect", "run.running"), "run-b"),
        withRun(event(3, "agent-architect", "tool.invoked"), "run-b"),
      ],
      isDegraded: false,
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
        withRun(event(1, "agent-architect", "run.waiting_for_approval"), "run-a"),
        withRun(event(2, "agent-architect", "run.running"), "run-b"),
        withRun(event(3, "agent-architect", "run.running"), "run-a"),
      ],
      isDegraded: false,
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
      chipCap: 8,
    });
    expect(model.isAllClear).toBe(false);
    expect(model.members[0]?.isVerbStale).toBe(true);
  });
});

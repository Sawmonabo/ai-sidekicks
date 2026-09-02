// The cast bar's derivation, and the claim that makes it honest.
//
// The first case is the load-bearing one: every key in the verb table and every
// member of the attention set is checked against the contracts package's own event
// census. Without it this module could put a verb on a chip for a kind the wire
// does not have, which is exactly the invented verb §4.1 forbids — and no rendering
// test would ever notice, because the fixture would simply never produce that kind.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../store/index.js";
import { ParticipantHueAllocator } from "../tokens/index.js";
import {
  CAST_ATTENTION_EVENT_KINDS,
  CAST_VERB_BY_EVENT_KIND,
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

function event(sequence: number, actorParticipantId: string, kind: string): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind,
    occurredAt: "2026-01-01T14:20:00.000Z",
    actorParticipantId,
  };
}

describe("the verb vocabulary — wire truth", () => {
  it("names only event kinds the contracts package registers", () => {
    const unregistered = Object.keys(CAST_VERB_BY_EVENT_KIND).filter(
      (kind) => !REGISTERED_EVENT_TYPES.has(kind),
    );
    expect(unregistered).toStrictEqual([]);
  });

  it("marks as needing attention only kinds the contracts package registers", () => {
    const unregistered = CAST_ATTENTION_EVENT_KINDS.filter(
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

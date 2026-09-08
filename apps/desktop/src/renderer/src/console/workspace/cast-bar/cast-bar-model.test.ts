// The cast bar's derivation, and the claim that makes it honest.
//
// The first case is the load-bearing one: every key in the verb table is checked
// against the contracts package's own event census. Without it this module could put
// a verb on a chip for a kind the wire does not have, which is exactly the invented
// verb `cast-bar-model.ts` forbids — and no rendering test would ever notice, because
// the fixture would simply never produce that kind.
//
// Attention is no longer a second kind table here: it is held per lifecycle by
// `store/outstanding-asks/outstanding-ask-journal.ts`, whose co-located test makes the same census
// claim over the kinds it keys on, and read through `outstanding-asks.ts`. The case
// below is the seam — that this derivation reads that ledger rather than the newest
// row.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../../store/index.js";
import {
  CAST_LABEL_SOURCE_BY_EVENT_KIND,
  CAST_VERB_BY_EVENT_KIND,
  castChipAccessibleName,
} from "./cast-bar-model.js";
import { castBarOver, castEvent, wheelFor, withRun } from "./cast-bar-model.test-support.js";

const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
);

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
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(castEvent(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "priya",
        }),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBe("priya");
  });

  it("keys an agent's name off the payload's agent id and never off the actor", () => {
    // The person who attached the agent is the actor. Keying on the envelope would
    // put the agent's name on that person's chip and leave the agent unnamed.
    const wheel = wheelFor(["participant-you", "agent-architect"]);
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(castEvent(1, "participant-you", "agent.attached"), {
          agentId: "agent-architect",
          name: "Architect",
        }),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBeUndefined();
    expect(model.members[1]?.label).toBe("Architect");
  });

  it("lets a later config update rename an agent, because the fold's last writer wins", () => {
    const wheel = wheelFor(["agent-architect"]);
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(castEvent(1, "participant-you", "agent.attached"), {
          agentId: "agent-architect",
          name: "Architect",
        }),
        withPayload(castEvent(2, "participant-you", "agent.config_updated"), {
          agentId: "agent-architect",
          name: "Planner",
        }),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBe("Planner");
  });

  it("negative control: an unnamed participant, and an empty handle, carry no label", () => {
    // Without this, the cases above would pass over a fold that invented a label
    // from the id — and an empty string would blank the chip rather than leave the
    // id on it.
    const wheel = wheelFor(["participant-you", "participant-priya"]);
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(castEvent(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "",
        }),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    expect(model.members[0]?.label).toBeUndefined();
    expect(model.members[1]?.label).toBeUndefined();
  });
});

describe("castChipAccessibleName — the identifier and the verb", () => {
  it("speaks the label and the verb, which is the name the model composes", () => {
    const wheel = wheelFor(["participant-priya"]);
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [
        withPayload(castEvent(1, "participant-priya", "membership.created"), {
          participantId: "participant-priya",
          identityHandle: "priya",
        }),
        withRun(castEvent(2, "participant-priya", "run.waiting_for_approval"), "run-a"),
      ],
      isDegraded: false,
      isNodeUnwell: false,
      chipCap: 8,
    });
    const member = model.members[0];
    expect(member).toBeDefined();
    // The documented example is the head of the name. The clause after it is the
    // attention fold, which is not suppressed as redundant when the verb happens to
    // be a waiting one: the two are folded from different questions.
    expect(member === undefined ? "" : castChipAccessibleName(member)).toBe(
      "priya, waiting on approval, waiting on you",
    );
  });

  it("falls back to the id, and adds the frozen clause when the projection is stale", () => {
    const wheel = wheelFor(["participant-you"]);
    const model = castBarOver({
      assignments: wheel.assignments(),
      timeline: [castEvent(1, "participant-you", "run.running")],
      isDegraded: true,
      isNodeUnwell: false,
      chipCap: 8,
    });
    const member = model.members[0];
    expect(member).toBeDefined();
    expect(member === undefined ? "" : castChipAccessibleName(member)).toBe(
      "participant-you, working, the connection dropped, so this may be out of date",
    );
  });
});

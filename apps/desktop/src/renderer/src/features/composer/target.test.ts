// The composer's address: resolved from what the wire says, and never a guess. It is the session's
// lead's live run whenever there is one, wherever focus is, and never a child's: a child is steered
// in its own view, never from the composer.

import { describe, expect, it } from "vitest";

import type { ScenarioAgent } from "#fixtures/data/opening-entries.js";
import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";
import { resolveComposerTarget, type ComposerTargetInput } from "./target.js";
import { sessionCreatedEvent } from "./Composer.test-support.js";

const SESSION_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";

const LEAD: ScenarioAgent = {
  agentId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  name: "Ada",
  driverName: "claude",
  modelId: "opus",
};

/** A child the lead dispatched; it is never in the session's `session.created`. */
const CHILD_AGENT_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const RUN: StoredEntity = {
  kind: "run",
  id: "run-01",
  state: "running",
  touchedAt: "2026-01-01T11:05:00.000Z",
  body: { agentId: LEAD.agentId, runVersion: 4 },
};

/** The child's live run, touched after the lead's so a newest-run pick would land on it. */
const CHILD_RUN: StoredEntity = {
  kind: "run",
  id: "run-child-01",
  state: "running",
  touchedAt: "2026-01-01T11:06:00.000Z",
  body: { agentId: CHILD_AGENT_ID, runVersion: 1, parentRunId: RUN.id },
};

/** The run target addressed at the lead's live `RUN`. */
const LEAD_RUN_TARGET = {
  kind: "run",
  sessionId: SESSION_ID,
  agentId: LEAD.agentId,
  driverName: "claude",
  targetRunId: RUN.id,
} as const;

function input(overrides: Partial<ComposerTargetInput> = {}): ComposerTargetInput {
  return {
    sessionId: SESSION_ID,
    standingEvents: [sessionCreatedEvent(SESSION_ID, LEAD)],
    runs: {},
    ...overrides,
  };
}

describe("resolveComposerTarget — the lead's live run, else the session", () => {
  it("addresses the lead's live run from the store alone, with no pane in play", () => {
    // Nothing about focus is an input: the composer is the lead's wherever the person is looking.
    expect(resolveComposerTarget(input({ runs: { [RUN.id]: RUN } }))).toStrictEqual(
      LEAD_RUN_TARGET,
    );
  });

  it("addresses the session when the lead has no run this store has seen", () => {
    // The negative control for the arm above: the same session with no run.
    expect(resolveComposerTarget(input()).kind).toBe("session");
  });

  it("addresses the session once every run the lead has is terminal", () => {
    // Addressing a settled run would point the ring and the `/` list at a run the daemon will not
    // move again.
    const settled: StoredEntity = { ...RUN, state: "failed" };
    expect(resolveComposerTarget(input({ runs: { [settled.id]: settled } })).kind).toBe("session");
  });
});

describe("resolveComposerTarget — the run is only ever the lead's", () => {
  it("keeps the lead's run over a child's live run touched after it", () => {
    // A send goes onto the lead's queue, so a child's run would list the commands and read the
    // context of an agent the message never reaches.
    const target = resolveComposerTarget(
      input({ runs: { [RUN.id]: RUN, [CHILD_RUN.id]: CHILD_RUN } }),
    );
    expect(target).toStrictEqual(LEAD_RUN_TARGET);
  });

  it("addresses the session when only a child has a live run", () => {
    expect(resolveComposerTarget(input({ runs: { [CHILD_RUN.id]: CHILD_RUN } })).kind).toBe(
      "session",
    );
  });
});

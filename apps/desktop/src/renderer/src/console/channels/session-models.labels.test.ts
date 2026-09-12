// What an activity indicator puts on screen for a run, and why it takes two reads.
//
// The activity fields carry a RUN id and the session's projection names AGENTS, so a
// resolver that indexed the agent partition with the run's own id missed for every run
// a session ever had — and missed silently, because the fallback it landed on is a
// wire id, which reads like a deliberate answer. The cases below are that join in both
// directions: the run whose agent the log named, and each of the three ways the join
// legitimately comes back empty.

import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleEntity } from "../store/index.js";
import { sessionProjectionLabels } from "./session-models.js";

const SESSION_ID = "session-activity-labels";
const RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091";
const AGENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1150077";

/** A store holding exactly the entities a case is about, seeded through the base read. */
function storeHolding(entities: readonly ConsoleEntity[]): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities, userJoinLog: [] });
  return sessionStore;
}

/** The run row the run-lifecycle projector writes: keyed by run id, naming its agent. */
function runNamingAgent(agentId: string): ConsoleEntity {
  return { kind: "run", id: RUN_ID, body: { agentId } };
}

describe("sessionProjectionLabels — the run label is the agent's name", () => {
  it("reads the run's agent, then that agent's projected name", () => {
    const labels = sessionProjectionLabels(
      storeHolding([
        runNamingAgent(AGENT_ID),
        { kind: "agent", id: AGENT_ID, body: { name: "Implementer" } },
      ]),
    );

    expect(labels.runLabel(RUN_ID)).toBe("Implementer");
  });

  it("negative control: the agent partition is never indexed with the run's own id", () => {
    // The exact shape of the defect this pins. An agent entity keyed by the RUN id is
    // a row about a different entity; reading it as this run's agent would name the
    // wrong one, and reading it as a fallback would make the correct join unreachable.
    const labels = sessionProjectionLabels(
      storeHolding([
        runNamingAgent(AGENT_ID),
        { kind: "agent", id: RUN_ID, body: { name: "Not this run's agent" } },
        { kind: "agent", id: AGENT_ID, body: { name: "Implementer" } },
      ]),
    );

    expect(labels.runLabel(RUN_ID)).toBe("Implementer");
  });
});

describe("sessionProjectionLabels — the three ways the join is empty", () => {
  it("falls back to the run id where this log carried no row for the run", () => {
    // The fixture's own case: a peer machine's run reaches the activity field without
    // its `run.*` beats ever reaching this console.
    const labels = sessionProjectionLabels(storeHolding([]));

    expect(labels.runLabel(RUN_ID)).toBe(RUN_ID);
  });

  it("falls back to the run id where the run's row named no agent", () => {
    const labels = sessionProjectionLabels(storeHolding([{ kind: "run", id: RUN_ID }]));

    expect(labels.runLabel(RUN_ID)).toBe(RUN_ID);
  });

  it("falls back to the run id where the named agent has no projected name", () => {
    const labels = sessionProjectionLabels(
      storeHolding([runNamingAgent(AGENT_ID), { kind: "agent", id: AGENT_ID }]),
    );

    expect(labels.runLabel(RUN_ID)).toBe(RUN_ID);
  });

  it("falls back to the run id where the agent member is not a wire string", () => {
    // The body is wire-verbatim and narrows nothing, so a member of the wrong shape
    // has to read as absent rather than as an id to look up.
    const labels = sessionProjectionLabels(
      storeHolding([{ kind: "run", id: RUN_ID, body: { agentId: 7 } }]),
    );

    expect(labels.runLabel(RUN_ID)).toBe(RUN_ID);
  });
});

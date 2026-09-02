// The workflows scenario — skeleton.
//
// The story this scenario eventually tells is a run that parked: one phase waiting
// on a person, another waiting on a spent provider account, a countdown on exactly
// the one the engine armed a resume for and none on the other. That story needs
// surfaces that render phases, and this task builds the chrome around them, so what
// lands here is the SESSION those surfaces will be built against and nothing that
// pretends to be a run.
//
// NO `workflow.*` BEAT IS SCRIPTED, AND THAT IS THE HONEST STATE RATHER THAN AN
// OMISSION. The twenty-four workflow event types are on `Plan-023 §Console growth
// slate` — the corpus has not registered them — and the console's own event shape
// is a renderer-local projection whose `kind` is a free string. A beat carrying an
// unregistered type would therefore compile, render, and be indistinguishable from
// one the daemon can actually send, which is precisely the fabrication the fixture
// exists to avoid. The chrome renders its "nobody asked" absence instead, which is
// what a person would see today.
//
// NO REPLY IS SCRIPTED EITHER. The fixture serves a reply by CALL name, and this
// family makes no call in this task: the run and definition reads are the list and
// detail lanes' work. A reply nothing asks for is a fixture asserting an answer to
// an unasked question.

import type { ConsoleScenario } from "../scenario.js";

export const WORKFLOWS_SCENARIO_ID = "workflows";

const SESSION_ID = "session-workflows";

export const WORKFLOWS_SCENARIO: ConsoleScenario = {
  id: WORKFLOWS_SCENARIO_ID,
  label: "Workflow park",
  purpose:
    "A session a workflow is running in. The skeleton lands here; the run and definition lanes fill in the parked phases, the two park kinds, and the definitions the browser groups by scope.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. One person and the two agents a phase-per-agent
  // workflow attaches, in the order a real run would attach them.
  participantIdsInJoinOrder: ["participant-you", "agent-planner", "agent-builder"],
  startedAtIso: "2026-01-01T10:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T10:00:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Release checklist" },
      },
    },
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T10:00:00.080Z",
        actorParticipantId: "agent-planner",
        payload: { agentId: "agent-planner", displayName: "Planner" },
      },
    },
    {
      atMs: 160,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "agent.attached",
        occurredAt: "2026-01-01T10:00:00.160Z",
        actorParticipantId: "agent-builder",
        payload: { agentId: "agent-builder", displayName: "Builder" },
      },
    },
  ],
  replies: [],
};

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
//
// EVERY ID IS THE UUID THE WIRE DECLARES. `scenarios/wire-truth.ts` presents each
// beat to the strict contract layer as the whole envelope it claims to be, so a
// readable placeholder such as `session-workflows` is a beat no daemon could emit
// and the architecture tier refuses it. The literals below are fixed rather than
// generated for the same reason the flagship's are: a screenshot reference and a
// recorded end-to-end run both have to name the same session twice.

import type { ConsoleScenario } from "../scenario.js";

export const WORKFLOWS_SCENARIO_ID = "workflows";

const SESSION_ID = "019b7a10-0280-75e5-8510-ada11a5a3333";
const PARTICIPANT_YOU = "019b7a10-0280-79a4-8110-cca0117a0110";
const AGENT_PLANNER = "019b7a10-0280-7a6e-8100-d1a4c1150001";
const AGENT_BUILDER = "019b7a10-0280-7a6e-8100-d1a4c1150002";

/**
 * The two agents a phase-per-agent workflow attaches, as the `agents` projection
 * carries them.
 *
 * One table rather than a literal per beat, on the flagship's precedent: the
 * `agent.attached` payload is the replay-complete record `Spec-006 §Channel and
 * Agent Lifecycle (session_lifecycle)` makes it, so the projection rebuilds from
 * it alone, and a second hand-written copy of one agent would drift in exactly
 * the direction nothing catches. The drivers are deliberately mixed so the parked
 * story can show one phase waiting on a spent account while the other still runs.
 */
const WORKFLOW_AGENTS = [
  {
    agentId: AGENT_PLANNER,
    name: "Planner",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 80,
    attachedAtIso: "2026-01-01T10:00:00.080Z",
  },
  {
    agentId: AGENT_BUILDER,
    name: "Builder",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 160,
    attachedAtIso: "2026-01-01T10:00:00.160Z",
  },
] as const;

/** The sequence the first `agent.attached` beat takes. One beat precedes it. */
const FIRST_AGENT_SEQUENCE = 2;

export const WORKFLOWS_SCENARIO: ConsoleScenario = {
  id: WORKFLOWS_SCENARIO_ID,
  label: "Workflow park",
  purpose:
    "A session a workflow is running in. The skeleton lands here; the run and definition lanes fill in the parked phases, the two park kinds, and the definitions the browser groups by scope.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. One person and the two agents a phase-per-agent
  // workflow attaches, in the order a real run would attach them.
  participantIdsInJoinOrder: [PARTICIPANT_YOU, ...WORKFLOW_AGENTS.map((agent) => agent.agentId)],
  startedAtIso: "2026-01-01T10:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T10:00:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim: the new session's id plus the resolved
        // config and metadata, both open records the corpus names no key inside.
        // The workflow's title is not on this wire; a fixture that put one here
        // would be teaching a surface to read a member no daemon sets.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...WORKFLOW_AGENTS.map((agent, agentIndex) => ({
      atMs: agent.attachedAtMs,
      event: {
        sessionId: SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not
        // attach itself, and the envelope actor is who acted.
        actorParticipantId: PARTICIPANT_YOU,
        // The full persona plus the daemon-resolved resulting state, so the
        // `agents` projection rebuilds from the log alone. `name` is the member —
        // `displayName` is not on this wire.
        payload: {
          sessionId: SESSION_ID,
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    })),
  ],
  replies: [],
};

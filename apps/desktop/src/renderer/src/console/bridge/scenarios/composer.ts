// The composer scenario: a session addressed to something, with a message pending.
//
// It exists so the composer's zones have a session to be addressed WITHIN. Two
// people and two agents, so a target is a real choice rather than the only one, and
// the newest run is `waiting_for_input` — the state in which a person's next
// sentence is the thing the session is blocked on, which is the moment the composer
// matters most.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, and every
// identifier is the UUID its branded id type declares. `scenarios/wire-truth.ts`
// holds this file to the census (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict
// payload layer (`SessionEventSchema`), both in `packages/contracts/src/event.ts`.
// Three consequences a reader will notice first:
//
//   • **`agent.attached` carries `name`.** `displayName` is not a member of that
//     payload anywhere in the corpus.
//     `Spec-006 §Channel and Agent Lifecycle (session_lifecycle)` registers the full
//     persona plus the daemon-resolved resulting state, so the `agents` projection
//     rebuilds from the log alone.
//   • **A `run.*` beat is a STATE TRANSITION.** Its payload is
//     `{sessionId, runId, runVersion, previousState, newState, …}` and not a bare
//     `{runId}` — `previousState` is absent only on `run.queued`, where the run is
//     being born and no document names the state it came from.
//   • **Nothing scripts `session.list`.** No method registry in the corpus carries
//     that name. The session directory reaches a surface through the growth
//     operation `sessionList`, which `bridge/fixture/fixture-growth-port.ts` serves from
//     the state this scenario's own `session.read` reply declares — so a scripted
//     reply here would be a second, unreachable answer to a question the fixture
//     already answers from the read below.
//
// WHICH CALLS ARE SCRIPTED, AND WHY ONLY THOSE. `fixture-bridge.ts` refuses an
// unscripted call as `reply-unscripted`, which is the fixture's authoring error and
// a state some surfaces are built to render. So a reply is scripted here exactly
// when a composer-family surface issues that call: `session.read`, which the frame
// issues for the opened session (and which is what puts this session in the node
// directory), `agent.list` for the roster, and the two the composer's own
// accessories dispatch — `run.pause` from the step-in control and
// `driver.compactContext` from the compaction control — plus
// `driver.listProviderCommands`, which the command zone's discovery popover issues
// for the addressed agent, and `run.queueList`, the queue shelf's opening read,
// served as an empty queue: the shelf says when a snapshot could not be read, so
// leaving the read unscripted would pin a refusal notice into every composer
// reference for a queue the scenario never meant to refuse. The approval
// reads are deliberately NOT scripted: this scenario is what makes the approvals
// pane's refusal arm reachable.
//
// ONE REPLY PER CALL NAME, so the refusing-target half of the enumeration is not
// reachable from here: `replyFor` matches on the method name alone and the fixture
// serves the first entry, so a second `driver.listProviderCommands` scripting a
// refusal would be unreachable rather than conditional. That arm is driven in the
// command zone's own unit, over a bridge whose scenario refuses this call.

import type { ConsoleScenario } from "../scenario-runtime/index.js";
import {
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  COMPOSER_AGENTS,
  FIRST_AGENT_SEQUENCE,
  MEMBERSHIP_PRIYA,
  PARTICIPANT_PRIYA,
  PARTICIPANT_YOU,
  RUN_ID,
  SESSION_ID,
} from "./composer.identifiers.js";
import { COMPOSER_REPLIES } from "./composer.replies.js";

export const COMPOSER_SCENARIO: ConsoleScenario = {
  id: "composer",
  label: "Awaiting a reply",
  purpose:
    "A session whose newest run is blocked on a person's next message — the state the composer's target, posture, and send resolution are read against.",
  sessionId: SESSION_ID,
  // Join order IS hue order (`Spec-023 §Console Design (Meridian)` rule 2): the two
  // people who joined, then the agents in the order they were attached.
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
  ],
  // Which of the four this window is. Stated rather than read off the head of the
  // join order — that entry is whoever opened the session, on whichever machine, and
  // a surface handed a fabricated identity renders a role gate as though it had been
  // checked. The fixture answers `callerParticipantRead` from this field alone.
  viewingParticipantId: PARTICIPANT_YOU,
  // The membership each PERSON in the roster holds. The two agents in the join order
  // take no entry: an agent is attached rather than admitted, so it holds no
  // membership and the fixture does not claim to know one. Without this, the viewer's
  // identity read succeeds into a roster carrying no role and every owner- and
  // collaborator-gated control renders closed for a reason nothing checked.
  membershipRoleByParticipantId: {
    [PARTICIPANT_YOU]: "owner",
    [PARTICIPANT_PRIYA]: "collaborator",
  },
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorId: PARTICIPANT_YOU,
        // The registered shape, verbatim. A session's display name reaches the
        // console from the session read; the creation event carries no title, and
        // its `.strict()` payload rejects one.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 60,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150002",
        sessionId: SESSION_ID,
        sequence: 2,
        // A person joining a session is a membership event: `participant.*` is not
        // in the census at all.
        kind: "membership.created",
        occurredAt: "2026-01-01T11:05:00.060Z",
        actorId: PARTICIPANT_PRIYA,
        payload: {
          membershipId: MEMBERSHIP_PRIYA,
          participantId: PARTICIPANT_PRIYA,
          role: "collaborator",
          identityHandle: "priya",
        },
      },
    },
    ...COMPOSER_AGENTS.map((agent, agentIndex) => ({
      atMs: agent.attachedAtMs,
      event: {
        id: agent.eventId,
        sessionId: SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not attach
        // itself, and the envelope actor is who acted.
        actorId: PARTICIPANT_YOU,
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
    {
      atMs: 260,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150003",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.260Z",
        actorId: PARTICIPANT_YOU,
        // `previousState` is absent here and only here: a queued run is being born.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: AGENT_IMPLEMENTER,
        },
      },
    },
    {
      atMs: 320,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150004",
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "run.starting",
        occurredAt: "2026-01-01T11:05:00.320Z",
        // No actor: the daemon moves a run out of `queued`, and a participant id
        // here would attribute a system transition to a person.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 400,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150005",
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.running",
        occurredAt: "2026-01-01T11:05:00.400Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
    {
      atMs: 480,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150006",
        sessionId: SESSION_ID,
        sequence: 8,
        // Waiting is not pausing: this run is blocked on someone, and the composer
        // is where that someone answers.
        kind: "run.waiting_for_input",
        occurredAt: "2026-01-01T11:05:00.480Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 4,
          previousState: "running",
          newState: "waiting_for_input",
        },
      },
    },
    {
      atMs: 540,
      event: {
        id: "019b7a11-1100-7e00-8110-e5e0c1150007",
        sessionId: SESSION_ID,
        sequence: 9,
        // The session's one goal, as the log carries it — there is no goal store, so
        // this event IS the goal and the sidebar's line is a fold over it. A person
        // set it, so the beat carries an actor.
        kind: "session.goal_updated",
        occurredAt: "2026-01-01T11:05:00.540Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          goal: {
            text: "Land the rate-limit wiring behind the enforcement legs, then close the backlog items it names.",
          },
        },
      },
    },
  ],
  replies: COMPOSER_REPLIES,
};

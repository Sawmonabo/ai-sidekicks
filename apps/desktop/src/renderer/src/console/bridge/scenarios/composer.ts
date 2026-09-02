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
//     operation `sessionList`, which `bridge/fixture-growth-port.ts` serves from
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
// for the addressed agent. The approval
// reads are deliberately NOT scripted: this scenario is what makes the approvals
// pane's refusal arm reachable.
//
// ONE REPLY PER CALL NAME, so the refusing-target half of the enumeration is not
// reachable from here: `replyFor` matches on the method name alone and the fixture
// serves the first entry, so a second `driver.listProviderCommands` scripting a
// refusal would be unreachable rather than conditional. That arm is driven in the
// command zone's own unit, over a bridge whose scenario refuses this call.

import type { ConsoleScenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
const SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a33a5";
const PARTICIPANT_YOU = "019b7a11-1100-79a4-8110-cca0117a0310";
const PARTICIPANT_PRIYA = "019b7a11-1100-79a4-8120-cca0117a0320";
const MEMBERSHIP_PRIYA = "019b7a11-1100-7e3b-8110-cca0117a0330";
const AGENT_IMPLEMENTER = "019b7a11-1100-7a6e-8110-d1a4c1150301";
const AGENT_REVIEWER = "019b7a11-1100-7a6e-8120-d1a4c1150302";
const RUN_ID = "019b7a11-1100-740e-8110-d1a4c1150311";

/**
 * The two agents, as one table feeding both the beats and the `agent.list` reply.
 *
 * The flagship scenario's rule, applied here: the `agent.attached` payload and the
 * `agent.list` row are two views of one record, and two hand-written copies of one
 * agent drift in exactly the direction nothing catches. The drivers are mixed on
 * purpose — a composer whose whole cast runs one provider cannot show what a
 * two-provider target chip looks like, and that is the chip this scenario is for.
 */
const COMPOSER_AGENTS = [
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 120,
    attachedAtIso: "2026-01-01T11:05:00.120Z",
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 180,
    attachedAtIso: "2026-01-01T11:05:00.180Z",
  },
] as const;

/** The sequence the first `agent.attached` beat takes. Two beats precede it. */
const FIRST_AGENT_SEQUENCE = 3;

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
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim. A session's display name reaches the
        // console from the session read; the creation event carries no title, and
        // its `.strict()` payload rejects one.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        // A person joining a session is a membership event: `participant.*` is not
        // in the census at all.
        kind: "membership.created",
        occurredAt: "2026-01-01T11:05:00.060Z",
        actorParticipantId: PARTICIPANT_PRIYA,
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
        sessionId: SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. An agent does not attach
        // itself, and the envelope actor is who acted.
        actorParticipantId: PARTICIPANT_YOU,
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
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.260Z",
        actorParticipantId: PARTICIPANT_YOU,
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
  ],
  replies: [
    {
      // The registered `SessionReadResponse` shape. `state: "active"` is what the
      // fixture's directory derivation reads to list this session on the node —
      // a scenario that declares no session state declares no session to list.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: "2026-01-01T11:05:00.000Z",
          updatedAt: "2026-01-01T11:05:00.000Z",
        },
        timelineCursors: { latest: "composer-cursor-1" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: COMPOSER_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle — `configured` / `ready` /
          // `disabled` / `archived`. A run being blocked is a RUN state and is read
          // from the run, never folded into the agent row.
          state: "ready",
          createdAt: agent.attachedAtIso,
        })),
      },
    },
    {
      // The step-in control's dispatch. `RunControlAck` is `.strict()` and carries
      // exactly these three members, so the reply is the post-pause reading of the
      // run above rather than a fresh invention: `runVersion` advances by one and
      // `currentState` is the state the verb reached.
      call: "run.pause",
      result: { runId: RUN_ID, currentState: "paused", runVersion: 5 },
    },
    {
      // The discovery popover's dispatch, agent-addressed within the session. The
      // reply is the GROUP LIST the wire declares and never a flat entry array: the
      // group is what carries the `(driverName, providerAccountId)` the entries were
      // read under, and the invariant this surface renders is that an entry is
      // offered only under the binding it came from.
      //
      // `runId` is the run this scenario plays, which is the one live run on this
      // binding — the arm the contract says answers with THAT run rather than with
      // `null`. `providerAccountId` is `null`, the positive statement that this
      // fixture binds no provider account: the composer scenario attaches agents and
      // registers no account, and a synthesized placeholder would make the routing
      // pair compare equal where it must not.
      //
      // The two entries differ in what the provider published, deliberately: the
      // command carries a description and the skill carries a scope and an `enabled`
      // flag, so the row that renders a provider-supplied description and the row
      // that renders its absence are both reachable.
      call: "driver.listProviderCommands",
      result: {
        bindings: [
          {
            runId: RUN_ID,
            binding: { driverName: "claude", providerAccountId: null },
            entries: [
              {
                name: "compact",
                kind: "command",
                description: "Compact the conversation context.",
                binding: { driverName: "claude", providerAccountId: null },
              },
              {
                name: "review",
                kind: "skill",
                scope: "project",
                enabled: true,
                binding: { driverName: "claude", providerAccountId: null },
              },
            ],
            complete: true,
          },
        ],
      },
    },
    {
      // The compaction control's dispatch. `DriverCompactionResult` is a
      // discriminated union whose `applied` arm REQUIRES `boundaryPosition`, typed
      // `number | null` — null being the positive statement that the provider's
      // frame carried no position, which is a different fact from a driver that
      // forgot to report one. This scenario reports a position, so the boundary the
      // compaction landed on is renderable.
      call: "driver.compactContext",
      // A scripted latency, so the in-flight half of the control is reachable: a
      // compaction that settled instantly would let a surface ship without ever
      // rendering the state a person actually watches.
      afterMs: 200,
      result: { status: "applied", boundaryPosition: 8 },
    },
  ],
};

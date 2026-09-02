// The ledger scenario — three lanes ending in three different conditions.
//
// The session the ledger frame, the chapters, the seams, the rail, and the replay
// scrub are all measured against. Each lane ends somewhere different, and the three
// endings are exactly the ones a reader has to be able to tell apart in one frame:
//
//   • The implementer's run runs, blocks on an approval, unblocks, is rewound past
//     a boundary, re-executes, and finishes — so its chapter is TERMINAL and folds
//     to a one-line past-tense receipt, with a superseded band inside it.
//   • The reviewer's run runs, fails a tool call, and is PAUSED — so its chapter
//     carries the pause seam and stays parked at the frozen tick.
//   • The architect's run is still LIVE at the last beat, mid-turn, so the frame
//     always has something streaming in it.
//
// A single-lane script would have rendered every one of those states too, one after
// another — and would have proved nothing about the thing this console exists for,
// which is several of them being true at once in different hues. The session's own
// EMPTY state is the one composition no script reaches, and it lives next door in
// `ledger-quiet.ts` for that reason.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, under the two-leg
// rule `scenarios/wire-truth.ts` states in its header: the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`), both in
// `packages/contracts/src/event.ts`, are the code leg, and the per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md` name the members of a
// registered type whose strict variant has not landed yet. That predicate holds this file
// to the code leg, and `scenarios/ledger-script.ts` carries the payload builders so a
// member cannot drift between two beats of one kind.
//
// FIVE THINGS THE DESIGN ASKS FOR THAT THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **The provider-switch seam.** `agent.provider_switched` and
//     `agent.provider_switch_failed` are in no shipped `SessionEventType`, so a
//     beat playing one would be a frame about a wire that does not exist. The seam
//     module already renders that absence rather than drawing the seam.
//   • **A resume and an unblock as their own rows.** `run.resumed` and
//     `run.unblocked` are likewise unregistered; the registered transition back is
//     `run.running`, and that is what this script plays.
//   • **An approval card.** `approval.requested` is a registered type, but the card it
//     would draw belongs to the surface that renders approvals — so the run reaches
//     `waiting_for_approval` and returns to `running`, which is the part of that story
//     the log can tell.
//   • **A cost or token reading.** Not because the members are unnamed — the taxonomy
//     leg names them, and `scenarios/flagship.ts` meters a cost against exactly that row
//     — but because this session's subject is the ledger frame, the chapters, the seams,
//     the rail, and the replay scrub, and the meter is not on any of them. Flagship is
//     the scenario that moves the meter; a second one here would be a reading no surface
//     in this session's frame reads. Scripting one would carry every member
//     `Spec-006 §Usage Telemetry (usage_telemetry)` makes required of a post-amendment
//     emitter — `costStatus`, `costSource`, and `effectivePrincipal` — exactly as
//     flagship's own builder does.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.

import {
  createLedgerLaneEntries,
  ledgerOpeningEntries,
  scriptLedgerBeats,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import type { ConsoleScenario } from "../scenario.js";

export const LEDGER_SCENARIO_ID = "ledger";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// rendered identifier tells one fixture apart from another at a glance — and so an
// id is as wide on screen as a real one, which a readable name never is.
const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `scriptLedgerBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
const EVENT_ID_STEM = "019b793b-7b60-7ea1-8110-e5e0d115";
const PARTICIPANT_YOU = "019b793b-7b60-79a4-8110-cca0117a0410";
const PARTICIPANT_PRIYA = "019b793b-7b60-79a4-8120-cca0117a0420";
const MEMBERSHIP_PRIYA = "019b793b-7b60-7e3b-8110-cca0117a0430";
const AGENT_ARCHITECT = "019b793b-7b60-7a6e-8110-d1a4c1150101";
const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8120-d1a4c1150102";
const AGENT_REVIEWER = "019b793b-7b60-7a6e-8130-d1a4c1150103";
const RUN_IMPLEMENTER = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_REVIEWER = "019b793b-7b60-740e-8120-d1a4c1150112";
const RUN_ARCHITECT = "019b793b-7b60-740e-8130-d1a4c1150113";

const STARTED_AT_ISO = "2026-01-01T11:05:00.000Z";

/**
 * The three lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat and a second per reply: the
 * `agent.attached` payload and the `agent.list` row are two views of one record,
 * and two hand-written copies of one agent drift in the direction nothing catches.
 * The drivers are mixed on purpose — a fixture whose whole cast runs one provider
 * cannot show a surface what a two-provider session looks like.
 */
const LEDGER_AGENTS = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 120,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 160,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 200,
  },
] as const;

/** The instant one agent was attached, as the `agent.list` reply reports it. */
function attachedAtIso(attachedAtMs: number): string {
  return new Date(Date.parse(STARTED_AT_ISO) + attachedAtMs).toISOString();
}

/**
 * The rewind anchor the implementer's run landed at.
 *
 * Named once because two things read it and they must agree: the boundary beat
 * declares it, and the superseded band the ledger draws is every row of that run
 * and epoch whose position EXCEEDS it. A second literal would let the band and the
 * boundary disagree about which turns are past.
 */
const IMPLEMENTER_REWIND_TARGET_POSITION = 4;

/** The three entry builders, with this scenario's session bound in. */
const lane = createLedgerLaneEntries(SESSION_ID);

const LEDGER_SCRIPT: readonly LedgerScriptEntry[] = [
  ...ledgerOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: PARTICIPANT_YOU,
    joinedBy: PARTICIPANT_PRIYA,
    membershipId: MEMBERSHIP_PRIYA,
    joinedAtMs: 40,
    cast: LEDGER_AGENTS,
  }),
  {
    atMs: 280,
    kind: "user.message",
    // The author is the envelope's actor and the text is not here: participant
    // prose is sealed per participant in `pii_payload`, and a fixture that put the
    // words on the payload would teach a row to read a member no daemon sets.
    actorId: PARTICIPANT_PRIYA,
    payload: { sessionId: SESSION_ID },
  },

  // Lane one — the implementer. Born, blocked, unblocked, rewound, finished.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 400,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 480,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 520,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 412,
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 640,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_284,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 760,
    kind: "tool.invoked",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 900,
    kind: "tool.result",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
    durationMs: 140,
    contentLength: 96,
  }),

  // Lane two — the reviewer, opened by the other person in the room, so a chapter
  // header and a row gutter carry different hues inside one lane.
  lane.transition(RUN_REVIEWER, {
    atMs: 960,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_REVIEWER,
    actorId: PARTICIPANT_PRIYA,
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 1_040,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 1_120,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_REVIEWER, {
    atMs: 1_180,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 806,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_240,
    kind: "tool.invoked",
    toolName: "run_tests",
    toolCallId: "call-reviewer-1",
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_420,
    kind: "tool.error",
    toolName: "run_tests",
    toolCallId: "call-reviewer-1",
    durationMs: 180,
    contentLength: 244,
  }),

  // The block seam and its return. `run.blocked` is not a type: the design's own
  // parenthetical says the block indicator distinguishes the two waiting states,
  // and those two ARE registered, so the run enters one of them and comes back
  // through `run.running` — which is the transition the daemon actually emits.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_620,
    runVersion: 4,
    previousState: "running",
    newState: "waiting_for_approval",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_960,
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
  }),
  {
    atMs: 2_100,
    kind: "usage.context_compacted",
    // The compaction seam. The boundary POSITION the seam renders in mono is not
    // here: `usage.context_compacted` registers no payload variant and no member
    // of one is named anywhere in `packages/contracts`, so the two members every
    // run-scoped payload in the corpus carries are all this beat can honestly say.
    payload: { sessionId: SESSION_ID, runId: RUN_IMPLEMENTER },
  },
  // The pause seam, and the lane that is still parked at the last beat.
  lane.transition(RUN_REVIEWER, {
    atMs: 2_200,
    runVersion: 4,
    previousState: "running",
    newState: "paused",
    actorId: PARTICIPANT_PRIYA,
  }),

  // Lane three — the architect, which is still mid-turn when the script ends.
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    actorId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_400,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_480,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 2_540,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 318,
  }),

  {
    atMs: 2_600,
    kind: "run.rolled_back",
    // `RunRolledBackEvent`'s own members (`packages/contracts/src/runControl.ts`):
    // the POST-rollback progression value, and the turn boundary the run landed
    // at — which is not the boundary row's own position, and is what the
    // superseded band above it is measured against.
    actorId: PARTICIPANT_YOU,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 6,
      targetPosition: IMPLEMENTER_REWIND_TARGET_POSITION,
    },
  },
  lane.output(RUN_IMPLEMENTER, {
    atMs: 2_700,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_012,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_820,
    kind: "tool.invoked",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_900,
    kind: "tool.result",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
    durationMs: 62,
    contentLength: 2_048,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 2_980,
    runVersion: 7,
    previousState: "running",
    newState: "completed",
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 3_060,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_640,
  }),
];

export const LEDGER_SCENARIO: ConsoleScenario = {
  id: LEDGER_SCENARIO_ID,
  label: "Three lanes",
  purpose:
    "A session whose three runs end in three different conditions at once — one finished behind a rewind boundary, one parked, one still streaming — so the chapters, the seams, the rail, and the replay scrub all have something to render.",
  sessionId: SESSION_ID,
  // Join order IS hue order: two people first, then the agents in attach order,
  // which is what a real session's join log looks like.
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_ARCHITECT,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
  ],
  // Which of the roster this window is. Stated rather than read off the head of the
  // join order, which is whoever opened the session on whichever machine.
  viewingParticipantId: PARTICIPANT_YOU,
  // The roster every role gate resolves through. The viewer is an owner, which is what
  // lets a role-gated control be driven in this scenario at all; Priya's
  // `collaborator` is the same value her `membership.created` beat carries — one fact,
  // stated where the roster is read from and replayed where the log records it
  // arriving. The agents are absent on purpose: an agent is attached rather than
  // admitted and holds no membership, so a row here would resolve to a role no daemon
  // granted.
  membershipRoleByParticipantId: {
    [PARTICIPANT_YOU]: "owner",
    [PARTICIPANT_PRIYA]: "collaborator",
  },
  startedAtIso: STARTED_AT_ISO,
  beats: scriptLedgerBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtIso: STARTED_AT_ISO,
    entries: LEDGER_SCRIPT,
  }),
  replies: [
    {
      // `session.read`, not a `session.list`: the method registry carries no list
      // verb, and a fixture answering one would put a call in front of a surface
      // that has nowhere to send it.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T11:05:03.060Z",
        },
        timelineCursors: { latest: "ledger-cursor-33" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: LEDGER_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle. A run being in flight is a
          // RUN state, read from the run and never folded into the agent row.
          state: "ready",
          createdAt: attachedAtIso(agent.attachedAtMs),
        })),
      },
    },
  ],
};

// The first sixty seconds — the session a fresh console opens into.
//
// `Spec-023 §The four bars`, Richness, names this composition: "The first sixty
// seconds and the flagship frame are designed compositions, regression-tested by
// screenshot." WHAT THE MINUTE IS FOR is this scenario's own decision, because no
// committed document states it: the product demonstrates itself before it asks for
// anything. First launch opens into a live session already in flight — several
// sidekicks and several people working, parallel streams revealing, an approval
// arriving, a receipt landing past tense — and the empty state IS the demo. So this
// scenario is not a tour and not a checklist: it is one
// ordinary session, scripted over sixty seconds of scenario time, that a person can
// watch, scrub, and leave.
//
// WHY THE TIMINGS ARE THE DESIGN AND NOT DECORATION
//
// The ledger scenario next door compresses a whole session into three seconds
// because its job is to reach every state a surface renders. This one is paced:
// beats land seconds apart, so the reveal engine actually reveals, the reading
// anchor actually holds while rows land above it, and a person watching sees a
// session unfold rather than a frame appear. A script that fired everything at tick
// zero would render the same rows and demonstrate none of that.
//
// The composition it reaches, and the order it reaches it in:
//
//   0–8s    the room fills — two people, three sidekicks
//   8–24s   two lanes stream at once, in two hues
//   24–34s  a child thread opens under one of them and settles
//   34–46s  a run blocks waiting on an approval and is let through
//   46–60s  that run lands past tense; the other is still going
//
// EVERY BEAT IS A REGISTERED EVENT. The census and the strict layer both live in
// `packages/contracts/src/event.ts` and `scenarios/wire-truth.ts` holds this file
// to them. Two things the composition above wants that no beat here can state:
// participant status VERBS (presence is not an event type, and the cast bar reads it
// from a projection no wire serves) and the handoff being DRAWN between two runs
// (`handoff.*` is not
// in the census; `subagent.started` / `subagent.completed` are, and a child thread
// opening under a run is the part of that story the log can tell).

import {
  createLedgerLaneEntries,
  ledgerOpeningEntries,
  scriptLedgerBeats,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import type { ConsoleScenario } from "../scenario.js";

export const LEDGER_FIRST_SIXTY_SCENARIO_ID = "ledger-first-sixty";

const SESSION_ID = "019b78ff-f900-75e5-8510-ada11a5a46a5";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `scriptLedgerBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
const EVENT_ID_STEM = "019b78ff-f900-7ea1-8110-e5e0d115";
const PARTICIPANT_YOU = "019b78ff-f900-79a4-8110-cca0117a0460";
const PARTICIPANT_PRIYA = "019b78ff-f900-79a4-8120-cca0117a0470";
const MEMBERSHIP_PRIYA = "019b78ff-f900-7e3b-8110-cca0117a0480";
const AGENT_ARCHITECT = "019b78ff-f900-7a6e-8110-d1a4c1150105";
const AGENT_IMPLEMENTER = "019b78ff-f900-7a6e-8120-d1a4c1150106";
const AGENT_REVIEWER = "019b78ff-f900-7a6e-8130-d1a4c1150107";
const RUN_IMPLEMENTER = "019b78ff-f900-740e-8110-d1a4c1150114";
const RUN_REVIEWER = "019b78ff-f900-740e-8120-d1a4c1150115";

const STARTED_AT_ISO = "2026-01-01T10:00:00.000Z";

/** One second of scenario time, so the pacing below reads in seconds. */
const ONE_SECOND_MS = 1_000;

/**
 * The minute this scenario is paced across, declared once.
 *
 * The id, the label, and the purpose sentence all say "sixty seconds", and the script's
 * last beat has to land on it. Exported so the pacing claim is read from here rather than
 * restated as a literal in a test — a script edit that moved the last beat off the
 * declared span is exactly what that claim is for, and a test carrying its own copy of
 * the number would still be asserting against the old one.
 */
export const LEDGER_FIRST_SIXTY_SPAN_MS: number = 60 * ONE_SECOND_MS;

/** The cast, in attach order — one table feeding both the beats and the reply. */
const FIRST_SIXTY_AGENTS = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtSeconds: 4,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtSeconds: 6,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtSeconds: 8,
  },
] as const;

function atSecond(second: number): number {
  return second * ONE_SECOND_MS;
}

function instantAtSecond(second: number): string {
  return new Date(Date.parse(STARTED_AT_ISO) + atSecond(second)).toISOString();
}

/** The three entry builders, with this scenario's session bound in. */
const lane = createLedgerLaneEntries(SESSION_ID);

const FIRST_SIXTY_SCRIPT: readonly LedgerScriptEntry[] = [
  ...ledgerOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: PARTICIPANT_YOU,
    joinedBy: PARTICIPANT_PRIYA,
    membershipId: MEMBERSHIP_PRIYA,
    joinedAtMs: atSecond(2),
    cast: FIRST_SIXTY_AGENTS.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      driverName: agent.driverName,
      modelId: agent.modelId,
      attachedAtMs: atSecond(agent.attachedAtSeconds),
    })),
  }),

  // 8–24s — two lanes at once, opened by the two different people in the room.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(10),
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(11),
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(12),
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: atSecond(13),
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 366,
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: atSecond(14),
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_REVIEWER,
    actorId: PARTICIPANT_PRIYA,
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: atSecond(15),
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: atSecond(16),
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: atSecond(18),
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_120,
  }),
  lane.output(RUN_REVIEWER, {
    atMs: atSecond(20),
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 742,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: atSecond(22),
    kind: "tool.invoked",
    toolName: "edit_file",
    toolCallId: "call-first-sixty-1",
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: atSecond(24),
    kind: "tool.result",
    toolName: "edit_file",
    toolCallId: "call-first-sixty-1",
    durationMs: 1_640,
    contentLength: 128,
  }),

  // 24–34s — a child thread opens under the reviewer's run and settles.
  {
    atMs: atSecond(26),
    kind: "subagent.started",
    // The two members every run-scoped payload in the corpus carries, and no
    // third: `subagent.*` registers no payload variant and no member of one is
    // named anywhere in `packages/contracts`, so a child-thread identifier here
    // would be a wire fact this fixture invented.
    payload: { sessionId: SESSION_ID, runId: RUN_REVIEWER },
  },
  lane.tool(RUN_REVIEWER, {
    atMs: atSecond(29),
    kind: "tool.invoked",
    toolName: "run_tests",
    toolCallId: "call-first-sixty-2",
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: atSecond(32),
    kind: "tool.result",
    toolName: "run_tests",
    toolCallId: "call-first-sixty-2",
    durationMs: 2_980,
    contentLength: 512,
  }),
  {
    atMs: atSecond(34),
    kind: "subagent.completed",
    payload: { sessionId: SESSION_ID, runId: RUN_REVIEWER },
  },

  // 34–46s — the approval arriving, and the run being let through.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(36),
    runVersion: 4,
    previousState: "running",
    newState: "waiting_for_approval",
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(44),
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
    actorId: PARTICIPANT_YOU,
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: atSecond(48),
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 980,
  }),

  // 46–60s — one lane lands past tense; the other is still going when the script
  // ends, which is what keeps the surface alive for a person who just sat down.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: atSecond(52),
    runVersion: 6,
    previousState: "running",
    newState: "completed",
  }),
  lane.output(RUN_REVIEWER, {
    atMs: atSecond(56),
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 288,
  }),
  lane.output(RUN_REVIEWER, {
    atMs: atSecond(60),
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_408,
  }),
];

export const LEDGER_FIRST_SIXTY_SCENARIO: ConsoleScenario = {
  id: LEDGER_FIRST_SIXTY_SCENARIO_ID,
  label: "First sixty seconds",
  purpose:
    "A live session already in flight, paced over sixty seconds — two lanes streaming, a child thread, an approval, and a run landing past tense. What a fresh console opens into instead of an empty state.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_ARCHITECT,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
  ],
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
    entries: FIRST_SIXTY_SCRIPT,
  }),
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: instantAtSecond(60),
        },
        timelineCursors: { latest: "ledger-first-sixty-cursor-28" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: FIRST_SIXTY_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          state: "ready",
          createdAt: instantAtSecond(agent.attachedAtSeconds),
        })),
      },
    },
  ],
};

// The flagship scenario — four lanes streaming at once.
//
// The session `budgets.json`'s `frame-time-p95-four-lanes` row names as its subject:
// "four agent lanes stream concurrently into the ledger". That row is enforced, so
// this script is what the ceiling is measured against, and the concurrency is the
// property under measurement rather than a description of it — four runs are
// mid-turn at the same tick, interleaved beat by beat, and
// `scenarios/streaming-lanes.ts` reads that back off these beats so the harness
// asserts it instead of assuming it.
//
// WHAT THE SESSION DOES, IN THE ORDER IT DOES IT
//
//   • Two people, four agents, and the implementer's run opened — the opening this
//     scenario has always had, and the one every surface built against it expects.
//   • The other three lanes spin up, and from the architect's `running` transition
//     onward all four are streaming: thinking, messages, and tool calls interleaved
//     across four run chapters rather than four runs taken in turn.
//   • An approval lands MID-STREAM. The implementer's run enters
//     `waiting_for_approval` while the other three keep talking, and returns through
//     `running`. That is the whole of the approval story the log can tell — see the
//     note below on why no `approval.*` beat is scripted.
//   • The cost meter moves, four times, one per lane.
//   • A thread is drawn between two runs: the architect's turn spawns a helper run,
//     whose birth beat carries `parentRunId`. It is queued and starting at the last
//     tick, so the frame also has the one lane state a four-lane session otherwise
//     never shows — a run on screen that has produced nothing yet.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD. The census is
// `SESSION_EVENT_CATEGORY_BY_TYPE` and the strict layer is `SessionEventSchema`,
// both in `packages/contracts/src/event.ts`; where a type has no strict variant the
// members come from the per-family and per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md`, which is the taxonomy
// those variants are implemented from. `scenarios/wire-truth.ts` holds this file to
// the layers that exist in code. That is not tidiness — a fixture that plays a type
// no daemon emits produces screenshots, geometry readings, and end-to-end results
// about a wire that does not exist, and every one of them looks like a pass.
//
// THREE THINGS THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **An approval card.** `approval.requested` is a registered type, but the card
//     it would draw belongs to the surface that renders approvals, and the run-state
//     pair below is what the ledger reads: `run.waiting_for_approval` and the
//     `run.running` that releases it. Scripting both would put two records of one
//     approval in one session, and the ledger would have to decide which is true.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.
//   • **A link TYPE on the run thread.** `linkType` is typed by a Plan-016 symbol no
//     TypeScript in this workspace declares, so the thread carries the two linkage
//     members that do have types — `parentRunId` and `internalHelper` — and says
//     nothing about which kind of link it is.
//
// TWO CONSEQUENCES A READER WILL NOTICE FIRST:
//
//   • **The identifiers are UUIDs.** `SessionId`, `ParticipantId`, `MembershipId`,
//     `AgentId`, and `RunId` are branded UUIDs (`§Branded ID Types` in
//     `docs/architecture/contracts/api-payload-contracts.md`), and the strict layer
//     refuses anything else. A readable `"agent-scout"` would also have rendered at
//     a third of the width a real one does, which is a design lie in a fixture
//     whose whole job is to be measured.
//   • **`session.created` carries no title.** Its registered payload is
//     `{sessionId, config, metadata}` and it is `.strict()`, so a `title` member is
//     rejected outright. A session's display name reaches the console from the
//     session read, and `session.renamed` is where a later change to it would
//     arrive — never from the creation event.

import {
  createLedgerLaneEntries,
  ledgerOpeningEntries,
  scriptLedgerBeats,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import type { ConsoleScenario } from "../scenario.js";

export const FLAGSHIP_SCENARIO_ID = "flagship";

// Wire identifiers, spelled as the wire spells them. UUID v7 values, whose leading
// bytes are the scenario's own start instant, so a reader scanning a rendered id
// can still tell one fixture apart from another.
const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";
const PARTICIPANT_YOU = "019b79ee-0280-79a4-8110-cca0117a0110";
const PARTICIPANT_PRIYA = "019b79ee-0280-79a4-8120-cca0117a0120";
const MEMBERSHIP_PRIYA = "019b79ee-0280-7e3b-8110-cca0117a0130";
const AGENT_ARCHITECT = "019b79ee-0280-7a6e-8110-d1a4c1150001";
const AGENT_IMPLEMENTER = "019b79ee-0280-7a6e-8120-d1a4c1150002";
const AGENT_REVIEWER = "019b79ee-0280-7a6e-8130-d1a4c1150003";
const AGENT_SCOUT = "019b79ee-0280-7a6e-8140-d1a4c1150004";
const RUN_IMPLEMENTER = "019b79ee-0280-740e-8110-d1a4c1150011";
const RUN_REVIEWER = "019b79ee-0280-740e-8120-d1a4c1150012";
const RUN_SCOUT = "019b79ee-0280-740e-8130-d1a4c1150013";
const RUN_ARCHITECT = "019b79ee-0280-740e-8140-d1a4c1150014";
const RUN_ARCHITECT_HELPER = "019b79ee-0280-740e-8150-d1a4c1150015";

const STARTED_AT_ISO = "2026-01-01T14:20:00.000Z";

/**
 * The four lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat and a second literal per reply: the
 * `agent.attached` payload and the `agent.list` row are two views of one record
 * (`Spec-006 §Channel and Agent Lifecycle (session_lifecycle)` makes the event replay-complete
 * precisely so the projection can be rebuilt from it), and two hand-written copies
 * of one agent would drift in exactly the direction nothing catches.
 *
 * The drivers and models are deliberately mixed. A fixture whose whole cast runs
 * one provider cannot show a surface what a two-provider session looks like, and
 * that is the session this console is for.
 */
const FLAGSHIP_AGENTS = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    attachedAtMs: 150,
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    attachedAtMs: 200,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    attachedAtMs: 250,
  },
  {
    agentId: AGENT_SCOUT,
    name: "Scout",
    driverName: "codex",
    modelId: "gpt-5.4-mini",
    attachedAtMs: 300,
  },
] as const;

/**
 * How many lanes this session streams at once.
 *
 * Read off the cast rather than written as a four: the budget row, the scenario's
 * own label, and the harness assertion all mean "one lane per agent", and a literal
 * in any of them would let the cast grow while the claim stayed at its old size.
 */
export const FLAGSHIP_LANE_COUNT: number = FLAGSHIP_AGENTS.length;

/** The instant one agent was attached, as the `agent.list` reply reports it. */
function attachedAtIso(attachedAtMs: number): string {
  return new Date(Date.parse(STARTED_AT_ISO) + attachedAtMs).toISOString();
}

/** The three entry builders, with this scenario's session bound in. */
const lane = createLedgerLaneEntries(SESSION_ID);

/**
 * One cost reading, in the shape `Spec-006 §Usage Telemetry (usage_telemetry)` registers for it.
 *
 * A local builder rather than one hoisted into the shared vocabulary: this is the
 * only scenario that meters a cost today, and `apps/desktop/AGENTS.md` hoists a
 * helper on its SECOND use. The three required members are carried in full —
 * `usage.cost_update` MUST set `costStatus` and `costSource`, and post-2026-08-26
 * emitters MUST set `effectivePrincipal` — because a partial row here would teach a
 * meter to read a shape no emitter produces.
 */
function costUpdateEntry(input: {
  readonly atMs: number;
  readonly runId: string;
  readonly costCents: number;
  readonly causedBy: string;
}): LedgerScriptEntry {
  return {
    atMs: input.atMs,
    kind: "usage.cost_update",
    payload: {
      sessionId: SESSION_ID,
      runId: input.runId,
      costCents: input.costCents,
      costStatus: "priced",
      costSource: "provider_reported",
      effectivePrincipal: { kind: "participant", participantId: input.causedBy },
    },
  };
}

const FLAGSHIP_SCRIPT: readonly LedgerScriptEntry[] = [
  // The opening, unchanged in shape: the room, the cast in join order, and the
  // implementer's run opened by the viewer. Every surface built against this
  // scenario reads these eight beats, so they stay first and stay as they were.
  ...ledgerOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: PARTICIPANT_YOU,
    joinedBy: PARTICIPANT_PRIYA,
    membershipId: MEMBERSHIP_PRIYA,
    joinedAtMs: 50,
    cast: FLAGSHIP_AGENTS,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 400,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorParticipantId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 500,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),

  // The four lanes spin up, staggered the way a real session's do. Each reaches
  // `running` before the next is queued, so the ledger draws them arriving rather
  // than appearing together.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 550,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 600,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_REVIEWER,
    actorParticipantId: PARTICIPANT_PRIYA,
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 650,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_REVIEWER, {
    atMs: 700,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.transition(RUN_SCOUT, {
    atMs: 750,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_SCOUT,
    actorParticipantId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_SCOUT, {
    atMs: 800,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_SCOUT, {
    atMs: 850,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 900,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    actorParticipantId: PARTICIPANT_YOU,
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 950,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_ARCHITECT, {
    atMs: 1_000,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),

  // From here to the last beat, four runs are mid-turn at every tick. The beats
  // ROTATE through the lanes rather than grouping by lane, because the overlap is
  // what is being measured: a script that finished one lane before starting the
  // next would deliver the same beats and prove nothing about four at once.
  lane.output(RUN_IMPLEMENTER, {
    atMs: 1_050,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 412,
  }),
  lane.output(RUN_REVIEWER, {
    atMs: 1_100,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 268,
  }),
  lane.output(RUN_SCOUT, {
    atMs: 1_150,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 194,
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 1_200,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 522,
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 1_250,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_284,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_300,
    kind: "tool.invoked",
    toolName: "run_tests",
    toolCallId: "call-reviewer-1",
  }),
  lane.output(RUN_SCOUT, {
    atMs: 1_350,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 640,
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 1_400,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_960,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 1_450,
    kind: "tool.invoked",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
  }),
  costUpdateEntry({
    atMs: 1_500,
    runId: RUN_IMPLEMENTER,
    costCents: 34,
    causedBy: PARTICIPANT_YOU,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_550,
    kind: "tool.result",
    toolName: "run_tests",
    toolCallId: "call-reviewer-1",
    durationMs: 180,
    contentLength: 244,
  }),

  // The approval, landing mid-stream: one lane blocks, and the other three carry on
  // talking through the whole block. That overlap is the point — an approval in a
  // one-lane session stops the session, and in this one it stops a quarter of it.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_600,
    runVersion: 4,
    previousState: "running",
    newState: "waiting_for_approval",
  }),
  lane.output(RUN_REVIEWER, {
    atMs: 1_650,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 806,
  }),
  lane.output(RUN_SCOUT, {
    atMs: 1_700,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 232,
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 1_750,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 388,
  }),
  costUpdateEntry({
    atMs: 1_800,
    runId: RUN_REVIEWER,
    costCents: 21,
    causedBy: PARTICIPANT_PRIYA,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_850,
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
    actorParticipantId: PARTICIPANT_YOU,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 1_900,
    kind: "tool.result",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
    durationMs: 140,
    contentLength: 96,
  }),

  // All four still going, and the meter still moving on two more lanes.
  lane.output(RUN_ARCHITECT, {
    atMs: 1_950,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_412,
  }),
  costUpdateEntry({ atMs: 2_000, runId: RUN_SCOUT, costCents: 9, causedBy: PARTICIPANT_YOU }),
  lane.output(RUN_REVIEWER, {
    atMs: 2_050,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 176,
  }),
  lane.tool(RUN_SCOUT, {
    atMs: 2_100,
    kind: "tool.invoked",
    toolName: "read_file",
    toolCallId: "call-scout-1",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 2_150,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_012,
  }),
  lane.tool(RUN_SCOUT, {
    atMs: 2_200,
    kind: "tool.result",
    toolName: "read_file",
    toolCallId: "call-scout-1",
    durationMs: 62,
    contentLength: 2_048,
  }),
  costUpdateEntry({
    atMs: 2_250,
    runId: RUN_ARCHITECT,
    costCents: 57,
    causedBy: PARTICIPANT_YOU,
  }),
  lane.output(RUN_REVIEWER, {
    atMs: 2_300,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 742,
  }),
  lane.output(RUN_ARCHITECT, {
    atMs: 2_350,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 296,
  }),

  // The thread between two runs. `Spec-006 §Run Lifecycle (run_lifecycle)` puts the linkage members
  // on the BIRTH beat — `run.queued` — so the parent is named where the child is
  // created, and nowhere else: a second event announcing the link would be a second
  // record of one fact, and the projection would have to pick one.
  {
    atMs: 2_400,
    kind: "run.queued",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ARCHITECT_HELPER,
      runVersion: 1,
      newState: "queued",
      parentRunId: RUN_ARCHITECT,
      internalHelper: true,
    },
  },
  lane.transition(RUN_ARCHITECT_HELPER, {
    atMs: 2_450,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
];

export const FLAGSHIP_SCENARIO: ConsoleScenario = {
  id: FLAGSHIP_SCENARIO_ID,
  label: "Four lanes",
  purpose:
    "A live session with four agents streaming at once — interleaved turns on four run chapters, an approval landing mid-stream while the other three carry on, the cost meter moving on every lane, and a helper run threaded to the turn that spawned it.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. Two people first, then the agents in the order
  // they were attached — which is what a real session's join log looks like.
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_ARCHITECT,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
    AGENT_SCOUT,
  ],
  // Which of the six this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine,
  // and the two facts coincide here only because this scenario chose to make them.
  viewingParticipantId: PARTICIPANT_YOU,
  startedAtIso: STARTED_AT_ISO,
  beats: scriptLedgerBeats({
    sessionId: SESSION_ID,
    startedAtIso: STARTED_AT_ISO,
    entries: FLAGSHIP_SCRIPT,
  }),
  replies: [
    {
      // `session.read`, not a `session.list`: the registry carries no list method,
      // and a fixture answering one would put a call in front of a surface that
      // has nowhere to send it.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T14:20:02.450Z",
        },
        timelineCursors: { latest: "flagship-cursor-45" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: FLAGSHIP_AGENTS.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          config: {},
          // `AgentState` is the four-state lifecycle — `configured` / `ready` /
          // `disabled` / `archived`. A run being in flight is a RUN state and is
          // read from the run, never folded into the agent row.
          state: "ready",
          createdAt: attachedAtIso(agent.attachedAtMs),
        })),
      },
    },
  ],
};

// The concurrent-streaming scenario: four lanes streaming at once.
//
// This is the session behind the `frame-time-p95-four-lanes` row in
// `tests/budget/document.json`, so its concurrency is the property measured: four runs are
// mid-turn at the same tick, interleaved beat by beat, and `tests/endurance/streaming-lanes.ts`
// reads that back off these beats.
//
// The session, in order:
//
//   - One person, four agents, and the implementer's run opened.
//   - The other three lanes spin up. From the architect's `running` transition all four stream
//     thinking, messages and tool calls, interleaved across four run groups.
//   - An approval lands mid-stream: the request, the implementer entering
//     `waiting_for_approval` while the others keep talking, the grant, and the return to
//     `running`.
//   - A lane parks: a provider quota reading lands at 100% with its reset instant and the
//     scout's run pauses, so the frame carries a countdown beside three streaming lanes.
//   - The cost meter moves once per lane.
//   - The architect's turn spawns a helper run whose birth beat carries `parentRunId`. It is
//     queued and starting at the last tick, the one lane state a four-lane session otherwise
//     never shows: a run that has produced nothing yet.
//
// Every beat is a registered event with its registered payload.
// `tests/helpers/scenario/contract-check/all-axes.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`) in
// `packages/contracts/src/event/session.ts`, because a fixture that plays a type no daemon
// emits produces passing results about a wire that does not exist.
//
// The approval pair and the run-state pair are two records, not one: `approval_flow` records
// what was asked, by whom and who granted it, and `run_lifecycle` records what the run did
// about it. Neither is derivable from the other.
//
// Ids are UUIDs, as the strict layer requires. `session.created` carries no title, because
// its `.strict()` payload rejects one. Assistant and tool payloads describe their body and
// never carry it; the body is stored in `content_payload`.
//
// Beside the session's own read it answers the MCP servers and Providers settings pages, whose
// reads belong to the machine rather than the session.

import {
  composeScenarioInstant,
  composeScriptBeats,
  type ScriptEntry,
  createRunEntryBuilders,
  findBeatCursor,
  newestBeatInstant,
} from "../data/script-entries.js";
import type { Scenario } from "./script.js";
import {
  type ScenarioAgent,
  composeOpeningEntry,
  composeResolvedAgent,
  findScenarioMember,
} from "../data/opening-entries.js";
import { GITFLOW_DIFF_REPLIES } from "../data/gitflow-diff-replies.js";
import { SETTINGS_PAGE_REPLIES } from "../data/settings-page-replies.js";
import { WORKFLOW_OPENING_NOTICES, WORKFLOW_REPLIES } from "../data/workflow/replies.js";

// The cast and its clock: every identifier in one place. Ids are UUID v7 values whose leading
// bytes are the scenario's start instant.
const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

// The stem row ids are minted from; `composeScriptBeats` completes it with the beat's
// position. It differs from `SESSION_ID` on purpose, so a row id cannot be rebuilt from the
// session and the sequence.
const EVENT_ID_STEM = "019b79ee-0280-7ea1-8110-e5e0d115";
/** The signed-in user, who opens the session and is this window's caller. */
export const USER_YOU = "019b79ee-0280-79a4-8110-cca0117a0110";
const AGENT_ARCHITECT = "019b79ee-0280-7a6e-8110-d1a4c1150001";
const AGENT_IMPLEMENTER = "019b79ee-0280-7a6e-8120-d1a4c1150002";
const AGENT_REVIEWER = "019b79ee-0280-7a6e-8130-d1a4c1150003";
const AGENT_SCOUT = "019b79ee-0280-7a6e-8140-d1a4c1150004";
const RUN_IMPLEMENTER = "019b79ee-0280-740e-8110-d1a4c1150011";
const RUN_REVIEWER = "019b79ee-0280-740e-8120-d1a4c1150012";
const RUN_SCOUT = "019b79ee-0280-740e-8130-d1a4c1150013";
const RUN_ARCHITECT = "019b79ee-0280-740e-8140-d1a4c1150014";
const RUN_ARCHITECT_HELPER = "019b79ee-0280-740e-8150-d1a4c1150015";

// The base instant, built with `Date.UTC` rather than by parsing a string (`Date.parse` reads
// a timezone-less stamp in the host's zone), so the ISO spelling below cannot disagree.
const startedAtMs: number = Date.UTC(2026, 0, 1, 14, 20);

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

// The four lanes, as the `agents` projection carries them, in one table that the lead and
// every provider-naming beat read. Drivers and models are mixed so a view sees a
// two-provider session.
const CONCURRENT_STREAMING_AGENTS: readonly ScenarioAgent[] = [
  {
    agentId: AGENT_ARCHITECT,
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5-5",
  },
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    definitionId: "019b79ee-0280-7de1-8120-d1a4c1150022",
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    definitionId: "019b79ee-0280-7de1-8130-d1a4c1150023",
  },
  {
    agentId: AGENT_SCOUT,
    name: "Scout",
    driverName: "codex",
    modelId: "gpt-5.6-luna",
    definitionId: "019b79ee-0280-7de1-8140-d1a4c1150024",
  },
];

// Two entry builders only this scenario needs: no other scenario meters a cost or raises an
// approval, so they move to `fixtures/data/` on a second use.

// `usage.cost_update` has no strict payload variant in `packages/contracts`, so nothing but
// this builder checks the row's members.
function costUpdateEntry(input: {
  readonly atMs: number;
  readonly runId: string;
  readonly costUsdMicros: number;
}): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: "usage.cost_update",
    payload: {
      sessionId: SESSION_ID,
      runId: input.runId,
      costUsdMicros: input.costUsdMicros,
      costSource: "provider_reported",
    },
  };
}

// The one approval this session raises. The request and its grant share its id, since two
// ids would be two approvals.
const APPROVAL_REQUEST_ID = "019b79ee-0280-7b12-8150-a11a0c150001";

// What was asked for; the approval contract types scope as free text.
const APPROVAL_SCOPE = "run";

// The provider account this session's lanes are admitted against.
const PROVIDER_ACCOUNT_ID = "019b79ee-0280-7c34-8160-b21a0c150001";

// One approval row. The caller supplies the members that differ: `requestedBy` and
// `resourceDescriptor` on a request, `effectiveScope` on a resolution.
function approvalEntry(input: {
  readonly atMs: number;
  readonly kind: string;
  readonly actorId?: string;
  readonly members: Readonly<Record<string, unknown>>;
}): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: input.kind,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      approvalRequestId: APPROVAL_REQUEST_ID,
      // The wire's closed-set category for a write to the working tree.
      category: "file_write",
      scope: APPROVAL_SCOPE,
      ...input.members,
    },
  };
}

// What the four lanes do, beat by beat.
const lane = createRunEntryBuilders(SESSION_ID);

const CONCURRENT_STREAMING_SCRIPT: readonly ScriptEntry[] = [
  // The opening: the room born with its lead, the architect, and the implementer's run
  // opened by the signed-in user.
  composeOpeningEntry({
    sessionId: SESSION_ID,
    shape: "project",
    openedBy: USER_YOU,
    lead: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_ARCHITECT),
    createdAt: STARTED_AT_ISO,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 400,
    runVersion: 1,
    newState: "queued",
    resolvedAgent: composeResolvedAgent({
      agent: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_IMPLEMENTER),
      lead: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_ARCHITECT),
      resolvedAt: composeScenarioInstant(startedAtMs, 400),
    }),
    actorId: USER_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 500,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),

  // The lanes spin up staggered: each reaches `running` before the next is queued, so the
  // transcript draws them arriving.
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
    resolvedAgent: composeResolvedAgent({
      agent: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_REVIEWER),
      lead: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_ARCHITECT),
      resolvedAt: composeScenarioInstant(startedAtMs, 600),
    }),
    actorId: USER_YOU,
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
    resolvedAgent: composeResolvedAgent({
      agent: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_SCOUT),
      lead: findScenarioMember(CONCURRENT_STREAMING_AGENTS, AGENT_ARCHITECT),
      resolvedAt: composeScenarioInstant(startedAtMs, 750),
    }),
    actorId: USER_YOU,
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
    actorId: USER_YOU,
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

  // From here on four runs are mid-turn at every tick. Beats rotate through the lanes rather
  // than grouping by lane, since the overlap is what is measured.
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
    costUsdMicros: 340_000,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_550,
    kind: "tool.result",
    toolName: "run_tests",
    toolCallId: "call-reviewer-1",
    durationMs: 180,
    contentLength: 244,
  }),

  // The approval lands mid-stream: one lane blocks while the other three keep talking. Four
  // beats, not two: the request and grant are `approval_flow` rows, the block and release
  // are `run_lifecycle` rows, and they are different facts about one moment.
  approvalEntry({
    atMs: 1_590,
    kind: "approval.requested",
    members: {
      requestedBy: AGENT_IMPLEMENTER,
      resourceDescriptor: { path: "packages/runtime-daemon/src/session/lifecycle.ts" },
    },
  }),
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
    costUsdMicros: 210_000,
  }),
  approvalEntry({
    atMs: 1_840,
    kind: "approval.approved",
    actorId: USER_YOU,
    members: {
      effectiveScope: APPROVAL_SCOPE,
      deviceId: "019b79ee-0280-7d02-8110-d1a4c1150041",
      clientResolutionId: "019b79ee-0280-7c01-8110-d1a4c1150031",
    },
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_850,
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
    actorId: USER_YOU,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 1_900,
    kind: "tool.result",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
    durationMs: 140,
    contentLength: 96,
  }),

  // All four still going; the meter moves on two more lanes.
  lane.output(RUN_ARCHITECT, {
    atMs: 1_950,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_412,
  }),
  costUpdateEntry({ atMs: 2_000, runId: RUN_SCOUT, costUsdMicros: 90_000 }),
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
  // The park: a quota reading lands with the instant it resets, and the scout's run pauses.
  // Two beats because the reading is account-plane and carries no `runId`, while the pause is
  // one run's. The countdown comes from `resetsAt`.
  {
    atMs: 2_225,
    kind: "usage.rate_limit_update",
    payload: {
      sessionId: SESSION_ID,
      provider: "claude",
      providerAccountId: PROVIDER_ACCOUNT_ID,
      credentialGeneration: 1,
      limitId: "five-hour",
      windowMins: 300,
      usedPercent: 100,
      resetsAt: "2026-01-01T18:32:00.000Z",
    },
  },
  lane.transition(RUN_SCOUT, {
    atMs: 2_235,
    runVersion: 4,
    previousState: "running",
    newState: "paused",
  }),
  costUpdateEntry({
    atMs: 2_250,
    runId: RUN_ARCHITECT,
    costUsdMicros: 570_000,
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

  // The thread between two runs: the child-run link members ride the birth beat (`run.queued`)
  // only, and the shared builder enforces that.
  lane.transition(RUN_ARCHITECT_HELPER, {
    atMs: 2_400,
    runVersion: 1,
    newState: "queued",
    parentRunId: RUN_ARCHITECT,
  }),
  lane.transition(RUN_ARCHITECT_HELPER, {
    atMs: 2_450,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
];

/** The id of the concurrent-streaming scenario. */
export const CONCURRENT_STREAMING_SCENARIO_ID = "concurrent-streaming";

/**
 * How many lanes this session streams at once, read off the cast so the budget row, the
 * label and the harness assertion all mean one lane per agent.
 */
export const CONCURRENT_STREAMING_LANE_COUNT: number = CONCURRENT_STREAMING_AGENTS.length;

const CONCURRENT_STREAMING_BEATS = composeScriptBeats({
  sessionId: SESSION_ID,
  eventIdStem: EVENT_ID_STEM,
  startedAtMs,
  entries: CONCURRENT_STREAMING_SCRIPT,
});

/** Four agents streaming at once, with a mid-stream approval, a parked lane and a helper run. */
export const CONCURRENT_STREAMING_SCENARIO: Scenario = {
  id: CONCURRENT_STREAMING_SCENARIO_ID,
  label: "Four lanes",
  purpose:
    "A live session with four agents streaming at once — interleaved turns on four run " +
    "groups, an approval landing mid-stream while the other three carry on, the cost " +
    "meter moving on every lane, and a helper run threaded to the turn that spawned it.",
  sessionId: SESSION_ID,
  startedAtIso: STARTED_AT_ISO,
  beats: CONCURRENT_STREAMING_BEATS,
  replies: [
    {
      // The frame's read is `session.read`; nothing in the renderer calls `session.list`.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          createdAt: STARTED_AT_ISO,
          updatedAt: newestBeatInstant(CONCURRENT_STREAMING_BEATS),
          draft: "",
        },
        transcriptCursors: {
          latest: findBeatCursor(CONCURRENT_STREAMING_BEATS, CONCURRENT_STREAMING_BEATS.length),
        },
      },
    },
    ...SETTINGS_PAGE_REPLIES,
    ...WORKFLOW_REPLIES,
    ...GITFLOW_DIFF_REPLIES,
  ],
  openingNotices: WORKFLOW_OPENING_NOTICES,
};

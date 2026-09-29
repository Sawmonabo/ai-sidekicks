// The concurrent-streaming scenario: four lanes streaming at once.
//
// The session `budgets.json`'s `frame-time-p95-four-lanes` row names as its subject:
// "four agent lanes stream concurrently into the transcript". That row is enforced, so
// this script is what the ceiling is measured against, and the concurrency is the
// property under measurement rather than a description of it — four runs are
// mid-turn at the same tick, interleaved beat by beat, and
// `tests/endurance/streaming-lanes.ts` reads that back off these beats so the harness
// asserts it instead of assuming it.
//
// WHAT THE SESSION DOES, IN THE ORDER IT DOES IT
//
//   • One person, four agents, and the implementer's run opened — the opening this
//     scenario has always had, and the one every surface built against it expects.
//   • The other three lanes spin up, and from the architect's `running` transition
//     onward all four are streaming: thinking, messages, and tool calls interleaved
//     across four run groups rather than four runs taken in turn.
//   • An approval lands MID-STREAM, in four beats: the request, the implementer's run
//     entering `waiting_for_approval` while the other three keep talking, the grant,
//     and the return through `running`.
//   • A lane PARKS. A provider quota reading lands at 100% with the instant it resets
//     at, and the scout's run suspends on it — so the frame carries a park with a
//     countdown, and three lanes still streaming beside it.
//   • The cost meter moves, four times, one per lane.
//   • A thread is drawn between two runs: the architect's turn spawns a helper run,
//     whose birth beat carries `parentRunId`. It is queued and starting at the last
//     tick, so the frame also has the one lane state a four-lane session otherwise
//     never shows — a run on screen that has produced nothing yet.
//
// EVERY BEAT IS A REGISTERED EVENT, CARRYING THE REGISTERED PAYLOAD, under the two-leg
// rule `tests/helpers/scenario-contract-check/contract-check.ts` states: the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and the strict layer (`SessionEventSchema`), both in
// `packages/contracts/src/event.ts`, are the code leg, and where a type has no strict
// variant its members come from the per-type payload rows of the session event
// taxonomy those variants are implemented from. That predicate holds this file to
// the layers that exist in code. That is not tidiness — a fixture that plays a type
// no daemon emits produces screenshots, geometry readings, and end-to-end results
// about a wire that does not exist, and every one of them looks like a pass.
//
// TWO THINGS THIS SCRIPT DELIBERATELY DOES NOT SAY
//
//   • **A provider switch.** The event census does not register
//     `agent.provider_binding_changed` or `agent.provider_binding_change_failed` yet,
//     so a beat for one would fail the census leg of the wire-truth predicate, and a
//     screenshot of it would be a frame of a wire that does not exist. The seam a
//     switch draws arrives here the day the census registers the pair.
//   • **A machine body.** `assistant.*` and `tool.*` payloads carry their body's
//     DESCRIPTION and never the body, which is sealed in `content_payload` and
//     served by no bridge namespace. The cards render the named absence, which is
//     the true state of that wire today.
//
// THE APPROVAL PAIR PLAYS BESIDE THE RUN-STATE PAIR, and the two are not two records of
// one approval: `approval_flow` records WHAT was asked, by whom, over what resource, and
// who granted it, and `run_lifecycle` records what the RUN did about it. Neither is
// derivable from the other — a run can block on an ask nobody answers, and an approval
// can be granted for a run that has already ended — so a session carrying only the run
// pair would leave the approvals surface nothing to render.
//
// TWO CONSEQUENCES A READER WILL NOTICE FIRST:
//
//   • **The identifiers are UUIDs.** `SessionId`, `UserId`, `AgentId`,
//     and `RunId` are branded UUIDs declared once in the payload
//     contracts, and the strict layer
//     refuses anything else. A readable `"agent-scout"` would also have rendered at
//     a third of the width a real one does, which is a design lie in a fixture
//     whose whole job is to be measured.
//   • **`session.created` carries no title.** Its registered payload is
//     `{sessionId, config, metadata}` and it is `.strict()`, so a `title` member is
//     rejected outright. A session's display name reaches the console from the
//     session read, and `session.renamed` is where a later change to it would
//     arrive — never from the creation event.

import {
  composeScriptBeats,
  type ScriptEntry,
  createRunEntryBuilders,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";
import { type ScenarioAgent, composeOpeningEntries } from "../data/opening-entries.js";

// The cast and its clock: every identifier in one place.

// Wire identifiers, spelled as the wire spells them. UUID v7 values, whose leading
// bytes are the scenario's own start instant, so a reader scanning a rendered id
// can still tell one fixture apart from another.
const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/**
 * The stem this scenario's row ids are minted from — its own namespace, not its
 * session's.
 *
 * `composeScriptBeats` completes it with the beat's position. Distinct from
 * `SESSION_ID` on purpose: an event id a caller could rebuild out of the session and
 * the sequence would let a projection that stopped carrying the real one keep
 * answering.
 */
const EVENT_ID_STEM = "019b79ee-0280-7ea1-8110-e5e0d115";
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

/**
 * The base instant, minted from its fields rather than read back out of a string.
 *
 * `Date.parse` is not a validator — it reads a timezone-less stamp in the host's
 * zone and normalizes a day that does not exist — so a fixture that derived its
 * milliseconds by parsing its own literal was asking a reader to trust the one
 * function the console bans. `Date.UTC` states the instant, and the ISO spelling
 * every reply carries is derived from it, so the two can never disagree. The name
 * ends `Ms` because that is what it holds — a number, not a stamp behind a name.
 */
const startedAtMs: number = Date.UTC(2026, 0, 1, 14, 20);

const STARTED_AT_ISO: string = new Date(startedAtMs).toISOString();

/**
 * The four lanes, as the `agents` projection carries them.
 *
 * One table rather than a literal per beat and a second literal per reply: the
 * `agent.attached` payload and the `agent.list` row are two views of one record
 * (the agent lifecycle makes the event replay-complete
 * precisely so the projection can be rebuilt from it), and two hand-written copies
 * of one agent would drift in exactly the direction nothing catches.
 *
 * The drivers and models are deliberately mixed. A fixture whose whole cast runs
 * one provider cannot show a surface what a two-provider session looks like, and
 * that is the session this console is for.
 */
const CONCURRENT_STREAMING_AGENTS: readonly ScenarioAgent[] = [
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
];

// The two entry builders this script needs and no other scenario has. They stay here
// rather than in `fixtures/data/`: no other scenario meters a cost or raises an approval,
// and shared data moves there on its second use.

/**
 * One cost reading, in the shape the usage-telemetry family registers for it.
 *
 * The three required members are carried in full — `usage.cost_update` MUST set
 * `costStatus` and `costSource`, and post-2026-08-26 emitters MUST set
 * `effectivePrincipal` — because a partial row here would teach a meter to read a
 * shape no emitter produces, which is the defect `tests/helpers/scenario-contract-check/contract-check.ts`'
 * taxonomy-leg rule exists to prevent and which the code leg cannot see: no strict
 * variant is registered for this type yet.
 */
function costUpdateEntry(input: {
  readonly atMs: number;
  readonly runId: string;
  readonly costCents: number;
  readonly causedBy: string;
}): ScriptEntry {
  return {
    atMs: input.atMs,
    kind: "usage.cost_update",
    payload: {
      sessionId: SESSION_ID,
      runId: input.runId,
      costCents: input.costCents,
      costStatus: "priced",
      costSource: "provider_reported",
      effectivePrincipal: { kind: "user", userId: input.causedBy },
    },
  };
}

/**
 * The one approval this session raises, and the identity every row of it shares.
 *
 * A request and its grant are two rows about ONE request, so they carry one id: a
 * pair with two would be two approvals, one of them never answered and one answered
 * without ever having been asked.
 */
const APPROVAL_REQUEST_ID = "019b79ee-0280-7b12-8150-a11a0c150001";

/** What was asked for, in the vocabulary the approval contract types as free text. */
const APPROVAL_SCOPE = "run";

/** The provider account this session's lanes are admitted against. */
const PROVIDER_ACCOUNT_ID = "019b79ee-0280-7c34-8160-b21a0c150001";

/**
 * One approval row, in the shape the approval-flow family registers.
 *
 * The members that differ between a request and its resolution are the caller's —
 * that family's row makes `requestedBy` and `resourceDescriptor` present on the
 * request and `approver` and `effectiveScope` present on the resolution, and a row
 * carrying the other pair would be a shape no emitter produces.
 */
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
      // The category the wire's closed set names for a write to the working tree,
      // which is what this run asked to do.
      category: "file_write",
      scope: APPROVAL_SCOPE,
      ...input.members,
    },
  };
}

// What the four lanes do, beat by beat.

/** The four entry builders, with this scenario's session bound in. */
const lane = createRunEntryBuilders(SESSION_ID);

const CONCURRENT_STREAMING_SCRIPT: readonly ScriptEntry[] = [
  // The opening, unchanged in shape: the room, the cast in join order, and the
  // implementer's run opened by the signed-in user. Every surface built against this
  // scenario reads these eight beats, so they stay first and stay as they were.
  ...composeOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: USER_YOU,
    cast: CONCURRENT_STREAMING_AGENTS,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 400,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorId: USER_YOU,
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 500,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),

  // The four lanes spin up, staggered the way a real session's do. Each reaches
  // `running` before the next is queued, so the transcript draws them arriving rather
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
    agentId: AGENT_SCOUT,
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
    causedBy: USER_YOU,
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
  //
  // FOUR BEATS AND NOT TWO. The request and its grant are `approval_flow` rows and the
  // block and its release are `run_lifecycle` rows, and they are two different facts
  // about one moment: the approval says WHAT was asked and by whom, and the run states
  // say what the run did about it. A script carrying only the run pair leaves the card
  // nothing to render, which is what it used to do.
  approvalEntry({
    atMs: 1_590,
    kind: "approval.requested",
    members: {
      requestedBy: AGENT_IMPLEMENTER,
      resourceDescriptor: { path: "packages/runtime-daemon/src/session/lifecycle.ts" },
      expiryAt: "2026-01-01T14:35:00.000Z",
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
    costCents: 21,
    causedBy: USER_YOU,
  }),
  approvalEntry({
    atMs: 1_840,
    kind: "approval.approved",
    actorId: USER_YOU,
    members: { approver: USER_YOU, effectiveScope: APPROVAL_SCOPE },
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

  // All four still going, and the meter still moving on two more lanes.
  lane.output(RUN_ARCHITECT, {
    atMs: 1_950,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_412,
  }),
  costUpdateEntry({ atMs: 2_000, runId: RUN_SCOUT, costCents: 9, causedBy: USER_YOU }),
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
  // The park. A provider quota reading lands with the instant it resets at, and the
  // lane running on that account suspends — two beats, because they are two facts and
  // the wire keeps them apart: the reading is account-plane and carries no `runId` at
  // all, and the suspension is this one run's. The countdown a person reads comes off
  // `resetsAt`, which is the only member on either row that names a future instant.
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
    costCents: 57,
    causedBy: USER_YOU,
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

  // The thread between two runs. The run lifecycle puts the linkage members
  // on the BIRTH beat — `run.queued` — so the parent is named where the child is
  // created, and nowhere else: a second event announcing the link would be a second
  // record of one fact, and the projection would have to pick one. Through the shared
  // builder, which is where that rule is enforced rather than merely written down: a
  // hand-written payload here was the second copy of a shape one module owns.
  lane.transition(RUN_ARCHITECT_HELPER, {
    atMs: 2_400,
    runVersion: 1,
    newState: "queued",
    parentRunId: RUN_ARCHITECT,
    internalHelper: true,
  }),
  lane.transition(RUN_ARCHITECT_HELPER, {
    atMs: 2_450,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
];

export const CONCURRENT_STREAMING_SCENARIO_ID = "concurrent-streaming";

/**
 * How many lanes this session streams at once.
 *
 * Read off the cast rather than written as a four: the budget row, the scenario's
 * own label, and the harness assertion all mean "one lane per agent", and a literal
 * in any of them would let the cast grow while the claim stayed at its old size.
 */
export const CONCURRENT_STREAMING_LANE_COUNT: number = CONCURRENT_STREAMING_AGENTS.length;

export const CONCURRENT_STREAMING_SCENARIO: Scenario = {
  id: CONCURRENT_STREAMING_SCENARIO_ID,
  label: "Four lanes",
  purpose:
    "A live session with four agents streaming at once — interleaved turns on four run groups, an approval landing mid-stream while the other three carry on, the cost meter moving on every lane, and a helper run threaded to the turn that spawned it.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. The person first, then the agents in the order
  // they were attached — which is what a real session's join log looks like.
  userIdsInJoinOrder: [USER_YOU, AGENT_ARCHITECT, AGENT_IMPLEMENTER, AGENT_REVIEWER, AGENT_SCOUT],
  // Which of the five this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine,
  // and the two facts coincide here only because this scenario chose to make them.
  callerUserId: USER_YOU,
  startedAtIso: STARTED_AT_ISO,
  beats: composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs,
    entries: CONCURRENT_STREAMING_SCRIPT,
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
          // The display title, which is metadata a session HAPPENS to carry: no
          // registered session shape has a first-class name field, and
          // `session.created` is `.strict()` with no title member at all. So the
          // console reads one from here or renders the session by its identifier.
          metadata: { title: "Ship the ledger" },
          createdAt: STARTED_AT_ISO,
          updatedAt: "2026-01-01T14:20:02.450Z",
        },
        timelineCursors: { latest: "concurrent-streaming-cursor-45" },
      },
    },
  ],
};

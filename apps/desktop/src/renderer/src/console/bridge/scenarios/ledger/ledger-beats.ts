// What the ledger scenario's three lanes actually do, beat by beat.
//
// Split from the scenario beside it: this is the script, and `ledger.ts` is the room
// the script plays in. The two change for different reasons — a beat is added when a
// surface needs one, and the session reads change when the wire does.
//
// NAMED FOR THE BEATS AND NOT FOR THE SCRIPT, because `ledger-script.ts` beside it is
// the SHARED entry vocabulary every ledger-shaped scenario builds against. This holds
// one scenario's entries; that holds the builders they are made of.

import {
  createLedgerLaneEntries,
  ledgerOpeningEntries,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import {
  AGENT_ARCHITECT,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  CHANNEL_IMPLEMENTATION,
  LEDGER_AGENTS,
  MEMBERSHIP_PRIYA,
  PARTICIPANT_PRIYA,
  PARTICIPANT_YOU,
  RUN_ARCHITECT,
  RUN_IMPLEMENTER,
  RUN_REVIEWER,
  SESSION_ID,
} from "./ledger-cast.js";

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

export const LEDGER_SCRIPT: readonly LedgerScriptEntry[] = [
  ...ledgerOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: PARTICIPANT_YOU,
    joinedBy: PARTICIPANT_PRIYA,
    membershipId: MEMBERSHIP_PRIYA,
    joinedAtMs: 40,
    cast: LEDGER_AGENTS,
    channel: { channelId: CHANNEL_IMPLEMENTATION, name: "implementation" },
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
    channelId: CHANNEL_IMPLEMENTATION,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 412,
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 640,
    channelId: CHANNEL_IMPLEMENTATION,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_284,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 760,
    channelId: CHANNEL_IMPLEMENTATION,
    kind: "tool.invoked",
    toolName: "edit_file",
    toolCallId: "call-implementer-1",
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 900,
    channelId: CHANNEL_IMPLEMENTATION,
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

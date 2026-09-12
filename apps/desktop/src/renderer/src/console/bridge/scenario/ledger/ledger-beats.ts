// What the ledger scenario's three lanes actually do, beat by beat.
//
// Split from the scenario beside it: this is the script, and `ledger.ts` is the room
// the script plays in. The two change for different reasons — a beat is added when a
// surface needs one, and the session reads change when the wire does.
//
// NAMED FOR THE BEATS AND NOT FOR THE SCRIPT, because `ledger-script.ts` beside it is
// the SHARED entry vocabulary every ledger-shaped scenario builds against. This holds
// one scenario's entries; that holds the builders they are made of.
//
// THREE LANES AND TWO THINGS THAT ARE NOT LANES. This script also plays a CHILD RUN
// under the architect and a provider-native SUBAGENT under the reviewer — the two
// shapes the ledger folds INTO a lane rather than drawing beside one. Neither had a
// beat in any scenario, so the child-run summary and the handoff row were reachable
// from hand-written fixtures and from nothing a session could play.

import { ledgerCastMember, ledgerOpeningEntries } from "./ledger-opening-entries.js";
import { createLedgerLaneEntries, type LedgerScriptEntry } from "./ledger-script.js";
import {
  AGENT_ARCHITECT,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  CHANNEL_IMPLEMENTATION,
  LEDGER_AGENTS,
  USER_PRIYA,
  USER_YOU,
  RUNTIME_NODE,
  RUN_ARCHITECT,
  RUN_ARCHITECT_CHILD,
  RUN_IMPLEMENTER,
  RUN_REVIEWER,
  SESSION_ID,
  SUBAGENT_REVIEWER,
  attachedAtIso,
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

/**
 * The tool call the reviewer's subagent was opened under.
 *
 * Named once because four beats read it and they must agree: the invocation, its
 * settlement, and the `parentToolCallId` on each half of the subagent pair. A child
 * hung from a call nothing else in the log holds is a parent that never happened.
 */
const REVIEWER_TOOL_CALL_ID = "call-reviewer-1";

/**
 * The provider the reviewer's lane runs on, read off the cast rather than restated.
 *
 * A subagent is keyed by `(runId, provider, subagentId)`, so this has to be the same
 * string the reviewer's own attach beat carries — and the cast is where it is stated.
 */
const REVIEWER_PROVIDER = ledgerCastMember(LEDGER_AGENTS, AGENT_REVIEWER).driverName;

/** The four entry builders, with this scenario's session bound in. */
const lane = createLedgerLaneEntries(SESSION_ID);

export const LEDGER_SCRIPT: readonly LedgerScriptEntry[] = [
  ...ledgerOpeningEntries({
    sessionId: SESSION_ID,
    openedBy: USER_YOU,
    cast: LEDGER_AGENTS,
    channel: { channelId: CHANNEL_IMPLEMENTATION, name: "implementation", openedAtMs: 40 },
  }),
  {
    atMs: 280,
    kind: "user.message",
    // The author is the envelope's actor and the text is not here: user
    // prose is sealed per user in `pii_payload`, and a fixture that put the
    // words on the payload would teach a row to read a member no daemon sets.
    actorId: USER_PRIYA,
    payload: { sessionId: SESSION_ID },
  },

  // Lane one — the implementer. Born, blocked, unblocked, rewound, finished.
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_IMPLEMENTER,
    actorId: USER_YOU,
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
    actorId: USER_PRIYA,
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
    toolCallId: REVIEWER_TOOL_CALL_ID,
  }),

  // THE HANDOFF, OBSERVED TWICE. A provider-native subagent opens under the reviewer's
  // tool call and finishes inside it, both beats carrying the SAME identity — which is
  // why both are here. The ledger anchors a subagent at the first row naming it and
  // draws one handoff there; the completion joins that anchor and draws nothing of its
  // own, so one beat of the pair could never show the second was suppressed.
  lane.subagent(RUN_REVIEWER, {
    atMs: 1_300,
    kind: "subagent.started",
    provider: REVIEWER_PROVIDER,
    subagentId: SUBAGENT_REVIEWER,
    parentToolCallId: REVIEWER_TOOL_CALL_ID,
  }),
  lane.subagent(RUN_REVIEWER, {
    atMs: 1_380,
    kind: "subagent.completed",
    provider: REVIEWER_PROVIDER,
    subagentId: SUBAGENT_REVIEWER,
    parentToolCallId: REVIEWER_TOOL_CALL_ID,
  }),
  lane.tool(RUN_REVIEWER, {
    atMs: 1_420,
    kind: "tool.error",
    toolName: "run_tests",
    toolCallId: REVIEWER_TOOL_CALL_ID,
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
    actorId: USER_PRIYA,
  }),

  // Lane three — the architect, which is still mid-turn when the script ends.
  lane.transition(RUN_ARCHITECT, {
    atMs: 2_320,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    actorId: USER_YOU,
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

  // THE CHILD RUN, BORN HERE AND NOWHERE ELSE. The architect's turn opens a run of its
  // own, and this beat is the only one in the session naming both it and its parent —
  // the taxonomy puts the orchestration linkage on the birth beat, and the ledger
  // summarizes the child onto exactly the row carrying it. Everything else the summary
  // states is derived from the rows below. `producingNodeId` is stated because a child
  // run's provenance has to name the node that produced it, and a summary that cannot
  // supply one renders the absence instead — which no scenario here leaves unreached.
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_560,
    runVersion: 1,
    newState: "queued",
    agentId: AGENT_ARCHITECT,
    parentRunId: RUN_ARCHITECT,
    producingNodeId: RUNTIME_NODE,
  }),

  {
    atMs: 2_600,
    kind: "run.rolled_back",
    // `RunRolledBackEvent`'s own members (`packages/contracts/src/runControl.ts`):
    // the POST-rollback progression value, and the turn boundary the run landed
    // at — which is not the boundary row's own position, and is what the
    // superseded band above it is measured against.
    actorId: USER_YOU,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_IMPLEMENTER,
      runVersion: 6,
      targetPosition: IMPLEMENTER_REWIND_TARGET_POSITION,
    },
  },
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_620,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  }),
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_660,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  }),
  lane.output(RUN_IMPLEMENTER, {
    atMs: 2_700,
    kind: "assistant.message",
    contentType: "text/markdown",
    contentLength: 1_012,
  }),
  lane.output(RUN_ARCHITECT_CHILD, {
    atMs: 2_740,
    kind: "assistant.thinking_update",
    contentType: "text/plain",
    contentLength: 284,
  }),
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_820,
    kind: "tool.invoked",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
  }),
  {
    atMs: 2_860,
    // THE COMPACTION INSIDE THE CHILD, which makes its summary a FLOOR rather than a
    // total: rows before this one left the child's own transcript, so the count the
    // summary carries is a lower bound over a history that lost entries — the one
    // incompleteness cause a log can state on its own. The implementer's lane carries
    // the session's other compaction seam and says nothing about a child, which is
    // how a reader sees the marker is scoped to the run it landed in.
    kind: "usage.context_compacted",
    payload: { sessionId: SESSION_ID, runId: RUN_ARCHITECT_CHILD },
  },
  lane.tool(RUN_IMPLEMENTER, {
    atMs: 2_900,
    kind: "tool.result",
    toolName: "read_file",
    toolCallId: "call-implementer-2",
    durationMs: 62,
    contentLength: 2_048,
  }),
  lane.transition(RUN_ARCHITECT_CHILD, {
    atMs: 2_940,
    runVersion: 4,
    previousState: "running",
    newState: "completed",
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

  // THE OPEN ASK, and the reason it is the script's last beat. The architect lane's
  // whole job is to leave something unfinished in the frame, and a provider blocked
  // on a structured question is the one unfinished state that needs an answer FROM A
  // PERSON rather than from the daemon — so a session ending here is the composition
  // the input-ask card is measured against.
  //
  // EVERY MEMBER THE TAXONOMY MAKES REQUIRED OF A POST-AMENDMENT `requested` EMITTER
  // IS HERE: the session, the run, the ask's own id, the kind, the state — which the
  // taxonomy requires to equal the emitting type's suffix — and the stamped expiry,
  // which `requested` alone must carry. `input` is deliberately absent: the taxonomy
  // requires it on the PERMISSION arm, and this ask is an input one. `options` is the
  // additive-optional choice set, present so the card's structured arm is reachable
  // in the fixture; its free-text arm is unconditional and needs no beat to exist.
  {
    atMs: 3_140,
    kind: "driver_ask.requested",
    actorId: AGENT_ARCHITECT,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ARCHITECT,
      askId: "019b793b-7b60-7a21-9f14-6b0c2a7d0e11",
      kind: "input",
      state: "requested",
      prompt: "Which storage backend should the draft assume?",
      options: [
        { value: "sqlite", label: "The node-local SQLite database" },
        { value: "postgres", label: "The control plane's Postgres" },
      ],
      // Ten minutes past the beat, stamped by the daemon at creation and never
      // extended. Derived from the scenario's own base instant rather than written
      // as a literal, so the countdown and the beat can never disagree about when
      // the ask was raised.
      expiresAt: attachedAtIso(3_140 + 600_000),
    },
  },
];

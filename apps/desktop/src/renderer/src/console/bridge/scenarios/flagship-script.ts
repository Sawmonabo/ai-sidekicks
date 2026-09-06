// What the flagship session's four lanes actually do, beat by beat.
//
// Split from the scenario beside it: this is the script, and `flagship.ts` is the room
// the script plays in. The two change for different reasons — a beat is added when a
// surface needs one, and the session reads change when the wire does — and one file
// holding both was 584 lines, which is what `apps/desktop/AGENTS.md` puts a ceiling on.
// The two row builders this script needs left for `flagship-entries.ts` on the same
// rule, at the same seam: they say what a row of a kind LOOKS like, and this file
// says which rows play and when.

import {
  createLedgerLaneEntries,
  ledgerOpeningEntries,
  type LedgerScriptEntry,
} from "./ledger-script.js";
import {
  AGENT_ARCHITECT,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  AGENT_SCOUT,
  FLAGSHIP_AGENTS,
  MEMBERSHIP_PRIYA,
  PARTICIPANT_PRIYA,
  PARTICIPANT_YOU,
  RUN_ARCHITECT,
  RUN_ARCHITECT_HELPER,
  RUN_IMPLEMENTER,
  RUN_REVIEWER,
  RUN_SCOUT,
  SESSION_ID,
} from "./flagship-cast.js";
import {
  APPROVAL_SCOPE,
  PROVIDER_ACCOUNT_ID,
  approvalEntry,
  costUpdateEntry,
} from "./flagship-entries.js";

/** The three entry builders, with this scenario's session bound in. */
const lane = createLedgerLaneEntries(SESSION_ID);

export const FLAGSHIP_SCRIPT: readonly LedgerScriptEntry[] = [
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
    actorId: PARTICIPANT_YOU,
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
    actorId: PARTICIPANT_PRIYA,
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
    actorId: PARTICIPANT_YOU,
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
    actorId: PARTICIPANT_YOU,
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
    causedBy: PARTICIPANT_PRIYA,
  }),
  approvalEntry({
    atMs: 1_840,
    kind: "approval.approved",
    actorId: PARTICIPANT_YOU,
    members: { approver: PARTICIPANT_YOU, effectiveScope: APPROVAL_SCOPE },
  }),
  lane.transition(RUN_IMPLEMENTER, {
    atMs: 1_850,
    runVersion: 5,
    previousState: "waiting_for_approval",
    newState: "running",
    actorId: PARTICIPANT_YOU,
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

// What the flagship session's four lanes actually do, beat by beat.
//
// Split from the scenario beside it: this is the script, and `flagship.ts` is the room
// the script plays in. The two change for different reasons — a beat is added when a
// surface needs one, and the session reads change when the wire does — and one file
// holding both was 584 lines, which is what `apps/desktop/AGENTS.md` puts a ceiling on.

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
 * meter to read a shape no emitter produces, which is the defect
 * `scenarios/wire-truth.ts`' taxonomy-leg rule exists to prevent and which the code
 * leg cannot see: no strict variant is registered for this type yet.
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

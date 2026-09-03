// The four runs a list ranks, and the one a pane reads.
//
// One of the workflow fixture's four data modules; `workflow-fixture-ids.ts` carries
// the framing all four share, the phase ids this table sequences, and the version ids
// it has to agree with the definition table about.

import type { WorkflowRunSnapshot } from "../workflow-projection.js";

import {
  PHASE_BUILD,
  PHASE_DRAFT,
  PHASE_PUBLISH,
  PHASE_REVIEW,
  PHASE_SIGN_OFF,
  VERSION_INCIDENT_TRIAGE_LATEST,
  VERSION_RELEASE_CHECKS_LATEST,
  VERSION_SHIP_PIPELINE_LATEST,
  VERSION_SHIP_PIPELINE_PINNED,
  WORKFLOWS_SESSION_ID,
} from "./workflow-fixture-ids.js";

const RUN_WORKING = "019b7a10-0280-7b33-8100-4011115a0001";
const RUN_PARKED = "019b7a10-0280-7b33-8100-4011115a0002";
const RUN_CANCELLED = "019b7a10-0280-7b33-8100-4011115a0003";
const RUN_FROZEN_PIN = "019b7a10-0280-7b33-8100-4011115a0004";

/**
 * The provider account the one SCHEDULED park in this table is parked against.
 *
 * The key travels with the armed resume instant and never without it — the registered
 * shape gives `parkAttentionKey` the same presence rule as `autoResumeAt`, because
 * both are armed by the park and cleared on exit. A second park carrying the key
 * while omitting the instant would be a response no daemon can build: the fold would
 * have two entries to group and one of them would exist nowhere on the wire.
 *
 * So the fold's multi-park arm is unreachable from this fixture, and that is a real
 * cost paid on purpose. The alternative was arming a resume on the unscheduled
 * usage-limit park below, which would have contradicted that park's own cause
 * sentence — the provider reported no reset boundary — and left the console with no
 * subject at all for the park a banner must read as awaiting a run control rather
 * than as scheduled.
 */
const PARK_ATTENTION_KEY = "019b7a10-0280-7f55-8100-acc0117a0001";

/**
 * The parked run, declared on its own because two readers need exactly it.
 *
 * `workflow.runRead` addresses one run and answers with this one, while the table
 * below carries it as its second member — so a positional index would be the one
 * place the pane's run and the list's run could come apart. Named once, spread in
 * once, and the two cannot disagree.
 */
export const WORKFLOWS_PARKED_RUN: WorkflowRunSnapshot = {
  workflowRunId: RUN_PARKED,
  sessionId: WORKFLOWS_SESSION_ID,
  workflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
  state: "suspended",
  startedAt: "2026-01-01T09:31:00.000Z",
  phaseStates: [
    {
      phaseId: PHASE_DRAFT,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150003",
      attemptNumber: 1,
      state: "completed",
      gateState: "open",
    },
    {
      phaseId: PHASE_BUILD,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150004",
      attemptNumber: 1,
      // `running` and parked at once, which is what the five-value union is kept
      // coarse for: the phase-run status carries no suspended arm, and the park
      // rides the members below it.
      state: "running",
      gateState: "closed",
      parkReason: "provider-usage-limited",
      parkCause:
        "The provider account reached its five-hour usage window. The next window opens at 10:45 UTC.",
      autoResumeAt: "2026-01-01T10:45:00.000Z",
      parkAttentionKey: PARK_ATTENTION_KEY,
    },
    {
      phaseId: PHASE_SIGN_OFF,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
      attemptNumber: 1,
      state: "running",
      gateState: "closed",
      // Zero rather than absent: this is a human phase whose attempt has no
      // accepted submission yet, which is what the optimistic-concurrency token
      // counts. Absent would mean an older daemon, not an unanswered form.
      formRevision: 0,
      parkReason: "waiting-human",
      parkCause: "Waiting on a release sign-off from a person before the publish phase runs.",
      // No `autoResumeAt` and no attention key. Nothing armed a resume, so nothing
      // shows a countdown, and a park with no provider account has nothing for the
      // provider-account fold to fold it with.
    },
    { phaseId: PHASE_PUBLISH, state: "pending", gateState: "closed" },
  ],
};

/**
 * The four runs, as `workflow.runRead` projects one of them and the scenario's
 * scripted enumeration holds all four.
 *
 * THE PARK MEMBERS ARE LIVE-SCOPED, and this table is written to that rule rather than
 * around it. A daemon emits `parkReason`, `parkCause`, `autoResumeAt`, and
 * `parkAttentionKey` for exactly the phases parked at the moment the response was
 * built and emits none of them for a phase that is not — so the cancelled run carries
 * no park member anywhere, even though a phase in it was parked once. "Why was this
 * parked" is a timeline question, answered from the suspension event rather than from
 * a stale member on a settled run.
 *
 * WHAT THE FOUR ARE FOR. Each is the only source of a fact the surfaces read:
 *
 *   1. Working — running, nothing parked. The band the list has to keep BELOW the
 *      parked band, so the ordering rule is observable rather than asserted.
 *   2. Parked — suspended, with two park kinds at once: a `provider-usage-limited`
 *      park the engine armed a resume for, and a `waiting-human` park it did not. One
 *      run therefore drives the countdown arm and the awaiting-resume arm together,
 *      which is the pair a banner most easily conflates.
 *   3. Cancelled — the cancellation reason on `failureReason` where the contract puts
 *      it, and its completed phase's outputs still addressable.
 *   4. Frozen pin — suspended and pinned to `Ship pipeline` version 1 while that
 *      definition's latest is version 3. Its park is the unscheduled usage-limit one:
 *      no reset boundary was reported, so it arms neither of the two members a park
 *      arms together and a banner has to read it as awaiting a run control.
 *
 * EVERY RUN STARTS AFTER THE SESSION DOES. A run is owned by the session it belongs
 * to, so no instant in this table precedes the creation beat in `scenarios/workflows.ts`
 * — the ordering that scenario's header states and its suite holds.
 *
 * WHAT THIS TABLE CANNOT SAY. A phase's readable NAME. `WorkflowPhaseState` carries
 * `phaseId` and no name, and neither the run read nor the definition enumeration
 * carries one — the name lives in the definition BODY that `workflow.versionRead`
 * serves, which is one of the four registered workflow methods the growth row does
 * not carry. A surface needing a phase name today has an id and an honest absence.
 */
export const WORKFLOWS_SCENARIO_RUNS: readonly WorkflowRunSnapshot[] = [
  {
    workflowRunId: RUN_WORKING,
    sessionId: WORKFLOWS_SESSION_ID,
    workflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
    state: "running",
    startedAt: "2026-01-01T09:52:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150001",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150002",
        // A second attempt, so a retry reads as a sub-entry rather than as the only
        // attempt there ever was. The per-phase retry bound is three by default.
        attemptNumber: 2,
        state: "running",
        gateState: "closed",
      },
      { phaseId: PHASE_REVIEW, state: "pending", gateState: "closed" },
    ],
  },
  WORKFLOWS_PARKED_RUN,
  {
    workflowRunId: RUN_CANCELLED,
    sessionId: WORKFLOWS_SESSION_ID,
    workflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
    state: "cancelled",
    // The cancellation reason travels on `failureReason` — the contract's own split,
    // where that member is preserved on any bound breach AND carries the reason a
    // cancel supplied. A second member for it would be the console inventing one.
    failureReason: "Cancelled: the incident was resolved out of band.",
    startedAt: "2026-01-01T08:47:00.000Z",
    endedAt: "2026-01-01T09:04:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150006",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      // Skipped rather than failed: a cancel stops what has not started rather than
      // failing it, and the two read very differently to somebody scanning a run
      // that will not move again.
      { phaseId: PHASE_REVIEW, state: "skipped", gateState: "closed" },
    ],
  },
  {
    workflowRunId: RUN_FROZEN_PIN,
    sessionId: WORKFLOWS_SESSION_ID,
    // Version 1 of `Ship pipeline`, whose latest above is version 3. The
    // frozen-definition state is exactly that inequality and nothing else.
    workflowVersionId: VERSION_SHIP_PIPELINE_PINNED,
    state: "suspended",
    startedAt: "2026-01-01T07:12:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150007",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150008",
        attemptNumber: 3,
        state: "running",
        gateState: "closed",
        parkReason: "provider-usage-limited",
        parkCause:
          "The provider account reached its weekly usage window. No reset boundary was reported, so no resume is scheduled.",
        // Deliberately no `autoResumeAt`, and therefore no `parkAttentionKey` either.
        // A usage-limit park with no armed instant is the case a banner must read as
        // parked awaiting resume rather than as scheduled — a client that invented a
        // time here would be the display half of a guess the engine refused to make.
        // The two members are armed together and cleared together, so a row carrying
        // the key alone would be a response the daemon has no state to produce, and a
        // screenshot of it would pin a picture of an impossible run.
      },
    ],
  },
];

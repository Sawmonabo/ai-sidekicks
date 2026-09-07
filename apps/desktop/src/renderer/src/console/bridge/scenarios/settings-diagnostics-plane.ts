// The diagnostics page's half of the settings scenario: the two runs it addresses,
// and the five health reads it answers.
//
// Split out of `settings.ts` on `settings-runtime-nodes.ts`' rule — that module says
// what a person does and in what order, and this says what the daemon answers while
// they do it. Two data tables and a beat builder are what pushed that file past the
// point where either end of it could be read.

import type { ScenarioBeat, ScenarioReply } from "../scenario-runtime/index.js";
import { SESSION_ID, occurredAt } from "./settings-runtime-nodes.js";

/**
 * The two runs the diagnostics page addresses, and why there are two.
 *
 * That page puts one question to a run that is still MOVING — has it stalled? — and a
 * different one to a run that has FAILED — what failed? Only a live run can have
 * stopped moving and only a failed run has a failure to detail, so a scenario with one
 * run could reach only one of the two regions. These are the runs its subject resolver
 * picks: the newest-touched live run and the newest-touched failed one.
 *
 * The stalled run is also the one the recovery prompt is offered for, so its id is what
 * the receipt beat below reports on.
 */
export const STALLED_RUN_ID = "019b7892-2d00-7ea1-8110-cca0117a0602";
export const FAILED_RUN_ID = "019b7892-2d00-7ea1-8110-cca0117a0603";

/**
 * The instant the stalled run last made progress, and why it predates every beat here.
 *
 * The stall badge escalates its presentation once a run has been quiet for five
 * minutes, and this scenario's whole clock spans half a second — so a progress stamp
 * inside the scenario's own span could only ever reach the quietest tier, and the tier
 * a reviewer most needs to see would be reachable from no deck entry at all. The node
 * is answering about a run it has been watching since before this window subscribed,
 * which is the ordinary case rather than a contrivance: `health.stuckRunInspect` reads
 * the node's own record and does not start when a console starts looking.
 */
const LAST_PROGRESS_AT = "2026-01-01T07:53:30.000Z";

/**
 * One run transition, as a row rather than a hand-written beat.
 *
 * A table because the seven beats below differ only in five values and a reader
 * checking that the progression counter advances with the state should be reading a
 * column rather than seven payloads. The `kind` is composed from `newState`, which is
 * what keeps a row from ever announcing one state and carrying another — the defect
 * the wire-truth run-beat leg exists to catch.
 */
interface SettingsRunTransition {
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly atMs: number;
  readonly runVersion: number;
  readonly previousState: string | undefined;
  readonly newState: "queued" | "starting" | "running" | "failed";
}

const RUN_TRANSITIONS: readonly SettingsRunTransition[] = [
  {
    runId: STALLED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0610",
    sequence: 9,
    atMs: 340,
    runVersion: 1,
    previousState: undefined,
    newState: "queued",
  },
  {
    runId: STALLED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0611",
    sequence: 10,
    atMs: 350,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  },
  {
    runId: STALLED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0612",
    sequence: 11,
    atMs: 360,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  },
  {
    runId: FAILED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0613",
    sequence: 12,
    atMs: 365,
    runVersion: 1,
    previousState: undefined,
    newState: "queued",
  },
  {
    runId: FAILED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0614",
    sequence: 13,
    atMs: 370,
    runVersion: 2,
    previousState: "queued",
    newState: "starting",
  },
  {
    runId: FAILED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0615",
    sequence: 14,
    atMs: 375,
    runVersion: 3,
    previousState: "starting",
    newState: "running",
  },
  {
    runId: FAILED_RUN_ID,
    eventId: "019b7892-2d00-7ea1-8110-cca0117a0616",
    sequence: 15,
    atMs: 380,
    runVersion: 4,
    previousState: "running",
    newState: "failed",
  },
];

/**
 * The two runs' transitions, as scenario beats.
 *
 * Born after the last node transition so the sequence stays monotonic with the clock,
 * and before the outage at 400 so the reconnect finds both readings already on screen.
 *
 * They exist for one reason: the diagnostics page's two run-scoped reads are addressed
 * from the session's own run partition, so a scenario with no run reaches only the
 * "nothing was asked" arm of each. One run is left MOVING and one is taken to `failed`,
 * which is the pair those two reads need — and the pair is also what makes the page's
 * own claim legible, that a stall question and a failure question are about different
 * runs.
 */
export const SETTINGS_DIAGNOSTICS_RUN_BEATS: readonly ScenarioBeat[] = RUN_TRANSITIONS.map(
  (transition) => ({
    atMs: transition.atMs,
    event: {
      id: transition.eventId,
      sessionId: SESSION_ID,
      sequence: transition.sequence,
      kind: `run.${transition.newState}`,
      occurredAt: occurredAt(transition.atMs),
      // No actor on any of them. `queued` here is a run this node picked up rather
      // than one a participant started from this window, and every later transition
      // is the daemon moving its own aggregate — a participant id on either would
      // attribute a system transition to a person.
      payload: {
        sessionId: SESSION_ID,
        runId: transition.runId,
        runVersion: transition.runVersion,
        // Absent on the birth transition and only there: a queued run has no state
        // it came from, and no document names a value for one.
        ...(transition.previousState === undefined
          ? {}
          : { previousState: transition.previousState }),
        newState: transition.newState,
      },
    },
  }),
);

/**
 * THE FIVE DIAGNOSTICS READS, SCRIPTED SO EVERY REGION OF THAT PAGE HAS A STATE.
 *
 * The page is the one settings surface whose whole content is a health reading,
 * and every one of its regions was previously reachable only in its absence. What
 * is scripted here is the interesting half of each: a machine that is DEGRADED
 * rather than healthy, a run the daemon SUSPECTS is stuck rather than one that is
 * fine, a classified failure rather than a generic one, and a retention override
 * IN FORCE rather than the default posture — because the calm arms are what the
 * unscripted fallbacks already answer, and a deck that scripted them too would
 * make the alarming states unreachable in the one place they are reviewed.
 *
 * The latency is deliberate and small: each read's loading state is a real frame
 * a person sees, and a reply that resolved on the same tick as the call would let
 * the page ship without anyone having drawn it.
 */
export const SETTINGS_DIAGNOSTICS_REPLIES: readonly ScenarioReply[] = [
  {
    call: "health.statusRead",
    afterMs: 40,
    result: {
      overall: "degraded",
      components: [
        {
          name: "daemon",
          state: "healthy",
          lastChecked: "2026-01-01T07:59:50.000Z",
        },
        {
          name: "provider",
          state: "degraded",
          lastChecked: "2026-01-01T07:59:50.000Z",
          details: { reason: "the provider answered two of the last ten requests slowly" },
        },
        {
          name: "replay",
          state: "blocked",
          lastChecked: "2026-01-01T07:59:20.000Z",
        },
      ],
    },
  },
  {
    call: "health.stuckRunInspect",
    afterMs: 40,
    result: {
      runId: STALLED_RUN_ID,
      currentState: "running",
      lastProgressAt: LAST_PROGRESS_AT,
      lastEventTime: LAST_PROGRESS_AT,
      blockingReason: "the provider has not written a frame since the last tool result",
      healthSignal: "stuck-suspected",
      suggestedAction: "interrupt",
    },
  },
  {
    call: "health.failureDetailRead",
    afterMs: 40,
    result: {
      runId: FAILED_RUN_ID,
      failureCategory: "provider failure",
      recoveryCondition: "provider_unavailable",
      humanSummary: "The provider closed the connection while the turn was in flight.",
      technicalDetails: { attempts: 2, lastStatus: 503 },
      occurredAt: "2026-01-01T07:56:20.000Z",
    },
  },
  {
    call: "health.recoveryActionRequest",
    afterMs: 60,
    result: {
      runId: STALLED_RUN_ID,
      previousState: "running",
      newState: "interrupted",
      actionTaken: "interrupt",
    },
  },
  {
    call: "health.redactionPolicyRead",
    afterMs: 40,
    result: {
      buckets: [
        { bucket: "driver_raw_events", ttlDays: 7, rawContentOptIn: false },
        { bucket: "command_output", ttlDays: 7, rawContentOptIn: false },
        { bucket: "tool_traces", ttlDays: 45, rawContentOptIn: true },
        { bucket: "reasoning_detail", ttlDays: 7, rawContentOptIn: false },
      ],
      outboundDefault: "deny",
      retentionPolicyOverrideActive: true,
    },
  },
];

// The RUN-RECORD plane: the two durable projections a run's surfaces read, and the
// rule that decides when each may answer at all.
//
// WHY THIS PLANE HAS A MODULE. `settings/diagnostics-reads.ts` states the
// shape — a plane whose answers need reasoning of their own leaves the port and takes
// its served ids with it, so the ids and the handlers stay one set with one home.
//
// WHY THE TWO READS ANSWER DIFFERENTLY, WHICH IS THE WHOLE OF WHAT A READER NEEDS
//
// The queue binding read is SESSION-addressed and its empty form is a real daemon
// answer: no queued row in this session is bound to a run. So it serves for the
// scenario it is playing, and serves an empty binding list for any other session,
// which says the operation ran and found nothing rather than that nobody asked.
//
// The intervention history read is RUN-addressed, and an empty list for a run the
// scenario says nothing about would assert that the run exists and has never been
// intervened on — the `healthFailureDetailRead` shape exactly. So it REFUSES for a run
// this scenario declares no record for, and the history's own "not checked" absence is
// then a true statement rather than a placeholder.
//
// The live bridge keeps refusing both, so nothing a release build renders moves.

import { growthUnavailable } from "../../growth-port/index.js";
import {
  RUNS_INTERVENTION_RECORDS,
  RUNS_QUEUE_RUN_BINDINGS,
} from "../../scenarios/runs.run-records.js";
import type { GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/scenario-engine.js";
import type {
  GrowthInterventionRecord,
  GrowthQueueItemRunBinding,
} from "../../wire-shapes/index.js";

/**
 * The two run-record operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS`' rule: the ids and the implementations
 * below are one set with one home.
 */
export const FIXTURE_SERVED_RUN_RECORD_OPERATION_IDS = [
  "runRecordInterventionHistoryRead",
  "runRecordQueueRunBindingRead",
] as const;

/** One run-record operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedRunRecordOperationId =
  (typeof FIXTURE_SERVED_RUN_RECORD_OPERATION_IDS)[number];

/**
 * The fixture's two run-record answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureDiagnosticsReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureRunRecordReads(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedRunRecordOperationId> {
  return {
    runRecordInterventionHistoryRead: async (request) => {
      const records = scenarioInterventionRecords(engine, request.runId);
      return records === undefined
        ? growthUnavailable("runRecordInterventionHistoryRead")
        : { status: "served", value: { records } };
    },
    runRecordQueueRunBindingRead: async (request) => ({
      status: "served",
      value: {
        bindings:
          request.sessionId === engine.scenario.sessionId
            ? scenarioQueueRunBindings(engine)
            : // A session this fixture is not playing has no queue here, and no binding
              // is the true answer rather than a refusal: the operation IS served, and
              // what it found for that session is nothing.
              [],
      },
    }),
  };
}

/**
 * This scenario's record for one run, or `undefined` where it declares none.
 *
 * The scenario's own table filtered by the run asked about, so a scenario that grows a
 * second run gets its own rows without this seam changing. `undefined` and not an
 * empty array: the two are the difference between "this fixture says nothing about
 * that run" and "that run has never been intervened on", and the caller above turns
 * exactly one of them into a refusal.
 */
function scenarioInterventionRecords(
  engine: ScenarioEngine,
  runId: string,
): readonly GrowthInterventionRecord[] | undefined {
  if (engine.scenario.id !== RUN_RECORD_SCENARIO_ID) {
    return undefined;
  }
  const records = RUNS_INTERVENTION_RECORDS.filter((record) => record.runId === runId);
  return records.length === 0 ? undefined : records;
}

/** This scenario's queue bindings, and none for a scenario that declares no table. */
function scenarioQueueRunBindings(engine: ScenarioEngine): readonly GrowthQueueItemRunBinding[] {
  return engine.scenario.id === RUN_RECORD_SCENARIO_ID ? RUNS_QUEUE_RUN_BINDINGS : [];
}

/**
 * The one scenario that declares durable run records.
 *
 * Keyed on the scenario rather than on its session id, because that is what the tables
 * are attached to: a second scenario adopting them adds its id here, and every other
 * scenario keeps the honest answers above — a refusal for a run whose record nobody
 * wrote, and no bindings for a queue nobody bound.
 */
const RUN_RECORD_SCENARIO_ID = "runs";

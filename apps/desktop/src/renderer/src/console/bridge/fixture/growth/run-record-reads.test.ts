// The run-record plane's two answering rules, driven through the real fixture bridge.
//
// The suite beside `run-record-reads.ts`, and it earns its place on the one
// property the plane exists to hold: the two reads answer DIFFERENTLY for a subject no
// scenario declares. The queue binding read serves an empty list, because "no queued
// row here is bound" is a real daemon answer; the intervention history read refuses,
// because an empty list for an unknown run would assert that the run exists and has
// never been intervened on.
//
// Each case is another's negative control. A plane that had lost its scenario routing
// would answer the same way everywhere, and the two arms below cannot both pass under
// that plane.

import { describe, expect, it } from "vitest";

import { createFixture } from "../call-plane/bridge.test-support.js";
import { servedValueOf } from "./growth-port.test-support.js";
import { ONBOARDING_SCENARIO } from "../../scenario/onboarding.js";
import { RUNS_SCENARIO } from "../../scenario/runs/runs.js";
import { RUN_ID } from "../../scenario/runs/identifiers.js";
import { RUNS_INTERVENTION_RECORDS } from "../../scenario/runs/run-records.js";

/** A run no scenario in the tree declares a durable record for. */
const UNDECLARED_RUN_ID = "019b7a22-2200-740e-8110-d1a4c11504ff";

describe("the run's durable intervention record", () => {
  it("serves every row the scenario declares for the run it is asked about", async () => {
    const fixture = createFixture(RUNS_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordInterventionHistoryRead({
      runId: RUN_ID,
    });

    const value = servedValueOf(outcome);
    expect(value.records.map((record) => record.interventionId)).toStrictEqual(
      RUNS_INTERVENTION_RECORDS.map((record) => record.interventionId),
    );
  });

  it("carries the origin arm the daemon resolved, principal and all", async () => {
    const fixture = createFixture(RUNS_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordInterventionHistoryRead({
      runId: RUN_ID,
    });

    const value = servedValueOf(outcome);
    // The principal is present exactly on the participant arm and the system arm
    // carries none — the requiredness rule the union encodes, checked against the rows
    // rather than against the type that admits them.
    const origins = value.records.map((record) => record.origin);
    expect(origins.filter((origin) => origin.kind === "system")).toHaveLength(1);
    for (const origin of origins) {
      if (origin.kind === "participant") {
        expect(origin.admittingPrincipalId).not.toBe("");
      }
    }
  });

  it("refuses for a run this scenario declares no record for", async () => {
    const fixture = createFixture(RUNS_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordInterventionHistoryRead({
      runId: UNDECLARED_RUN_ID,
    });

    // NOT an empty list. An empty record for an unknown run would say the run exists
    // and has never been intervened on, which is a claim no scenario made.
    expect(outcome.status).not.toBe("served");
  });

  it("negative control: a scenario declaring no records refuses its own run too", async () => {
    const fixture = createFixture(ONBOARDING_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordInterventionHistoryRead({
      runId: RUN_ID,
    });

    expect(outcome.status).not.toBe("served");
  });
});

describe("the queue's run bindings", () => {
  it("names the run each bound row is bound to, and omits the unbound one", async () => {
    const fixture = createFixture(RUNS_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordQueueRunBindingRead({
      sessionId: RUNS_SCENARIO.sessionId,
    });

    const value = servedValueOf(outcome);
    expect(value.bindings).toHaveLength(2);
    for (const binding of value.bindings) {
      expect(binding.targetRunId).toBe(RUN_ID);
    }
  });

  it("serves an empty list for a session it is not playing, rather than refusing", async () => {
    const fixture = createFixture(RUNS_SCENARIO);

    const outcome = await fixture.bridge.growth.runRecordQueueRunBindingRead({
      sessionId: ONBOARDING_SCENARIO.sessionId,
    });

    // The operation IS served, and what it found for that session is nothing — which
    // is the difference this plane exists to keep from collapsing.
    expect(servedValueOf(outcome).bindings).toStrictEqual([]);
  });
});

// Comparand reconciliation in both directions: the answer leads after a native steer and the
// projection leads after an ordinary progression, so the newer wins. Either direction wrong
// looks like "steering stopped working" with no other symptom.
import { describe, expect, it } from "vitest";

import { AnsweredRunVersions } from "./answered-run-versions.js";

const RUN_ID = "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e";
const OTHER_RUN_ID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";

describe("AnsweredRunVersions — the newer of the two readings", () => {
  it("answers the projection alone while nothing has been recorded", () => {
    expect(new AnsweredRunVersions().comparandFor(RUN_ID, 7)).toBe(7);
  });

  it("answers the recorded version where it leads the projection", () => {
    // An applied native steer moves the run version with no state event, so only the answer
    // is fresh.
    const ledger = new AnsweredRunVersions();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, 7)).toBe(8);
  });

  it("negative control: answers the projection where the projection leads", () => {
    // The run advances through its state stream with no steer; preferring the recorded
    // answer would pin every later call to the last settlement's version.
    const ledger = new AnsweredRunVersions();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, 40)).toBe(40);
  });

  it("answers the recorded version where the store has projected none", () => {
    const ledger = new AnsweredRunVersions();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, undefined)).toBe(8);
  });

  it("invents nothing for a run with neither reading", () => {
    // The caller then refuses to dispatch: a zero would be a guard the console invented.
    expect(new AnsweredRunVersions().comparandFor(RUN_ID, undefined)).toBeUndefined();
  });

  it("never walks a run's comparand backwards", () => {
    // Two interventions can settle out of order; the counter is monotonic per run.
    const ledger = new AnsweredRunVersions();
    ledger.record(RUN_ID, 12);
    ledger.record(RUN_ID, 9);
    expect(ledger.comparandFor(RUN_ID, undefined)).toBe(12);
  });

  it("keeps each run's comparand under its own key", () => {
    const ledger = new AnsweredRunVersions();
    ledger.record(RUN_ID, 12);
    expect(ledger.comparandFor(OTHER_RUN_ID, 3)).toBe(3);
  });
});

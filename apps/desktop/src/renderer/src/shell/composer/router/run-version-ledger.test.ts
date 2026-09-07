// The comparand reconciliation, asserted in both directions.
//
// The rule is not "keep the answer" and not "trust the projection" — it is that
// each of the two leads the other in a different situation, so the newer wins. A
// ledger that got either direction wrong would be silent: one pins every later steer
// to a stale version and the daemon refuses it, the other never advances past the
// projection and the daemon refuses that. Both look like "steering stopped working".

import { describe, expect, it } from "vitest";

import { RunVersionLedger } from "./run-version-ledger.js";

const RUN_ID = "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e";
const OTHER_RUN_ID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";

describe("RunVersionLedger — the newer of the two readings", () => {
  it("answers the projection alone while nothing has been recorded", () => {
    expect(new RunVersionLedger().comparandFor(RUN_ID, 7)).toBe(7);
  });

  it("answers the recorded version where it leads the projection", () => {
    // The applied native steer: the run version moved and no state event carried it,
    // so the projection is behind and the answer is the only fresh reading.
    const ledger = new RunVersionLedger();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, 7)).toBe(8);
  });

  it("negative control: answers the projection where the projection leads", () => {
    // The run advances through its own state stream with no control pressed. A
    // ledger that preferred what it had recorded would pin every later call to the
    // version its last settlement saw, and a refusal carries no way back.
    const ledger = new RunVersionLedger();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, 40)).toBe(40);
  });

  it("answers the recorded version where the store has projected none", () => {
    const ledger = new RunVersionLedger();
    ledger.record(RUN_ID, 8);
    expect(ledger.comparandFor(RUN_ID, undefined)).toBe(8);
  });

  it("invents nothing for a run with neither reading", () => {
    // The caller then refuses to dispatch. A zero here would be a stale-replay guard
    // the console supplied instead of one the daemon verified.
    expect(new RunVersionLedger().comparandFor(RUN_ID, undefined)).toBeUndefined();
  });

  it("never walks a run's comparand backwards", () => {
    // Two interventions can settle out of order. The counter is monotonic per run,
    // so the older answer is the stale one wherever they disagree.
    const ledger = new RunVersionLedger();
    ledger.record(RUN_ID, 12);
    ledger.record(RUN_ID, 9);
    expect(ledger.comparandFor(RUN_ID, undefined)).toBe(12);
  });

  it("keeps each run's comparand under its own key", () => {
    const ledger = new RunVersionLedger();
    ledger.record(RUN_ID, 12);
    expect(ledger.comparandFor(OTHER_RUN_ID, 3)).toBe(3);
  });
});

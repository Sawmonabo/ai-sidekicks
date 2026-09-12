// The four structural guards, read off the daemon's own closed discriminator.
//
// The table is a `Record` over `RollbackCompositeRejectionGuard`, so exhaustiveness
// is a compile-time property rather than something a case can assert. What the cases
// below are for is the half a type cannot state: that each guard's words are its own,
// that two of the four name an ACT rather than a rewording of the refusal, and that a
// rejection the wire attributed to no guard is answered with nothing.
//
// What is gone from this suite, deliberately: every case about recognising a guard
// inside `rejectionReason`. That member is a free-form wire string with no vocabulary
// any contract publishes, so those cases were pinning a match against a value set
// that does not exist — and both failure modes they documented (a typed guard beside
// an unrecognised cause, and a cause naming two guards) are unreachable over a closed
// discriminator.

import { describe, expect, it } from "vitest";
import type { RollbackCompositeRejectionGuard } from "@ai-sidekicks/contracts";

import { compositeGuardReading } from "./composite-guard.js";

/**
 * The guards this suite iterates, held to the contract at COMPILE time.
 *
 * A bare list would go stale silently the day a fifth guard is registered — the one event
 * these cases most need to notice — and the exported schema cannot stand in for one here:
 * a console module never imports a contracts SCHEMA (enforced by
 * `no-restricted-imports`), and this suite is a console module. So the keys are a
 * `Record` over the union itself, which is total in both directions without a runtime
 * read: a guard added to the union leaves a key missing, and a guard renamed leaves one
 * missing and one excess. Neither is left to a reader remembering to update a list.
 */
const GUARD_COVERAGE: Readonly<Record<RollbackCompositeRejectionGuard, true>> = {
  "no-active-turn": true,
  "no-pending-send": true,
  "participant-authored-target": true,
  "resumable-target": true,
};

const REGISTERED_GUARDS = Object.keys(GUARD_COVERAGE) as readonly RollbackCompositeRejectionGuard[];

describe("every registered guard has its own words and its own move", () => {
  it("covers the four the contract registers", () => {
    // Vacuity guard for every case below: they all iterate this list, and a run over
    // an empty one would report as a clean pass.
    expect(REGISTERED_GUARDS).toHaveLength(4);
  });

  it("answers a reading for each one, naming that guard back", () => {
    for (const guard of REGISTERED_GUARDS) {
      expect(compositeGuardReading(guard)?.guard).toBe(guard);
    }
  });

  it("gives each guard distinct words, so four refusals never read as one", () => {
    const readings = REGISTERED_GUARDS.map((guard) => compositeGuardReading(guard));

    expect(new Set(readings.map((reading) => reading?.remedy)).size).toBe(4);
    expect(new Set(readings.map((reading) => reading?.refused)).size).toBe(4);
    for (const reading of readings) {
      expect(reading?.refused.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("names the pending-send remedy as an act, since nothing in the form can clear it", () => {
    const reading = compositeGuardReading("no-pending-send");

    expect(reading?.remedy).toContain("Cancel the queued items");
    expect(reading?.remedy).toContain("drain");
  });

  it("names the live-turn remedy as an act too", () => {
    expect(compositeGuardReading("no-active-turn")?.remedy).toContain("Pause or stop the run");
  });

  it("negative control: a rejection carrying no guard gets no reading", () => {
    // The honest answer for every other refusal family — a bare rollback's
    // `driver.capability_unsupported` among them. Inventing a nearest guard would be
    // the console telling a person to drain a queue that has nothing in it.
    expect(compositeGuardReading(undefined)).toBeUndefined();
  });
});

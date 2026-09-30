// The WebGL context ledger: arithmetic over leases, needing no emulator or DOM. Chromium drops
// the oldest context past its limit, which is what the cap protects.
//
// Churn cases: a disposed `WebglAddon` leaves its context behind, so the cap is checked against
// contexts created, not terminals drawing. Duplicate-pane cases: two panes on one session build
// two contexts, so the lease and not the terminal id is the unit; a ledger keyed on the id let
// either teardown retire the other's record and walked past the cap.

import { describe, expect, it } from "vitest";
import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";

/** A granted lease; the ledger answers `undefined` past its cap, which a case must not carry on. */
function grantedLease(pool: TerminalRendererPool, terminalId: string): TerminalContextLease {
  const lease = pool.acquire(terminalId);
  if (lease === undefined) {
    throw new Error(`the ledger refused a context for ${terminalId}`);
  }
  return lease;
}

describe("the renderer pool", () => {
  it("retires the lease it was handed and leaves the sibling drawing", () => {
    const pool = new TerminalRendererPool(4);
    const first = grantedLease(pool, "a");
    grantedLease(pool, "a");

    pool.release(first);

    // One pane closed, the other still on a live context: a ledger keyed on the id deleted
    // the one record both shared.
    expect(pool.heldContextCount).toBe(1);
    expect(pool.heldContextCountFor("a")).toBe(1);
    expect(pool.holds("a")).toBe(true);
    // And the allowance stays spent, because releasing is not reclaiming.
    expect(pool.createdContextCount).toBe(2);
  });

  it("trips on the Nth context however the terminal ids fall", () => {
    // Same cap and context count, distributed differently over terminal ids: the ledger
    // refuses at the same place in both.
    const acrossOneTerminal = new TerminalRendererPool(2);
    grantedLease(acrossOneTerminal, "shared-session");
    grantedLease(acrossOneTerminal, "shared-session");
    expect(acrossOneTerminal.isExhausted).toBe(true);
    expect(acrossOneTerminal.acquire("shared-session")).toBeUndefined();
    expect(acrossOneTerminal.acquire("another-session")).toBeUndefined();

    const acrossTwoTerminals = new TerminalRendererPool(2);
    grantedLease(acrossTwoTerminals, "session-one");
    grantedLease(acrossTwoTerminals, "session-two");
    expect(acrossTwoTerminals.isExhausted).toBe(true);
    expect(acrossTwoTerminals.acquire("session-three")).toBeUndefined();
  });
});

describe("the ledger counts contexts created, not terminals drawing", () => {
  /** A working day of opening and closing the pane, against a ledger of that size. */
  const CHURN_CYCLES = 12;

  it("does not hand a disposed terminal's context back", () => {
    const pool = new TerminalRendererPool(CHURN_CYCLES);
    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      pool.release(grantedLease(pool, `churn-${String(cycle)}`));
    }
    // Nothing is drawing, yet twelve contexts were created: the thirteenth pane opens on DOM
    // rather than take one from a terminal still on screen.
    expect(pool.heldContextCount).toBe(0);
    expect(pool.createdContextCount).toBe(CHURN_CYCLES);
    expect(pool.isExhausted).toBe(true);
    expect(pool.acquire("one-cycle-too-many")).toBeUndefined();
  });

  it("reclaims idempotently, and never below zero", () => {
    // Both teardown arms can run twice; a ledger that went negative would widen the allowance.
    const pool = new TerminalRendererPool(2);
    const lease = grantedLease(pool, "a");
    pool.reclaim(lease);
    pool.reclaim(lease);
    pool.reclaim({ terminalId: "never-held" });
    expect(pool.createdContextCount).toBe(0);
    expect(pool.heldContextCount).toBe(0);
  });
});

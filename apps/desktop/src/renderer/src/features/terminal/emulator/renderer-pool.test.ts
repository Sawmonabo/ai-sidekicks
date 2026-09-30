// The WebGL context ledger on its own: arithmetic over leases, needing no emulator or DOM.
// The cases that need an adapter live in `xterm-adapter.test.ts`.
//
// Churn cases: a disposed `WebglAddon` leaves its context behind, so the cap is checked against
// contexts created, not terminals drawing. Duplicate-pane cases: two panes on one session build
// two contexts, so the lease and not the terminal id is the unit; a ledger keyed on the id let
// either teardown retire the other's record and walked past the cap.

import { describe, expect, it } from "vitest";

import { TERMINAL_WEBGL_POOL_CAP } from "../terminal-caps.js";
import {
  TerminalRendererPool,
  terminalRendererPool,
  type TerminalContextLease,
} from "./renderer-pool.js";

/** A granted lease; the ledger answers `undefined` past its cap, which a case must not carry on. */
function grantedLease(pool: TerminalRendererPool, terminalId: string): TerminalContextLease {
  const lease = pool.acquire(terminalId);
  if (lease === undefined) {
    throw new Error(`the ledger refused a context for ${terminalId}`);
  }
  return lease;
}

describe("the renderer pool", () => {
  it("mints one lease per context, and counts every one of them", () => {
    const pool = new TerminalRendererPool(2);
    const first = grantedLease(pool, "a");
    const second = grantedLease(pool, "a");
    // Two panes on one session are two addons and two contexts; an idempotent second
    // acquisition would report one while the page held two.
    expect(second).not.toBe(first);
    expect(pool.heldContextCount).toBe(2);
    expect(pool.createdContextCount).toBe(2);
    expect(pool.heldContextCountFor("a")).toBe(2);
  });

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

  it("refuses a lease it never minted, rather than accounting for it", () => {
    const pool = new TerminalRendererPool(2);
    grantedLease(pool, "a");
    const anotherLedger = new TerminalRendererPool(2);
    const foreignLease = grantedLease(anotherLedger, "a");

    // Both hand-backs refuse a value the caller assembled: it type-checks, and a lease is a
    // receipt, not a description.
    pool.release(foreignLease);
    pool.release({ terminalId: "a" });
    pool.reclaim(foreignLease);
    pool.reclaim({ terminalId: "a" });

    expect(pool.heldContextCount).toBe(1);
    expect(pool.createdContextCount).toBe(1);
    expect(anotherLedger.heldContextCount).toBe(1);
  });

  it("takes a lease back, and takes it back twice without going negative", () => {
    const pool = new TerminalRendererPool(2);
    const lease = grantedLease(pool, "a");
    pool.release(lease);
    pool.release(lease);
    expect(pool.heldContextCount).toBe(0);
    expect(pool.acquire("c")).toBeDefined();
  });

  it("stays under the page's context ceiling by construction", () => {
    // Chromium drops the oldest WebGL context past sixteen and a disposed addon does not give
    // one back, so the cap leaves room for the rest of the page.
    expect(TERMINAL_WEBGL_POOL_CAP).toBeLessThan(16);
    expect(new TerminalRendererPool().cap).toBe(TERMINAL_WEBGL_POOL_CAP);
    // And the instance every adapter defaults to is that one, not a wider one.
    expect(terminalRendererPool.cap).toBe(TERMINAL_WEBGL_POOL_CAP);
  });

  it("negative control: only a reclaim hands the allowance back", () => {
    // Releasing leaves the made context out there, so the allowance stays spent.
    const afterRelease = new TerminalRendererPool(1);
    const releasedLease = grantedLease(afterRelease, "a");
    expect(afterRelease.acquire("b")).toBeUndefined();
    afterRelease.release(releasedLease);
    expect(afterRelease.acquire("b")).toBeUndefined();

    // Reclaiming says the context does not exist, the only claim that may move the reading
    // down. It is the lease holder's to make, hence a second ledger.
    const afterReclaim = new TerminalRendererPool(1);
    afterReclaim.reclaim(grantedLease(afterReclaim, "a"));
    expect(afterReclaim.acquire("b")).toBeDefined();
  });

  it("negative control: the per-terminal grouping cannot stand in for the count", () => {
    // Why the ledger is not keyed on the terminal: the grouping does not move when a terminal
    // opens a second pane, but the reading the cap is checked against does.
    const pool = new TerminalRendererPool(2);
    grantedLease(pool, "shared-session");
    const groupingAfterOnePane = pool.holds("shared-session");
    const countAfterOnePane = pool.createdContextCount;

    grantedLease(pool, "shared-session");

    expect(pool.holds("shared-session")).toBe(groupingAfterOnePane);
    expect(pool.createdContextCount).not.toBe(countAfterOnePane);
    expect(pool.isExhausted).toBe(true);
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

  it("negative control: the live reading alone would say there was room", () => {
    // Counting holders, as a plain allocator does, reports an empty pool after the same churn,
    // so a cap checked against it would hand out contexts without bound.
    const pool = new TerminalRendererPool(CHURN_CYCLES);
    for (let cycle = 0; cycle < CHURN_CYCLES * 2; cycle += 1) {
      const lease = pool.acquire(`churn-${String(cycle)}`);
      if (lease !== undefined) {
        pool.release(lease);
      }
    }
    expect(pool.heldContextCount).toBe(0);
    expect(pool.createdContextCount).toBe(CHURN_CYCLES);
  });

  it("stops counting a context the host destroyed", () => {
    const pool = new TerminalRendererPool(2);
    pool.reclaim(grantedLease(pool, "lost-its-context"));
    expect(pool.createdContextCount).toBe(0);
    expect(pool.holds("lost-its-context")).toBe(false);
    expect(pool.acquire("a")).toBeDefined();
    expect(pool.acquire("b")).toBeDefined();
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

  it("sweeps every context a terminal is holding, for a caller with no lease", () => {
    // The page-wide sweep: a suite clearing the ledger has no leases (they were minted in an
    // unmounted component), so it names the terminal. Both of one session's panes go.
    const pool = new TerminalRendererPool(4);
    grantedLease(pool, "swept-session");
    grantedLease(pool, "swept-session");
    grantedLease(pool, "other-session");

    pool.reclaimEveryContextFor("swept-session");

    expect(pool.heldContextCountFor("swept-session")).toBe(0);
    expect(pool.heldContextCountFor("other-session")).toBe(1);
    expect(pool.createdContextCount).toBe(1);
  });
});

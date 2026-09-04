// The WebGL context ledger, on its own.
//
// Its own file rather than a block inside `xterm-adapter.test.ts` because every
// case below is arithmetic over leases and needs no emulator, no DOM, and no
// environment — which is the whole reason the ledger is not a section of the
// adapter. The cases that DO need an adapter (which of the two hand-backs a
// teardown performs, and that a host with no WebGL2 spends nothing) live with
// teardown in that file, where the behaviour is.
//
// THE CLAIM THE CHURN CASES BELOW EXIST FOR. A disposed `WebglAddon` leaves its
// WebGL2 context behind, so the reading the cap has to be checked against is how
// many contexts the page has CREATED — not how many terminals are drawing on one.
// A ledger that fell on every teardown would sit under twelve forever while the
// page minted contexts without bound, and the terminal Chromium then took a
// renderer from would be an older one still on screen.
//
// AND THE CLAIM THE DUPLICATE-PANE CASES EXIST FOR. A terminal id is a SESSION's
// id, and two panes on one session each build their own addon and their own
// context — which the fixture pane harness mounts deliberately. A ledger keyed on
// the terminal id counted those two as one and let either pane's teardown retire
// the other's record, so the cap could be walked past and Chromium evicted the
// oldest context on the page. The lease is what makes the unit a context.

import { describe, expect, it } from "vitest";

import { TERMINAL_WEBGL_POOL_CAP } from "./constants.js";
import {
  TerminalRendererPool,
  terminalRendererPool,
  type TerminalContextLease,
} from "./renderer-pool.js";

/**
 * A lease is granted, as something the cases can go on to hand back.
 *
 * The ledger answers `undefined` past its cap, and a case that carried that
 * `undefined` into the next call would be asserting against a refusal it did not
 * mean to take.
 */
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
    // The finding, as arithmetic. Two panes on one session are two addons and two
    // contexts, and a ledger that answered the second acquisition idempotently
    // reported one while the page was holding two.
    expect(second).not.toBe(first);
    expect(pool.heldSlotCount).toBe(2);
    expect(pool.createdContextCount).toBe(2);
    expect(pool.heldContextCountFor("a")).toBe(2);
  });

  it("retires the lease it was handed and leaves the sibling drawing", () => {
    const pool = new TerminalRendererPool(4);
    const first = grantedLease(pool, "a");
    grantedLease(pool, "a");

    pool.release(first);

    // One pane closed; the other is still on a live context. Under the id-keyed
    // ledger this deletion took the ONE record both panes shared, so the page went
    // on drawing on a context nothing was counting as held.
    expect(pool.heldSlotCount).toBe(1);
    expect(pool.heldContextCountFor("a")).toBe(1);
    expect(pool.holds("a")).toBe(true);
    // And the allowance stays spent, because releasing is not reclaiming.
    expect(pool.createdContextCount).toBe(2);
  });

  it("trips on the Nth context however the terminal ids fall", () => {
    // Same cap, same number of contexts, two different distributions of them over
    // terminal ids — and the ledger refuses at the same place in both. Under the
    // id-keyed ledger the left-hand case had spent two of its allowance and the
    // right-hand case one, for the same two live contexts.
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

    // Both hand-backs, because both would otherwise be a way for one pane — or one
    // page — to retire a context it does not own. The assembled value type-checks
    // and is still refused, which is what makes the lease a receipt rather than a
    // description.
    pool.release(foreignLease);
    pool.release({ terminalId: "a" });
    pool.reclaim(foreignLease);
    pool.reclaim({ terminalId: "a" });

    expect(pool.heldSlotCount).toBe(1);
    expect(pool.createdContextCount).toBe(1);
    expect(anotherLedger.heldSlotCount).toBe(1);
  });

  it("takes a lease back, and takes it back twice without going negative", () => {
    const pool = new TerminalRendererPool(2);
    const lease = grantedLease(pool, "a");
    pool.release(lease);
    pool.release(lease);
    expect(pool.heldSlotCount).toBe(0);
    expect(pool.acquire("c")).toBeDefined();
  });

  it("stays under the page's context ceiling by construction", () => {
    // Chromium drops the oldest WebGL context past sixteen and a disposed addon
    // does not give one back, so the cap has to leave room for the rest of the
    // page rather than being sixteen.
    expect(TERMINAL_WEBGL_POOL_CAP).toBeLessThan(16);
    expect(new TerminalRendererPool().cap).toBe(TERMINAL_WEBGL_POOL_CAP);
    // And the instance every adapter defaults to is that one, not a wider one.
    expect(terminalRendererPool.cap).toBe(TERMINAL_WEBGL_POOL_CAP);
  });

  it("negative control: only a reclaim hands the allowance back", () => {
    // Releasing says the terminal stopped drawing, which leaves the context it
    // made out there — so the allowance stays spent and the next terminal is
    // refused.
    const afterRelease = new TerminalRendererPool(1);
    const releasedLease = grantedLease(afterRelease, "a");
    expect(afterRelease.acquire("b")).toBeUndefined();
    afterRelease.release(releasedLease);
    expect(afterRelease.acquire("b")).toBeUndefined();

    // Reclaiming, from a terminal that is still holding, says the context does not
    // exist. It is the only claim that may move the reading down — and it is only
    // the lease holder's to make, which is why this is a second ledger rather than a
    // reclaim tacked onto the first.
    const afterReclaim = new TerminalRendererPool(1);
    afterReclaim.reclaim(grantedLease(afterReclaim, "a"));
    expect(afterReclaim.acquire("b")).toBeDefined();
  });

  it("negative control: the per-terminal grouping cannot stand in for the count", () => {
    // Why the ledger cannot be keyed on the terminal, said against the real object.
    // The grouping is a fact about one terminal and it does not move when that
    // terminal opens a second pane — so a ledger whose whole state was that fact
    // charged the second context nothing, and the page walked past its cap into
    // Chromium's own eviction. The reading the cap IS checked against moves both
    // times, which is the difference.
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
    // Nothing is drawing, and the page has still created twelve contexts. The
    // thirteenth pane opens on the DOM renderer rather than taking a context away
    // from a terminal that is still on screen.
    expect(pool.heldSlotCount).toBe(0);
    expect(pool.createdContextCount).toBe(CHURN_CYCLES);
    expect(pool.isExhausted).toBe(true);
    expect(pool.acquire("one-cycle-too-many")).toBeUndefined();
  });

  it("negative control: the live reading alone would say there was room", () => {
    // This is the bug stated as a test. Counting holders — which is what a slot
    // allocator counts — reports an empty pool after the same churn, so a cap
    // checked against THAT reading hands out an unbounded run of contexts.
    const pool = new TerminalRendererPool(CHURN_CYCLES);
    for (let cycle = 0; cycle < CHURN_CYCLES * 2; cycle += 1) {
      const lease = pool.acquire(`churn-${String(cycle)}`);
      if (lease !== undefined) {
        pool.release(lease);
      }
    }
    expect(pool.heldSlotCount).toBe(0);
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
    // Both teardown arms can run twice, and a ledger that went negative would
    // quietly widen the page's allowance past the cap it exists to hold.
    const pool = new TerminalRendererPool(2);
    const lease = grantedLease(pool, "a");
    pool.reclaim(lease);
    pool.reclaim(lease);
    pool.reclaim({ terminalId: "never-held" });
    expect(pool.createdContextCount).toBe(0);
    expect(pool.heldSlotCount).toBe(0);
  });

  it("sweeps every context a terminal is holding, for a caller with no lease", () => {
    // The grouping's write half, which a suite clearing the page ledger between
    // cases reaches for: the leases were minted inside a component it has since
    // unmounted, so it names the terminal instead. Both of one session's panes go,
    // and a second session's is untouched.
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

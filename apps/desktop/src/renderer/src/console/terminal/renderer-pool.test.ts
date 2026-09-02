// The WebGL context ledger, on its own.
//
// Its own file rather than a block inside `xterm-adapter.test.ts` because every
// case below is arithmetic over terminal ids and needs no emulator, no DOM, and
// no environment — which is the whole reason the ledger is not a section of the
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

import { describe, expect, it } from "vitest";

import { TERMINAL_WEBGL_POOL_CAP } from "./constants.js";
import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";

describe("the renderer pool", () => {
  it("hands out one slot per terminal id, idempotently", () => {
    const pool = new TerminalRendererPool(2);
    expect(pool.acquire("a")).toBe(true);
    expect(pool.acquire("a")).toBe(true);
    expect(pool.heldSlotCount).toBe(1);
  });

  it("refuses past its cap rather than taking a context from a live terminal", () => {
    const pool = new TerminalRendererPool(2);
    expect(pool.acquire("a")).toBe(true);
    expect(pool.acquire("b")).toBe(true);
    expect(pool.acquire("c")).toBe(false);
    expect(pool.heldSlotCount).toBe(2);
  });

  it("takes a slot back, and takes it back twice without going negative", () => {
    const pool = new TerminalRendererPool(2);
    pool.acquire("a");
    pool.release("a");
    pool.release("a");
    expect(pool.heldSlotCount).toBe(0);
    expect(pool.acquire("c")).toBe(true);
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
    afterRelease.acquire("a");
    expect(afterRelease.acquire("b")).toBe(false);
    afterRelease.release("a");
    expect(afterRelease.acquire("b")).toBe(false);

    // Reclaiming, from a terminal that is still holding, says the context does not
    // exist. It is the only claim that may move the reading down — and it is only
    // the holder's to make, which is why this is a second ledger rather than a
    // reclaim tacked onto the first.
    const afterReclaim = new TerminalRendererPool(1);
    afterReclaim.acquire("a");
    afterReclaim.reclaim("a");
    expect(afterReclaim.acquire("b")).toBe(true);
  });
});

describe("the ledger counts contexts created, not terminals drawing", () => {
  /** A working day of opening and closing the pane, against a ledger of that size. */
  const CHURN_CYCLES = 12;

  it("does not hand a disposed terminal's context back", () => {
    const pool = new TerminalRendererPool(CHURN_CYCLES);
    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      expect(pool.acquire(`churn-${String(cycle)}`)).toBe(true);
      pool.release(`churn-${String(cycle)}`);
    }
    // Nothing is drawing, and the page has still created twelve contexts. The
    // thirteenth pane opens on the DOM renderer rather than taking a context away
    // from a terminal that is still on screen.
    expect(pool.heldSlotCount).toBe(0);
    expect(pool.createdContextCount).toBe(CHURN_CYCLES);
    expect(pool.isExhausted).toBe(true);
    expect(pool.acquire("one-cycle-too-many")).toBe(false);
  });

  it("negative control: the live reading alone would say there was room", () => {
    // This is the bug stated as a test. Counting holders — which is what a slot
    // allocator counts — reports an empty pool after the same churn, so a cap
    // checked against THAT reading hands out an unbounded run of contexts.
    const pool = new TerminalRendererPool(CHURN_CYCLES);
    for (let cycle = 0; cycle < CHURN_CYCLES * 2; cycle += 1) {
      pool.acquire(`churn-${String(cycle)}`);
      pool.release(`churn-${String(cycle)}`);
    }
    expect(pool.heldSlotCount).toBe(0);
    expect(pool.createdContextCount).toBe(CHURN_CYCLES);
  });

  it("stops counting a context the host destroyed", () => {
    const pool = new TerminalRendererPool(2);
    pool.acquire("lost-its-context");
    pool.reclaim("lost-its-context");
    expect(pool.createdContextCount).toBe(0);
    expect(pool.holds("lost-its-context")).toBe(false);
    expect(pool.acquire("a")).toBe(true);
    expect(pool.acquire("b")).toBe(true);
  });

  it("reclaims idempotently, and never below zero", () => {
    // Both teardown arms can run twice, and a ledger that went negative would
    // quietly widen the page's allowance past the cap it exists to hold.
    const pool = new TerminalRendererPool(2);
    pool.acquire("a");
    pool.reclaim("a");
    pool.reclaim("a");
    pool.reclaim("never-held");
    expect(pool.createdContextCount).toBe(0);
    expect(pool.heldSlotCount).toBe(0);
  });
});

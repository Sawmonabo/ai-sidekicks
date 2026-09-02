// The WebGL slot allocator, on its own.
//
// Its own file rather than a block inside `xterm-adapter.test.ts` because every
// case below is arithmetic over terminal ids and needs no emulator, no DOM, and
// no environment — which is the whole reason the allocator is not a section of
// the adapter. The one case that DOES need an adapter (a disposed adapter gives
// its slot back) lives with teardown in that file, where the behaviour is.

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

  it("negative control: a pool that never released would refuse after the cap", () => {
    const pool = new TerminalRendererPool(1);
    pool.acquire("a");
    expect(pool.acquire("b")).toBe(false);
    pool.release("a");
    expect(pool.acquire("b")).toBe(true);
  });
});

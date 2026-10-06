// @vitest-environment happy-dom
//
// Tier: endurance, the terminal held open and a churn of them.
//
// `steady-state.test.ts` states this tier's question: not the peak or the absolute heap at an
// instant, but whether the number comes back. This file asks the terminal-shaped versions:
//   - a terminal that has taken ten thousand lines holds a bounded buffer: the scrollback's
//     eviction happens in lines and in bytes, so a second ten thousand lines costs neither a
//     second buffer nor a second allocation;
//   - one instance gives its bytes back when disposed, and an undisposed one still holds them,
//     the pair that makes "released" a claim about something and not about a sampler that
//     always reads the baseline;
//   - a churn of open-and-close cycles leaves the page where it started (the renderer pool's
//     held context count at zero, the retained bytes near baseline), because a pane is opened and
//     closed dozens of times in a working day.
//
// This file is not the `terminal-instance-memory` budget's gate and makes no ceiling claim: that
// row's harness beside it prices both halves of a populated pane and compares their sum to the
// ceiling once. Measuring a full scrollback against the same ceiling here would be a second
// allowance, not a second opinion: each half would receive the whole 20 MiB. The scrollback
// measurement lives in `terminal-adapter-workload.ts`, which this file shares.
//
// The adapter is driven in process rather than in a real window because the claims are about
// the adapter's own bookkeeping; a window would put a renderer, a React tree and a pane's store
// between the write and the reading, the right arrangement for the budget's harness and the
// wrong one for eviction.
//
// The cost: the DOM shim has no WebGL2, so every instance settles on the fallback renderer and
// the WebGL context leak this pool exists to bound (xterm.js issue #6068) is not exercised. The
// pool's accounting is, which is what this process can observe. The context ceiling itself is a
// real-window question.

import { afterEach, describe, expect, it } from "vitest";

import { BudgetRegistry } from "#scripts/budget/budget-registry.mts";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "#renderer/features/terminal/caps.js";
import { TerminalRendererPool } from "#renderer/features/terminal/emulator/renderer-pool.js";
import { HeapSampler, retainedGrowthBytes } from "./heap/sampling.js";
import {
  requireHeapCollector,
  TerminalAdapterWorkload,
} from "./terminal/terminal-adapter-workload.js";

const registry = BudgetRegistry.load();

/**
 * This file's collector and settling loop.
 *
 * One per test file rather than a tier-wide module: the resolution is memoized, and a memo any
 * tier could poison would let one file's failure decide what a later one may measure.
 */
const heapSampler = new HeapSampler();

/**
 * The budget row, read for the scale its ceiling gives a leak bound, not as a ceiling this file
 * gates on.
 *
 * The churn case needs a number large against one instance and small against twelve leaking,
 * and one instance's budget is that number. Read rather than restated, so the bound has one
 * source.
 */
const terminalBudget = registry.requireBudget("terminal-instance-memory");

/** How many open-and-close cycles stand in for a working day's pane churn. */
const CHURN_CYCLES = 12;

/** Lines per cycle in the context-count case, where the question is the count, not the fill. */
const CONTEXT_CASE_LINES = 500;

/** This file's mounted adapters and their hosts, given back after every case. */
const adapterWorkload = new TerminalAdapterWorkload();

afterEach(() => {
  adapterWorkload.disposeEverything();
});

/** Ten thousand lines through the real parser, twelve times, on a slow runner. */
const ENDURANCE_CASE_TIMEOUT_MS = 300_000;

describe("a terminal held open over a long stream", () => {
  it(
    "evicts rather than grows once the scrollback is full",
    async () => {
      const pool = new TerminalRendererPool();
      const adapter = adapterWorkload.mount("endurance-terminal", pool);

      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const afterFirstFill = adapter.bufferLineCount;
      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const afterSecondFill = adapter.bufferLineCount;

      // The buffer is at its cap and stays there: twenty thousand lines cost the same as ten
      // thousand, which bounds a terminal left open all day. It holds the scrollback plus the
      // visible viewport, so the count sits just above the cap and does not move when the same
      // volume arrives again.
      expect(afterFirstFill).toBeGreaterThan(TERMINAL_DEFAULT_SCROLLBACK_LINES);
      expect(afterFirstFill).toBeLessThan(TERMINAL_DEFAULT_SCROLLBACK_LINES * 2);
      expect(afterSecondFill).toBe(afterFirstFill);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it(
    "buys no second buffer for the second ten thousand lines",
    async () => {
      requireHeapCollector(heapSampler);
      const pool = new TerminalRendererPool();
      const baseline = await heapSampler.sample();
      const adapter = adapterWorkload.mount("endurance-eviction-terminal", pool);

      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      // Held live across both samples: the figures are what the instance retains, so it must
      // still be reachable at each reading.
      expect(adapter.bufferLineCount).toBeGreaterThan(TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const filledOnce = await heapSampler.sample();
      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const filledTwice = await heapSampler.sample();

      // The eviction claim in bytes, which the line count cannot make: a buffer capped at ten
      // thousand lines whose evicted lines stayed reachable would report the same count and
      // twice the memory. The bound is the first fill's own cost, so it needs no figure or
      // ceiling of its own.
      const firstFillBytes = retainedGrowthBytes(baseline, filledOnce);
      const secondFillBytes = retainedGrowthBytes(filledOnce, filledTwice);
      expect(
        firstFillBytes,
        "the first ten thousand lines retained nothing, so the comparison below measures nothing",
      ).toBeGreaterThan(1_000_000);
      expect(
        secondFillBytes,
        `the second ten thousand lines retained ${String(secondFillBytes)} bytes against the ` +
          `first's ${String(firstFillBytes)}, so the scrollback is growing rather than evicting`,
      ).toBeLessThan(firstFillBytes / 2);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it(
    "gives the memory back on disposal",
    async () => {
      requireHeapCollector(heapSampler);
      const pool = new TerminalRendererPool();
      const baseline = await heapSampler.sample();
      const adapter = adapterWorkload.mount("teardown-terminal", pool);
      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const held = await heapSampler.sample();
      adapter.dispose();
      const released = await heapSampler.sample();

      // The buffer was really there, otherwise "it was released" is a claim about nothing, and
      // then it is not.
      const retainedWhileLive = retainedGrowthBytes(baseline, held);
      expect(retainedWhileLive).toBeGreaterThan(1_000_000);
      expect(retainedGrowthBytes(baseline, released)).toBeLessThan(retainedWhileLive / 2);
      expect(pool.holds("teardown-terminal")).toBe(false);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );
});

describe("a working day of opening and closing the pane", () => {
  it(
    "leaves the renderer pool holding no context",
    async () => {
      const pool = new TerminalRendererPool();
      for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
        const adapter = adapterWorkload.mount(`churn-terminal-${String(cycle)}`, pool);
        await adapterWorkload.writeLines(adapter, CONTEXT_CASE_LINES);
        adapter.dispose();
      }
      // Twelve cycles and nothing drawing at the end: no teardown left a hold behind. Whether
      // the page may still take a context is the pool.s other reading, owned by
      // `renderer-pool.test.ts`; this environment has no WebGL2 to spend, so it could only be
      // asserted vacuously here.
      expect(pool.heldContextCount).toBe(0);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it(
    "leaves the retained bytes near where they started",
    async () => {
      requireHeapCollector(heapSampler);
      const pool = new TerminalRendererPool();

      // One cycle first, so the reading is against a settled process: the library's
      // module-level state is allocated once and is not a leak.
      const warmUp = adapterWorkload.mount("churn-warm-up", pool);
      await adapterWorkload.writeLines(warmUp, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      warmUp.dispose();

      const baseline = await heapSampler.sample();
      for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
        const adapter = adapterWorkload.mount(`churn-heap-terminal-${String(cycle)}`, pool);
        await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
        adapter.dispose();
      }
      const afterChurn = await heapSampler.sample();

      // The leak signal: twelve full terminals came and went, so a per-cycle retention would
      // show up twelve times over. The allowance is one instance's budget used as a scale:
      // anything under it cannot be a per-cycle leak. It is not a claim that this process fits
      // the row's ceiling; that comparison is the harness's.
      const drift = retainedGrowthBytes(baseline, afterChurn);
      expect(drift, `${String(CHURN_CYCLES)} cycles drifted ${String(drift)} bytes`).toBeLessThan(
        terminalBudget.limit.canonicalValue,
      );
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );
});

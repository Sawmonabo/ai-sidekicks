// @vitest-environment happy-dom
//
// Tier: endurance — the terminal held open, and a churn of them.
//
// `steady-state.test.ts` states this tier's question in its own words: not the peak
// and not the absolute heap at an instant, but whether the number comes BACK. So
// this file asks the terminal-shaped versions of that:
//
//   • a terminal that has taken ten thousand lines is holding a BOUNDED buffer,
//     not a growing one: the eviction that the scrollback promises actually
//     happens, in lines AND in bytes, so a second ten thousand lines costs neither
//     a second buffer nor a second allocation;
//   • one instance gives its bytes back when it is disposed, and an undisposed one
//     is still holding them — the pair that makes "released" a claim about
//     something rather than about a sampler that always reads the baseline;
//   • a churn of open-and-close cycles leaves the page where it started — the
//     renderer slot ledger empty and the retained bytes back near baseline —
//     because a console is left open for a working day and a pane is opened and
//     closed dozens of times in one.
//
// WHAT THIS FILE IS NOT. It is not the `terminal-instance-memory` budget's gate,
// and — since 2026-09-04 — it makes no ceiling claim at all. That row's subject is
// a populated terminal PANE, and its harness beside this file in this tier now
// prices BOTH halves of it and compares their sum to the ceiling once. Measuring a
// full scrollback against that same ceiling HERE was not a second opinion, it was a
// second allowance: each half would receive the whole 20 MiB, so a 19.5 MiB buffer
// beside a 1 MiB pane passed two green checks while the instance the row names sat
// over its ceiling. The scrollback measurement moved to the harness that adds it up
// (`terminal-adapter-workload.ts`, which this file shares), and what stays here is
// what only this process can say: that the buffer is bounded, that a disposal gives
// it back, and that a working day of churn leaves nothing behind.
//
// WHY THIS FILE DRIVES THE ADAPTER IN PROCESS RATHER THAN A REAL WINDOW. Its
// subject is the adapter, and the three claims below are about the adapter's own
// bookkeeping. Driving those through a window would put a renderer, a React tree,
// and a pane's store between the write and the reading, which is the right
// arrangement for the budget's harness and the wrong one for a claim about
// eviction — and the two files are separate precisely so neither has to answer the
// other's question.
//
// WHAT THAT COSTS, STATED. The DOM shim has no WebGL2, so every instance settles
// on the fallback renderer, and the WebGL context leak this pool exists to bound
// (xterm.js issue #6068) is NOT exercised here — the pool's accounting is, which
// is the part this process can observe. The context ceiling itself is a real-window
// question and stays one.

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleBudgetRegistry } from "../../../scripts/budget/budget-registry.mjs";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../../src/renderer/src/console/core/constants.js";
import { TerminalRendererPool } from "../../../src/renderer/src/console/terminal/renderer-pool.js";
import { HeapSampler, retainedGrowthBytes } from "../heap-sampling.js";
import { requireHeapCollector, TerminalAdapterWorkload } from "./terminal-adapter-workload.js";

const registry = ConsoleBudgetRegistry.load();

/**
 * This file's collector and settling loop.
 *
 * One per test file, beside the harness it measures, rather than a module the tier
 * shares with every other: the resolution is memoised, and a memo any tier could
 * poison would let one file's failure decide what a later one is allowed to
 * measure.
 */
const heapSampler = new HeapSampler();

/**
 * The budget row, read for the SCALE its ceiling gives a leak bound — not as a
 * ceiling this file gates on.
 *
 * The row's `measuredBy` names the file beside this one and that file holds its one
 * gate. What the churn case below needs is a number that is large against a single
 * instance and small against twelve of them leaking, and one instance's budget is
 * exactly that number. Read rather than restated, because putting a second figure
 * here would be a second source of truth for a bound the spec already fixed.
 */
const terminalBudget = registry.requireBudget("terminal-instance-memory");

/** How many open-and-close cycles stand in for a working day's pane churn. */
const CHURN_CYCLES = 12;

/** Lines per cycle in the ledger case, where the question is the ledger not the fill. */
const LEDGER_CASE_LINES = 500;

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

      // The buffer is at its cap and stays there: twenty thousand lines cost the
      // same as ten thousand, which is the property that makes a terminal left open
      // all day bounded rather than merely slow to fail.
      // The buffer holds the scrollback plus the visible viewport, so the count
      // sits just above the cap rather than exactly on it — and does not move when
      // the same volume arrives again.
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
      // Held live across both samples on purpose: the figures are what the instance
      // RETAINS, so it has to still be reachable when each heap reading is taken.
      expect(adapter.bufferLineCount).toBeGreaterThan(TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const filledOnce = await heapSampler.sample();
      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const filledTwice = await heapSampler.sample();

      // The eviction claim in BYTES, which is the half the line count cannot make:
      // a buffer capped at ten thousand lines whose evicted lines stayed reachable
      // would report the same count above and twice the memory here. The bound is
      // the first fill's own cost, so it needs no figure of its own and no ceiling
      // — a second fill that cost anything like a first one is the defect.
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

      // The buffer was really there — otherwise "it was released" is a claim about
      // nothing — and then it is not.
      const retainedWhileLive = retainedGrowthBytes(baseline, held);
      expect(retainedWhileLive).toBeGreaterThan(1_000_000);
      expect(retainedGrowthBytes(baseline, released)).toBeLessThan(retainedWhileLive / 2);
      expect(pool.holds("teardown-terminal")).toBe(false);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it(
    "negative control: an undisposed instance is still holding it",
    async () => {
      requireHeapCollector(heapSampler);
      const pool = new TerminalRendererPool();
      const baseline = await heapSampler.sample();
      const adapter = adapterWorkload.mount("undisposed-terminal", pool);
      await adapterWorkload.writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const held = await heapSampler.sample();
      // Deliberately NOT disposed. Without this case the release assertion above
      // would pass against a sampler that always read the baseline back, and every
      // heap figure in this file would be measuring nothing.
      expect(retainedGrowthBytes(baseline, held)).toBeGreaterThan(1_000_000);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );
});

describe("a working day of opening and closing the pane", () => {
  it(
    "leaves the renderer ledger where it started",
    async () => {
      const pool = new TerminalRendererPool();
      for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
        const adapter = adapterWorkload.mount(`churn-terminal-${String(cycle)}`, pool);
        await adapterWorkload.writeLines(adapter, LEDGER_CASE_LINES);
        adapter.dispose();
      }
      // Twelve cycles, and nothing drawing at the end: no teardown left a hold
      // behind. Whether the page may still TAKE a context is the ledger's other
      // reading, which does not fall on a teardown and which
      // `renderer-pool.test.ts` owns — this environment has no WebGL2 to spend,
      // so it could only be asserted vacuously here.
      expect(pool.heldSlotCount).toBe(0);
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it(
    "leaves the retained bytes near where they started",
    async () => {
      requireHeapCollector(heapSampler);
      const pool = new TerminalRendererPool();

      // One cycle first, so the reading below is against a settled process rather
      // than against one that has never built an emulator: the library's own
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

      // The leak signal: twelve full terminals came and went, so a per-cycle
      // retention would show up here twelve times over. The allowance is ONE
      // instance's budget used as a SCALE — anything under that cannot be a
      // per-cycle leak, and anything over it is one. It is not a claim that this
      // process fits the row's ceiling; that comparison is the harness's.
      const drift = retainedGrowthBytes(baseline, afterChurn);
      expect(drift, `${String(CHURN_CYCLES)} cycles drifted ${String(drift)} bytes`).toBeLessThan(
        terminalBudget.limit.canonicalValue,
      );
    },
    ENDURANCE_CASE_TIMEOUT_MS,
  );

  it("negative control: the ledger is capable of being non-zero", () => {
    // Without this the cycle case would pass against a counter stuck at zero —
    // which is exactly what a DOM-only environment produces on its own, since no
    // instance here can acquire a WebGL slot. The pool's accounting is asserted
    // directly, because that is the part this process can observe.
    const pool = new TerminalRendererPool();
    const lease = pool.acquire("proof-of-life");
    expect(lease).toBeDefined();
    expect(pool.heldSlotCount).toBe(1);
    if (lease !== undefined) {
      pool.release(lease);
    }
    expect(pool.heldSlotCount).toBe(0);
  });
});

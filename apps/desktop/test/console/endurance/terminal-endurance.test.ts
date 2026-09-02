// @vitest-environment happy-dom
//
// Tier: endurance — the terminal held open, and a churn of them.
//
// `steady-state.test.ts` states this tier's question in its own words: not the peak
// and not the absolute heap at an instant — those are budget-tier questions, and
// `test/console/budget/heap-terminal.test.ts` answers them against `budgets.json`
// — but whether the number comes BACK. So this file asks the two terminal-shaped
// versions of that:
//
//   • a terminal that has taken ten thousand lines is holding a BOUNDED buffer,
//     not a growing one: the eviction that the scrollback promises actually
//     happens, and a second ten thousand lines does not cost a second buffer;
//   • a churn of open-and-close cycles leaves the page where it started — the
//     renderer slot ledger empty and the retained bytes back near baseline —
//     because a console is left open for a working day and a pane is opened and
//     closed dozens of times in one.
//
// WHY THIS FILE DRIVES THE ADAPTER IN PROCESS RATHER THAN A REAL WINDOW. Every
// other file in this tier drives the built application through Playwright's
// `_electron`, which is the right shape when the subject is the whole console. It
// is not available for this subject at this revision: no deck mounts a pane yet,
// so there is no way to open a terminal in that window and nothing to drive. The
// honest alternative is to drive the real `@xterm/xterm` against a DOM here and
// say so — a stand-in emulator would answer questions about the stand-in, and
// waiting for the deck would leave the churn untested for as long as that takes.
//
// WHAT THAT COSTS, STATED. The DOM shim has no WebGL2, so every instance settles
// on the fallback renderer, and the WebGL context leak this pool exists to bound
// (xterm.js issue #6068) is NOT exercised here — the pool's accounting is, which
// is the part this process can observe. The context ceiling itself is a real-window
// question and stays one.

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleBudgetRegistry, evaluateBudget } from "../../../scripts/budget/budget-registry.mjs";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../../src/renderer/src/console/terminal/constants.js";
import { XtermTerminalAdapter } from "../../../src/renderer/src/console/terminal/xterm-adapter.js";
import { TerminalRendererPool } from "../../../src/renderer/src/console/terminal/renderer-pool.js";
import { heapCollectorAvailable, retainedGrowthBytes, sampleHeap } from "../heap-sampling.js";

const registry = ConsoleBudgetRegistry.load();

/** The ceiling this tier compares against is the BUDGET's, read — never restated. */
const terminalBudget = registry.requireBudget("terminal-instance-memory");

/** Columns a terminal is driven at. The same working width the budget is read at. */
const MEASURED_COLUMNS = 120;

/** Lines per `write`. Batched: a per-line await pays a task hop ten thousand times. */
const WRITE_BATCH_LINES = 500;

/** How many open-and-close cycles stand in for a working day's pane churn. */
const CHURN_CYCLES = 12;

const liveAdapters: XtermTerminalAdapter[] = [];
const liveHosts: HTMLElement[] = [];

afterEach(() => {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  for (const host of liveHosts.splice(0)) {
    host.remove();
  }
});

function mountAdapter(terminalId: string, pool: TerminalRendererPool): XtermTerminalAdapter {
  const host = document.createElement("div");
  document.body.append(host);
  liveHosts.push(host);
  const adapter = new XtermTerminalAdapter({ terminalId, pool });
  liveAdapters.push(adapter);
  adapter.attach(host);
  return adapter;
}

async function writeLines(adapter: XtermTerminalAdapter, lines: number): Promise<void> {
  const line = `${"W".repeat(MEASURED_COLUMNS)}\n`;
  for (let written = 0; written < lines; written += WRITE_BATCH_LINES) {
    const batchLines = Math.min(WRITE_BATCH_LINES, lines - written);
    await new Promise<void>((resolve) => {
      adapter.write(line.repeat(batchLines), resolve);
    });
  }
}

function requireHeapCollector(): void {
  if (!heapCollectorAvailable()) {
    // Named rather than skipped: a heap reading with no collection behind it is
    // noise, and a tier that is green because it measured noise is worse than one
    // that is loud about the gap.
    expect.fail("no garbage collector is reachable, so no heap reading is admissible");
  }
}

/** Ten thousand lines through the real parser, twelve times, on a slow runner. */
const ENDURANCE_CASE_TIMEOUT_MS = 300_000;

describe("a terminal held open over a long stream", () => {
  it(
    "evicts rather than grows once the scrollback is full",
    async () => {
      const pool = new TerminalRendererPool();
      const adapter = mountAdapter("endurance-terminal", pool);

      await writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const afterFirstFill = adapter.bufferLineCount;
      await writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
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
    "stays inside the per-instance budget after twice its scrollback",
    async () => {
      requireHeapCollector();
      const pool = new TerminalRendererPool();
      const before = await sampleHeap();
      const adapter = mountAdapter("endurance-budget-terminal", pool);
      await writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES * 2);
      expect(adapter.bufferLineCount).toBeGreaterThan(0);
      const after = await sampleHeap();

      // Same ceiling as the budget tier's, read from the same row: a long stream
      // must not buy a terminal a bigger allowance than a full one gets.
      const verdict = evaluateBudget(terminalBudget, retainedGrowthBytes(before, after));
      expect(
        verdict.withinBudget,
        `${verdict.budgetId}: ${verdict.measuredCanonicalValue} of ${verdict.limitCanonicalValue} ${verdict.canonicalUnit}`,
      ).toBe(true);
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
        const adapter = mountAdapter(`churn-terminal-${String(cycle)}`, pool);
        await writeLines(adapter, WRITE_BATCH_LINES);
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
      requireHeapCollector();
      const pool = new TerminalRendererPool();

      // One cycle first, so the reading below is against a settled process rather
      // than against one that has never built an emulator: the library's own
      // module-level state is allocated once and is not a leak.
      const warmUp = mountAdapter("churn-warm-up", pool);
      await writeLines(warmUp, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      warmUp.dispose();

      const baseline = await sampleHeap();
      for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
        const adapter = mountAdapter(`churn-heap-terminal-${String(cycle)}`, pool);
        await writeLines(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
        adapter.dispose();
      }
      const afterChurn = await sampleHeap();

      // The leak signal: twelve full terminals came and went, so a per-cycle
      // retention would show up here twelve times over. The allowance is ONE
      // instance's budget — anything under that cannot be a per-cycle leak, and
      // anything over it is one.
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
    expect(pool.acquire("proof-of-life")).toBe(true);
    expect(pool.heldSlotCount).toBe(1);
    pool.release("proof-of-life");
    expect(pool.heldSlotCount).toBe(0);
  });
});

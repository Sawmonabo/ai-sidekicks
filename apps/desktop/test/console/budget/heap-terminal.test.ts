// @vitest-environment happy-dom
//
// The per-terminal memory budget row — Plan-023 Phase 1C (T-023p-1C-7).
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds ONE terminal instance at
// the default scrollback at 20 MiB, and this file takes that reading against the
// real `@xterm/xterm` — the emulator, its addons, and its buffer — rather than
// against a stand-in. The ceiling is READ FROM `budgets.json` through the registry
// and never restated here, so a loosened budget cannot pass by editing a test.
//
// WHY THIS TIER AND NOT THE ENDURANCE ONE. This is the absolute figure at rest,
// which `test/console/endurance/steady-state.test.ts` says in its own words is a
// budget-tier question. The endurance tier's terminal file asks the different
// question — whether a churn of instances leaves the number where it started.
//
// WHY THE ROW READS `enforced`. `apps/desktop/AGENTS.md`: "A budget marked
// `enforced` is reachable from the aggregate `test` script AND from a CI job." This
// file was written while `test:console-bundle` was on neither, so the row said `n/a`
// and named the wiring it was waiting for — declaring a gate that does not run is
// the exact failure the neighbouring `heap-budget.test.ts` was written to keep
// retired. That tier is on both today, so the row names this file as its harness and
// the pairing below asserts the wiring rather than the waiting.
//
// WHY THE ENVIRONMENT IS OVERRIDDEN. This project is `node`, because every other
// budget subject is a file on disk. A terminal is not: the emulator opens against
// a DOM. The docblock above is per-file rather than a new project, since a tenth
// tier for one file would give one budget its own gate to be forgotten in.

import { afterEach, describe, expect, it } from "vitest";

import { ConsoleBudgetRegistry, evaluateBudget } from "../../../scripts/budget/budget-registry.mjs";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../../src/renderer/src/console/terminal/constants.js";
import { XtermTerminalAdapter } from "../../../src/renderer/src/console/terminal/xterm-adapter.js";
import { TerminalRendererPool } from "../../../src/renderer/src/console/terminal/renderer-pool.js";
import { heapCollectorAvailable, retainedGrowthBytes, sampleHeap } from "../heap-sampling.js";

const TERMINAL_BUDGET_ID = "terminal-instance-memory";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(TERMINAL_BUDGET_ID);

/** Columns a terminal is measured at. The budget's own working width. */
const MEASURED_COLUMNS = 120;

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

/** How many lines one `write` carries. Batched, not per-line — see below. */
const WRITE_BATCH_LINES = 500;

/**
 * Fill the buffer to its cap, so the reading is at the scrollback the budget names.
 *
 * Batched because the library's write is asynchronous and a per-line await pays a
 * task hop ten thousand times, which is minutes of wall clock for a buffer the
 * emulator would have taken in a handful of chunks. The chunk boundary changes
 * nothing about what is retained: the parser sees one byte stream either way, and
 * the assertion below is on the line count the buffer actually holds.
 */
async function fillToScrollback(adapter: XtermTerminalAdapter, lines: number): Promise<void> {
  const line = `${"W".repeat(MEASURED_COLUMNS)}\n`;
  for (let written = 0; written < lines; written += WRITE_BATCH_LINES) {
    const batchLines = Math.min(WRITE_BATCH_LINES, lines - written);
    await new Promise<void>((resolve) => {
      adapter.write(line.repeat(batchLines), resolve);
    });
  }
}

/** Long enough for ten thousand lines through the real parser on a slow runner. */
const HEAP_CASE_TIMEOUT_MS = 120_000;

describe("the per-terminal memory budget", () => {
  it("is the spec's row, read from the registry rather than restated", () => {
    expect(budget.limit.canonicalUnit).toBe("bytes");
    expect(budget.limit.comparison).toBe("<=");
    expect(budget.producedBy).toBe("T-023p-1C-7");
    // 20 MiB, as the row's own `unitConventions` entry says the spec writes it.
    expect(budget.limit.canonicalValue).toBe(20 * 1024 * 1024);
  });

  it(
    "holds one instance at the default scrollback under the ceiling",
    async () => {
      if (!heapCollectorAvailable()) {
        // Named rather than skipped silently: a reading with no collection behind it
        // is noise, and a green tier that measured noise is worse than a loud gap.
        expect.fail("no garbage collector is reachable, so no heap reading is admissible");
      }
      const pool = new TerminalRendererPool();
      const before = await sampleHeap();
      const adapter = mountAdapter("budget-terminal", pool);
      await fillToScrollback(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      // Held live across the sample on purpose: the figure is what one instance
      // RETAINS, so the instance has to still be reachable when it is read.
      expect(adapter.bufferLineCount).toBeGreaterThan(0);
      const after = await sampleHeap();

      const verdict = evaluateBudget(budget, retainedGrowthBytes(before, after));
      expect(
        verdict.withinBudget,
        `${verdict.budgetId}: ${verdict.measuredCanonicalValue} of ${verdict.limitCanonicalValue} ${verdict.canonicalUnit}`,
      ).toBe(true);
    },
    HEAP_CASE_TIMEOUT_MS,
  );

  it(
    "gives the memory back on teardown",
    async () => {
      if (!heapCollectorAvailable()) {
        expect.fail("no garbage collector is reachable, so no heap reading is admissible");
      }
      const pool = new TerminalRendererPool();
      const baseline = await sampleHeap();
      const adapter = mountAdapter("teardown-terminal", pool);
      await fillToScrollback(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const held = await sampleHeap();
      adapter.dispose();
      const released = await sampleHeap();

      // The buffer was really there — otherwise "it was released" is a claim about
      // nothing — and then it is not.
      const retainedWhileLive = retainedGrowthBytes(baseline, held);
      const retainedAfterDispose = retainedGrowthBytes(baseline, released);
      expect(retainedWhileLive).toBeGreaterThan(1_000_000);
      expect(retainedAfterDispose).toBeLessThan(retainedWhileLive / 2);
      expect(pool.holds("teardown-terminal")).toBe(false);
    },
    HEAP_CASE_TIMEOUT_MS,
  );

  it(
    "negative control: an undisposed instance is still holding it",
    async () => {
      if (!heapCollectorAvailable()) {
        expect.fail("no garbage collector is reachable, so no heap reading is admissible");
      }
      const pool = new TerminalRendererPool();
      const baseline = await sampleHeap();
      const adapter = mountAdapter("undisposed-terminal", pool);
      await fillToScrollback(adapter, TERMINAL_DEFAULT_SCROLLBACK_LINES);
      const held = await sampleHeap();
      // Deliberately NOT disposed here. Without this case the release assertion
      // above would pass against a sampler that always read the baseline back.
      expect(retainedGrowthBytes(baseline, held)).toBeGreaterThan(1_000_000);
      expect(pool.holds("undisposed-terminal")).toBe(pool.heldSlotCount > 0);
    },
    HEAP_CASE_TIMEOUT_MS,
  );

  it("is a gate that names this file, and this file is the one that runs", () => {
    // The pairing this file is held to, in both directions: the row claims to be
    // enforced, and the harness it names is this one. A row pointing at a file that
    // does not measure it, or a measurement no row points at, is how a budget goes
    // green while nothing is watching it. The other half of the word `enforced` —
    // that this file's tier is on the aggregate script and on a CI job — is asserted
    // generically by `test/console/architecture/ci-tier-coverage.test.ts`, against
    // the resolved project set rather than against a search for a string.
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe("apps/desktop/test/console/budget/heap-terminal.test.ts");
    expect(budget.notMeasurableReason).toBeNull();
  });
});

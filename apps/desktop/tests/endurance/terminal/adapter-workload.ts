// The adapter-level workload the two terminal endurance files share: a real
// `XtermTerminalAdapter` on this tier's DOM shim, filled at a working width and given back
// before the next case. The mount, batched write and teardown are the measurement's
// instrument, so one copy keeps the budget's two halves priced at the same width, batch size
// and teardown.
//
// The width is `TERMINAL_BUDGET_MEASUREMENT_COLUMNS` in the terminal feature's
// `caps.ts`, beside the scrollback depth the budget is read at, because the budget's
// meaning depends on it and the pane half is measured at the same width.

import { expect } from "vitest";

import {
  TERMINAL_BUDGET_MEASUREMENT_COLUMNS,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
} from "#renderer/features/terminal/caps.js";
import type { TerminalRendererPool } from "#renderer/features/terminal/emulator/renderer-pool.js";
import { XtermTerminalAdapter } from "#renderer/features/terminal/emulator/xterm/adapter.js";
import { retainedGrowthBytes, type HeapSampler } from "../heap/sampling.js";

/** Lines per `write`. Batched: a per-line await pays a task hop ten thousand times. */
const WRITE_BATCH_LINES = 500;

/**
 * Refuses a heap reading no collection stands behind.
 *
 * Named rather than skipped: a tier green on noise is worse than one loud about the gap. Takes
 * the sampler because its collector resolution is memoized per sampler, and a second one here
 * would flip a process-wide flag the caller's sampler had already settled.
 */
export function requireHeapCollector(sampler: HeapSampler): void {
  if (!sampler.isCollectorAvailable) {
    expect.fail("no garbage collector is reachable, so no heap reading is admissible");
  }
}

/**
 * One file's live adapters and their hosts, mounted and given back together.
 *
 * A class rather than module arrays, so one file's missed teardown cannot be read as another
 * file's leak.
 */
export class TerminalAdapterWorkload {
  readonly #liveAdapters: XtermTerminalAdapter[] = [];
  readonly #liveHosts: HTMLElement[] = [];

  /** Mount one adapter on a host of its own, and remember both. */
  public mount(terminalId: string, pool: TerminalRendererPool): XtermTerminalAdapter {
    const host = document.createElement("div");
    document.body.append(host);
    this.#liveHosts.push(host);
    const adapter = new XtermTerminalAdapter({ terminalId, pool });
    this.#liveAdapters.push(adapter);
    adapter.attach(host);
    return adapter;
  }

  /** Drive `lines` rows of the measurement width through the real parser. */
  public async writeLines(adapter: XtermTerminalAdapter, lines: number): Promise<void> {
    const line = `${"W".repeat(TERMINAL_BUDGET_MEASUREMENT_COLUMNS)}\n`;
    for (let written = 0; written < lines; written += WRITE_BATCH_LINES) {
      const batchLines = Math.min(WRITE_BATCH_LINES, lines - written);
      await new Promise<void>((resolve) => {
        adapter.write(line.repeat(batchLines), resolve);
      });
    }
  }

  /** Dispose every adapter and remove every host. Idempotent; safe in `afterEach`. */
  public disposeEverything(): void {
    for (const adapter of this.#liveAdapters.splice(0)) {
      adapter.dispose();
    }
    for (const host of this.#liveHosts.splice(0)) {
      host.remove();
    }
  }
}

/**
 * What a full scrollback retains, measured on the adapter a terminal pane mounts.
 *
 * The other half of the `terminal-instance-memory` row: the pane's standing cost and this figure
 * are two components of one ceiling that the row's harness adds, so both are measured at the
 * same width and depth. A warm-up fill precedes the baseline because `@xterm/xterm`'s
 * module-level state, parser tables and this process's first-fill allocations are paid once and
 * would otherwise land in the figure.
 */
export async function measureFullScrollbackRetainedBytes(
  workload: TerminalAdapterWorkload,
  pool: TerminalRendererPool,
  sampler: HeapSampler,
): Promise<number> {
  const warmUp = workload.mount("budget-scrollback-warm-up", pool);
  await workload.writeLines(warmUp, TERMINAL_DEFAULT_SCROLLBACK_LINES);
  warmUp.dispose();

  const baseline = await sampler.sample();
  const filled = workload.mount("budget-scrollback", pool);
  await workload.writeLines(filled, TERMINAL_DEFAULT_SCROLLBACK_LINES);
  // Read while the instance is still reachable: the figure is what a filled buffer retains, so
  // a sample after disposal would measure its absence.
  expect(
    filled.bufferLineCount,
    "the buffer took no line, so the scrollback half of this ceiling measured nothing",
  ).toBeGreaterThan(TERMINAL_DEFAULT_SCROLLBACK_LINES);
  const held = await sampler.sample();
  return retainedGrowthBytes(baseline, held);
}

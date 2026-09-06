// The adapter-level workload the two terminal endurance files share.
//
// Both of them drive the same thing — a real `XtermTerminalAdapter` on this tier's
// DOM shim, filled at a working width — and both have to give every instance back
// before the next case runs. Written once here because the mount, the batched
// write, and the teardown ledger are the measurement's INSTRUMENT: two copies are
// two workloads, and the budget's two halves would then be priced at widths, batch
// sizes, and teardown disciplines that had drifted apart without either file
// saying so.
//
// The width itself is deliberately NOT here. It is
// `TERMINAL_BUDGET_MEASUREMENT_COLUMNS` in the console's own constants module,
// beside the scrollback depth the same budget is read at, because a number the
// budget's meaning depends on belongs in the package's one cap home rather than in
// a test helper — and because the pane the budget bounds is measured against the
// same width from the other file.

import { expect } from "vitest";

import {
  TERMINAL_BUDGET_MEASUREMENT_COLUMNS,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
} from "../../../src/renderer/src/console/core/constants.js";
import type { TerminalRendererPool } from "../../../src/renderer/src/console/terminal/emulator/renderer-pool.js";
import { XtermTerminalAdapter } from "../../../src/renderer/src/console/terminal/emulator/xterm-adapter.js";
import { retainedGrowthBytes, type HeapSampler } from "../heap-sampling.js";

/** Lines per `write`. Batched: a per-line await pays a task hop ten thousand times. */
const WRITE_BATCH_LINES = 500;

/**
 * Refuse a heap reading no collection stands behind.
 *
 * Named rather than skipped: a heap figure with no collection behind it is noise,
 * and a tier that is green because it measured noise is worse than one that is loud
 * about the gap. Takes the sampler rather than resolving its own collector, because
 * the resolution is memoised per sampler and a second resolution here would flip a
 * process-wide flag the caller's sampler had already settled.
 */
export function requireHeapCollector(sampler: HeapSampler): void {
  if (!sampler.isCollectorAvailable) {
    expect.fail("no garbage collector is reachable, so no heap reading is admissible");
  }
}

/**
 * One file's live adapters and their hosts, mounted and given back together.
 *
 * A class rather than two module arrays, for the reason `heap-sampling.ts` gives
 * for its own sampler: a ledger the whole tier shared would let one file's missed
 * teardown be read as another file's leak, and this tier's whole question is
 * whether the number comes back.
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
 * What a FULL scrollback retains, measured on the adapter a terminal pane mounts.
 *
 * The other half of the `terminal-instance-memory` row, and the reason it is a
 * function rather than a case: the pane's standing cost and this figure are two
 * components of ONE ceiling, and the row's harness adds them before it compares.
 * Measured at the same width and the same depth the pane is measured at, so the sum
 * is a sum of one terminal's parts rather than of two different terminals'.
 *
 * WHY A WARM-UP FILL PRECEDES THE BASELINE. `@xterm/xterm`'s module-level state,
 * its parser tables, and this process's own first-fill allocations are paid ONCE.
 * Measured from a cold baseline they land inside the figure and the row is charged
 * a library it does not own — the same discipline, and the same reason, as the
 * warm-up cycle the pane half takes before ITS baseline.
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
  // Read while the instance is still reachable: the figure is what a filled buffer
  // RETAINS, so a sample taken after the disposal would measure its absence.
  expect(
    filled.bufferLineCount,
    "the buffer took no line, so the scrollback half of this ceiling measured nothing",
  ).toBeGreaterThan(TERMINAL_DEFAULT_SCROLLBACK_LINES);
  const held = await sampler.sample();
  return retainedGrowthBytes(baseline, held);
}

// What the ledger window is showing, read from the renderer rather than counted off
// the page.
//
// Its own module because it is a different job from `console-workload.ts`: that one
// owns the ACTS this tier performs on a running console — open a route, churn it,
// read a counter — and this owns one QUESTION and the care it takes to ask it. The
// care is the whole of the module: which element actually is a row, how long to wait
// for one, and what to do when the wait expires.

import type { ConsoleApplication } from "../electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../launch-body.js";
import {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  type ConsoleSessionDiagnostics,
  type LedgerWindowReading,
} from "../fixture-handles.js";

/**
 * One ledger row BOX — the element the window mounts, not the card drawn inside it.
 *
 * A different set from `console-workload.ts`' `LEDGER_ROW_SELECTOR`, and the
 * distinction is load-bearing here. `meridian-ledger-row` is
 * `primitives/LedgerRow.tsx`, a presentation primitive the runs pane uses too and
 * that a row body may or may not reach for; `meridian-ledger-viewport__row` is the
 * absolutely-positioned box the virtualizer places, so it is one per mounted virtual
 * item by construction. A windowing claim has to wait on the BOX: waiting on the card
 * counts whichever bodies happened to draw with that primitive, which is a fact about
 * the card vocabulary rather than about the window.
 */
export const LEDGER_ROW_BOX_SELECTOR: string =
  ".meridian-frame__surface .meridian-ledger-viewport__row";

/**
 * Wait for the ledger to have reconciled a row, then report its window.
 *
 * THE WAIT IS WHY THE READING MEANS ANYTHING: a route change is observed on the
 * ledger's BODY, which the workspace mounts whether or not the session has rows, so a
 * reading taken straight after one describes whatever had reconciled when the driver
 * asked.
 *
 * AN EXPIRED WAIT IS NOT THE FAILURE, though: no row on screen is the state this
 * reading exists to describe, so the expiry is recorded and the window read anyway
 * rather than discarded — the figures say WHICH no-row state it is, and `null` says a
 * further one, that no viewport is registered at all. Only a timeout is absorbed;
 * anything else is a harness fault and is rethrown.
 */
export async function readLedgerWindow(
  consoleApplication: ConsoleApplication,
  sessionId: string,
): Promise<LedgerWindowReading | null> {
  const firstLedgerRow = consoleApplication.window.locator(LEDGER_ROW_BOX_SELECTOR).first();
  try {
    // The allowance is spelled INSIDE the wait's own arguments rather than bound to a
    // local first: `architecture/body-allowance-consumption.test.ts` reads the call's
    // argument list, so a hoisted local charges the allowance correctly and still reads
    // as a wait bounded by something else.
    await firstLedgerRow.waitFor({
      state: "attached",
      timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
    });
  } catch (waitFailure: unknown) {
    // `name` is playwright-core's own discriminator: at the pinned 1.62.1 its
    // `TimeoutError extends PlaywrightError extends Error` sets exactly this string.
    if (!(waitFailure instanceof Error) || waitFailure.name !== "TimeoutError") {
      throw waitFailure;
    }
    process.stdout.write("[console-endurance] no ledger row attached within the allowance\n");
  }
  return consoleApplication.window.evaluate(
    ([globalName, targetSessionId]: [string, string]) => {
      const sessions = (
        globalThis as unknown as Record<string, ConsoleSessionDiagnostics | undefined>
      )[globalName];
      return sessions === undefined ? null : sessions.ledgerWindowFor(targetSessionId);
    },
    [SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, sessionId] as [string, string],
  );
}

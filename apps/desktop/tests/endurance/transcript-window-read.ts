// What the transcript window is showing, read from the renderer rather than counted off
// the page.
//
// Its own module because it is a different job from `endurance-workload.ts`: that one
// owns the ACTS this tier performs on a running console — open a route, churn it,
// read a counter — and this owns one QUESTION and the care it takes to ask it. The
// care is the whole of the module: which element actually is a row, how long to wait
// for one, and what to do when the wait expires.

import type { AppUnderTest } from "../helpers/electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL } from "@renderer/app/fixture-global-names.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { type TranscriptWindowReading } from "@renderer/lib/transcript-window-diagnostics.js";

/**
 * One transcript row BOX — the element the window mounts, not the card drawn inside it.
 *
 * A different set from `endurance-workload.ts`' `TRANSCRIPT_ROW_SELECTOR`, and the
 * distinction is load-bearing here. `meridian-transcript-row-layout` is
 * `components/TranscriptRowLayout/TranscriptRowLayout.tsx`, a presentation primitive
 * that a row body may or may not reach for; `meridian-transcript-viewport__row` is the
 * absolutely-positioned box the virtualizer places, so it is one per mounted virtual
 * item by construction. A windowing claim has to wait on the BOX: waiting on the card
 * counts whichever bodies happened to draw with that primitive, which is a fact about
 * the card vocabulary rather than about the window.
 */
export const TRANSCRIPT_ROW_BOX_SELECTOR: string =
  ".meridian-frame__screen .meridian-transcript-viewport__row";

/**
 * Wait for the transcript to have reconciled a row, then report its window.
 *
 * THE WAIT IS WHY THE READING MEANS ANYTHING: a route change is observed on the
 * transcript's BODY, which the session screen mounts whether or not the session has rows, so a
 * reading taken straight after one describes whatever had reconciled when the driver
 * asked.
 *
 * AN EXPIRED WAIT IS NOT THE FAILURE, though: no row on screen is the state this
 * reading exists to describe, so the expiry is recorded and the window read anyway
 * rather than discarded — the figures say WHICH no-row state it is, and `null` says a
 * further one, that no viewport is registered at all. Only a timeout is absorbed;
 * anything else is a harness fault and is rethrown.
 */
export async function readTranscriptWindow(
  consoleApplication: AppUnderTest,
  sessionId: string,
): Promise<TranscriptWindowReading | null> {
  const firstTranscriptRow = consoleApplication.window.locator(TRANSCRIPT_ROW_BOX_SELECTOR).first();
  try {
    // The allowance is spelled INSIDE the wait's own arguments rather than bound to a
    // local first: a hoisted local charges the allowance correctly and still reads as
    // a wait bounded by something else.
    await firstTranscriptRow.waitFor({
      state: "attached",
      timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
    });
  } catch (waitFailure: unknown) {
    // `name` is playwright-core's own discriminator: at the pinned 1.62.1 its
    // `TimeoutError extends PlaywrightError extends Error` sets exactly this string.
    if (!(waitFailure instanceof Error) || waitFailure.name !== "TimeoutError") {
      throw waitFailure;
    }
    process.stdout.write("[console-endurance] no transcript row attached within the allowance\n");
  }
  return consoleApplication.window.evaluate(
    ([globalName, targetSessionId]: [string, string]) => {
      const sessions = (globalThis as unknown as Record<string, SessionDiagnostics | undefined>)[
        globalName
      ];
      return sessions === undefined ? null : sessions.transcriptWindowFor(targetSessionId);
    },
    [SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, sessionId] as [string, string],
  );
}

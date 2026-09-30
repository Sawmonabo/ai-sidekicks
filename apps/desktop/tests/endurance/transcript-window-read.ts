// What the transcript window is showing, read from the renderer rather than counted off the
// page. Separate from `endurance-workload.ts`, which owns the acts this tier performs on a
// running console; this owns one question and the care it takes to ask it: which element is a
// row, how long to wait for one, and what to do when the wait expires.

import type { AppUnderTest } from "../helpers/electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL } from "@renderer/app/fixture-global-names.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { type TranscriptWindowReading } from "@renderer/lib/transcript-window-diagnostics.js";

/**
 * One transcript row box: the element the window mounts, not the card drawn inside it.
 *
 * `meridian-transcript-viewport__row` is the absolutely positioned box the virtualizer places,
 * one per mounted virtual item. The selector in `endurance-workload.ts` matches
 * `TranscriptRowLayout`, a primitive a row body may or may not use, so waiting on it would
 * count a fact about the card vocabulary rather than the window.
 */
export const TRANSCRIPT_ROW_BOX_SELECTOR: string =
  ".meridian-frame__screen .meridian-transcript-viewport__row";

/**
 * Waits for the transcript to have reconciled a row, then reports its window.
 *
 * The wait is why the reading means anything: a route change is observed on the transcript's
 * body, which the session screen mounts whether or not the session has rows, so an immediate
 * reading describes whatever had reconciled when the driver asked. An expired wait is not the
 * failure: no row on screen is a state this reading describes, so the expiry is logged and the
 * window read anyway, and `null` says no viewport is registered at all. Only a timeout is
 * absorbed; anything else is a harness fault and is rethrown.
 */
export async function readTranscriptWindow(
  consoleApplication: AppUnderTest,
  sessionId: string,
): Promise<TranscriptWindowReading | null> {
  const firstTranscriptRow = consoleApplication.window.locator(TRANSCRIPT_ROW_BOX_SELECTOR).first();
  try {
    // The allowance is spelled inside the wait's own arguments; a hoisted local charges it
    // correctly but reads as a wait bounded by something else.
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

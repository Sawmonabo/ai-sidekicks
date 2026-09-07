// The crashed-window signal: the window that stopped being open without being asked.
//
// One of the two window signals `aux-handoff.ts` holds, and this file is only what
// makes it THIS one — which operation it opens, what it hands the hand-off, and the
// two sentences a placeholder shows when the signal stops. The lifecycle underneath —
// the single-flight start, the round that keeps a stale reply from installing a stream
// nothing will drain, the claim held across the whole drain, and the two endings that
// are the same fact — is `aux-window-signal-watch.ts`, shared with the return signal.
//
// `Spec-023 §The surface set`: "a crashed auxiliary window returns the pane to the
// deck with the crash noted in the pane's error slot" needs something to notice the
// crash, and the growth registry carries exactly one: a window pane-error
// subscription whose value is a pane id and a reason. It is watched only while
// something is detached, because a subscription held over an empty detached set can
// report nothing and its refusal would be a permanent notice about a hazard the
// window does not currently have. A refused subscription is rendered in the
// placeholder it belongs to: it does not mean "no crashes".

import { settledGrowthCall } from "../../bridge/index.js";
import { AuxiliaryWindowSignalWatch, type ConsoleGrowthPort } from "./aux-window-signal-watch.js";

/**
 * The served value of the pane-error subscription, taken off the port rather than
 * imported.
 *
 * The bridge door exports the bridge and not the stream shape, deliberately, and a
 * door line opened for this one type would be a second name for a wire fact the open
 * door already carries. The event follows from the stream by inference, so neither
 * half of the signal's shape is written down twice.
 */
type PaneErrorSignal = Extract<
  Awaited<ReturnType<ConsoleGrowthPort["windowSubscribePaneErrors"]>>,
  { readonly status: "served" }
>["value"];

/** One crashed window, as the signal reports it: the pane it held, and why. */
type PaneErrorReport =
  PaneErrorSignal["events"] extends AsyncIterable<infer TEvent> ? TEvent : never;

/** The crashed-window signal, at the one type argument that makes it that signal. */
export type PaneErrorWatch = AuxiliaryWindowSignalWatch<PaneErrorReport>;

/**
 * The one key the pane-error watch is claimed under.
 *
 * There is exactly one crash signal per hand-off, so one key: the latch's subject is
 * the watch itself and the register never holds more than this. The return signal
 * takes a key of its own, because the two are started and stopped together but
 * SETTLE independently — one key for both would make a reply to one invalidate the
 * other's round.
 */
const PANE_ERROR_WATCH_KEY = "pane-error-watch";

export interface PaneErrorWatchOptions {
  readonly growth: ConsoleGrowthPort;
  /** A window reported lost, by the pane it held and the reason it gave. */
  readonly onWindowLost: (paneId: string, reason: string) => void;
  /** The refusal changed. The hand-off publishes; this module never does. */
  readonly onChanged: () => void;
}

/**
 * Watch the crashed-window signal.
 *
 * Settled at the seam rather than inside the shared lifecycle: a rejecting subscribe
 * has to land in the same arm as a wire that was never registered, and which
 * operation id that refusal names is this signal's fact rather than the lifecycle's.
 */
export function paneErrorWatch(options: PaneErrorWatchOptions): PaneErrorWatch {
  return new AuxiliaryWindowSignalWatch({
    watchKey: PANE_ERROR_WATCH_KEY,
    open: async () =>
      await settledGrowthCall("windowSubscribePaneErrors", () =>
        options.growth.windowSubscribePaneErrors({}),
      ),
    onEvent: (paneError) => {
      options.onWindowLost(paneError.paneId, paneError.reason);
    },
    onChanged: options.onChanged,
    endedDetail:
      "The signal that reports a lost window ended. A window that closes unexpectedly will no longer return its pane on its own.",
    stoppedDetailFor: (cause) => `The signal that reports a lost window stopped: ${cause}`,
  });
}

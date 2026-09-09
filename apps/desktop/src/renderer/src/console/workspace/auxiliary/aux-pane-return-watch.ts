// The orderly-return signal: the window that was asked to close and did.
//
// The sibling of `aux-pane-error-watch.ts`, and everything the two share is in
// `aux-window-signal-watch.ts`. This file is only what makes it THIS signal — which
// operation it opens, what it hands the hand-off, and the two sentences a placeholder
// shows when the signal stops.
//
// WHY A SECOND SIGNAL RATHER THAN A MEMBER ON THE FIRST. The deck renders the two
// oppositely: a crash leaves a note in the pane's error slot saying the window died,
// and a return leaves nothing at all, because the pane came back the way somebody
// asked it to. Folded into one stream with a nullable reason, telling them apart
// would be a member read, and every reader that forgot would report a crash that did
// not happen.
//
// AND THE DECK CANNOT DERIVE IT. A deck that closes a window already knows it did and
// clears the slot locally; a window that closes ITSELF — through its own header
// control — is a fact only the shell can report. Without this channel the deck holds
// a placeholder, and a focus control, for a window that no longer exists, until the
// person reloads.

import {
  AuxiliaryWindowSignalWatch,
  type ConsoleAuxiliaryWindowPort,
} from "./aux-window-signal-watch.js";

/**
 * The served value of the pane-return subscription, taken off the port rather than
 * imported — `aux-pane-error-watch.ts` states the reason, and it is the same one.
 */
type PaneReturnSignal = Extract<
  Awaited<ReturnType<ConsoleAuxiliaryWindowPort["subscribePaneReturns"]>>,
  { readonly status: "served" }
>["value"];

/** One window that gave its pane back: which window it was, and which pane. */
type PaneReturnReport =
  PaneReturnSignal["events"] extends AsyncIterable<infer TEvent> ? TEvent : never;

/** The orderly-return signal, at the one type argument that makes it that signal. */
export type PaneReturnWatch = AuxiliaryWindowSignalWatch<PaneReturnReport>;

/** The one key the pane-return watch is claimed under. Its own, per the sibling's note. */
const PANE_RETURN_WATCH_KEY = "pane-return-watch";

export interface PaneReturnWatchOptions {
  readonly auxiliaryWindows: ConsoleAuxiliaryWindowPort;
  /**
   * A window gave its pane back, named by the window as well as the pane.
   *
   * The window handle is carried rather than dropped because a pane can be detached
   * again into a SECOND window, so a late report about the first would otherwise put
   * back a pane whose body is currently in the second.
   */
  readonly onWindowReturned: (paneId: string, windowId: string) => void;
  /** The refusal changed. The hand-off publishes; this module never does. */
  readonly onChanged: () => void;
}

/** Watch the orderly-return signal. Settled by the plane, per the sibling's note. */
export function paneReturnWatch(options: PaneReturnWatchOptions): PaneReturnWatch {
  return new AuxiliaryWindowSignalWatch({
    watchKey: PANE_RETURN_WATCH_KEY,
    open: async () => await options.auxiliaryWindows.subscribePaneReturns(),
    onEvent: (paneReturn) => {
      options.onWindowReturned(paneReturn.paneId, paneReturn.windowId);
    },
    onChanged: options.onChanged,
    endedDetail:
      "The signal that reports a window closing itself ended. A window closed from its own header will leave its placeholder behind.",
    stoppedDetailFor: (cause) =>
      `The signal that reports a window closing itself stopped: ${cause}`,
  });
}

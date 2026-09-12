// The two signals that report a window ending, held as one pair.
//
// SPLIT FROM `aux-handoff.ts`, WHICH OWNS THE SETS. That file answers which panes are
// in windows right now and which windows were lost; this one answers whether anything
// is listening for a window's ending at all, and when that listening starts and stops.
// The cut is along that seam rather than at a line count: the sets change when the
// deck's acts change, and the pair below changes when the shell's reporting does.
//
// AND A WINDOW THAT STOPS BEING OPEN COMES BACK THROUGH A SIGNAL, NOT A GUESS —
// EITHER WAY IT STOPS. Two things end a window's life and the deck can derive neither:
// a crash, which has to be noted in the pane's error slot, and a close performed from
// the window's OWN header, which this process never performed and so does not know
// about. Hence two subscriptions, one per fact — `aux-pane-error-watch.ts` and
// `aux-pane-return-watch.ts`, both over the lifecycle in `aux-window-signal-watch.ts`.
// They open and close TOGETHER, because both are about panes that are in windows right
// now and neither has anything to report when none is.
//
// AND THEY OPEN BEFORE THE FIRST WINDOW IS ASKED FOR. The shell's report is ONE-SHOT —
// `src/main/auxiliary-window-ipc.ts`'s `closed` listener sends it to the renderer that
// asked and forgets the window — so an ending that arrives before anything is
// listening is not late, it is gone: the deck keeps a placeholder over a dead window
// and the crash notice that heading requires is never rendered. The subscriptions used
// to be opened by an effect above the hand-off, which runs after the detached
// projection COMMITS, so every ending between `detachPane` resolving and that commit
// was lost.
//
// SO THE OPEN IS SEQUENCED AGAINST THE DETACH RATHER THAN BUFFERED BEHIND IT.
// Buffering was the other candidate and it cannot be made total: nothing renderer-side
// holds an ending until a watch opens, because `bridge/auxiliary-window-port.ts`
// registers its shell listener lazily on the first `subscribePaneErrors` — before that
// call there is no listener, so there is nothing to buffer INTO and the report is
// dropped a process boundary below any queue this module could own. Opening first
// removes the window instead of narrowing it: that registration is synchronous, so
// {@link AuxiliaryEndingSignals.openWithoutWaiting} has installed both listeners by
// the time it returns, and `bridge/window-signal-stream.ts` queues whatever arrives
// before a drain starts.

import { paneErrorWatch, type PaneErrorWatch } from "./aux-pane-error-watch.js";
import { paneReturnWatch, type PaneReturnWatch } from "./aux-pane-return-watch.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";
import { type AuxiliaryHandoffRefusal } from "./aux-handoff-contract.js";

export interface AuxiliaryEndingSignalsOptions {
  readonly auxiliaryWindows: ConsoleAuxiliaryWindowPort;
  /**
   * A window stopped being open without anybody asking, named by the window as well
   * as the pane, and why it says it did.
   */
  readonly onWindowLost: (paneId: string, windowId: string, reason: string) => void;
  /** A window gave its pane back, named by the window as well as the pane. */
  readonly onWindowReturned: (paneId: string, windowId: string) => void;
  /** A refusal changed. The hand-off publishes; this module never does. */
  readonly onChanged: () => void;
}

/**
 * Both window-ending signals, opened and closed as one.
 *
 * A CLASS RATHER THAN TWO FIELDS ON THE HAND-OFF, because "is anything listening" is
 * one fact with two implementations: a caller able to open one without the other would
 * have two ways to be half-watching, and the half it left closed would be silent
 * rather than refused.
 */
export class AuxiliaryEndingSignals {
  /**
   * The crashed-window signal. It holds no set of its own: a lost window is recorded
   * by the hand-off, through the same method a caller would use, so the two arms
   * cannot drift into two spellings of one act.
   */
  readonly #paneErrors: PaneErrorWatch;
  /**
   * The orderly-return signal — a SECOND WATCH rather than a second arm on the first,
   * because the two report opposite facts and the deck renders one as a note and the
   * other as nothing at all.
   */
  readonly #paneReturns: PaneReturnWatch;

  public constructor(options: AuxiliaryEndingSignalsOptions) {
    this.#paneErrors = paneErrorWatch({
      auxiliaryWindows: options.auxiliaryWindows,
      onWindowLost: options.onWindowLost,
      onChanged: options.onChanged,
    });
    this.#paneReturns = paneReturnWatch({
      auxiliaryWindows: options.auxiliaryWindows,
      onWindowReturned: options.onWindowReturned,
      onChanged: options.onChanged,
    });
  }

  /**
   * Why the crashed-window signal is not being received, where it is not.
   *
   * Rendered in the placeholder rather than swallowed: a subscription this build
   * cannot open is not the same fact as a window that has not crashed, and a slot that
   * showed nothing would be claiming the second.
   */
  public get lostWindowRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#paneErrors.refusal;
  }

  /**
   * Why the orderly-return signal is not being received, where it is not.
   *
   * Its own reading rather than one fused with the crash signal's, because the two say
   * different things: an unreceived crash signal means a window that dies takes its
   * pane with it, and an unreceived return signal means a window that closes itself
   * leaves a placeholder behind. A caller that renders one line renders whichever it
   * has; it is not this class's job to pick for it.
   */
  public get returnedWindowRefusal(): AuxiliaryHandoffRefusal | undefined {
    return this.#paneReturns.refusal;
  }

  /**
   * Open both, and resolve when both drains have ended.
   *
   * Idempotent: each watch answers a second call with a no-op, whether or not its
   * first request has come back. Neither can reject — each settles its own failures
   * into its own refusal — so the pair resolves rather than throwing.
   */
  public async open(): Promise<void> {
    await Promise.all([this.#paneErrors.start(), this.#paneReturns.start()]);
  }

  /**
   * Open both without waiting for either drain to end.
   *
   * The form a caller that is about to open a window uses. {@link open} parks until
   * the subscriptions END, which is the life of the window; what a detach needs is the
   * installation, and both watches perform theirs inside this call.
   */
  public openWithoutWaiting(): void {
    void this.open();
  }

  /** Close both. Called when the last pane comes back, and on teardown. */
  public close(): void {
    this.#paneErrors.stop();
    this.#paneReturns.stop();
  }
}

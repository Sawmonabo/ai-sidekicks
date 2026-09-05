// Which of the pane's acts is the one whose answer may still be rendered.
//
// The chrome dispatches acts that OVERLAP. Reload is a round trip through the
// preload boundary into a page that may be waiting on a network the console knows
// nothing about, and the control that started it is the same control a person
// presses to stop it — so "reload is still pending, stop was pressed and served,
// reload then rejects" is not an exotic interleaving but the ordinary way that one
// slot is used. Rendering every completion as it lands finishes that sequence by
// showing the failure of the act the operator ALREADY replaced, over a pane whose
// most recent act succeeded.
//
// So each act takes a token as it is dispatched, and a completion writes only while
// its token is still the newest. What is guarded is the whole write and not just the
// refusing half: an older act that SERVED would otherwise clear a newer act's
// refusal, which is the same defect with the two outcomes swapped.
//
// A LOCAL REFUSAL IS AN ACT TOO. The address field's filesystem guard and the
// close-tab chord settle here without crossing the boundary at all, and they are the
// person's newest act at the moment they settle — so they take a token like every
// other, and a call dispatched before them can no longer overwrite what they said.
//
// DISMISSAL DELIBERATELY TAKES NO TOKEN. It says "I have read this", not "I have
// started something newer": an act that was already in flight when the banner was
// dismissed is still the newest thing the pane is doing, and its failure is news.
//
// AND EVERY ONE OF THOSE ACTS BELONGS TO A SUBJECT. A token orders acts against each
// other and says nothing about which pane they were dispatched for, so a deck that
// rebinds this component to another `paneId` or another bridge kept both halves: a
// navigation dispatched under the previous subject settled afterwards and published
// its refusal beside the NEW pane, naming a page nobody was looking at, and a local
// refusal already on screen stayed there across the swap. So the refusal carries the
// `(bridge, paneId)` it was raised under and the render compares it, and the tokens
// outstanding under a retired subject are superseded rather than left to write.

import { useCallback, useEffect, useState } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection, refuse, type ConsoleRefusal } from "../../core/index.js";

/** The subsystem name every refusal this pane raises itself carries. */
const BROWSER_PANE_REFUSAL_ORIGIN = "browser-pane";

/**
 * The caller-written refusal for a rejection carrying no code of its own, derived
 * from the normalizer that consumes it rather than restated here — a second
 * declaration of that shape would agree with the first only until one was widened.
 */
type ActRejectionFallback = NonNullable<Parameters<typeof normalizeWireRejection>[2]>;

/**
 * Which dispatched act is the newest one.
 *
 * A counter in an encapsulated class rather than a number in a ref, because the two
 * questions callers ask of it — "give me a token" and "is this token still current"
 * — are the whole seam, and a bare number invites each call site to compare it its
 * own way. Monotonic and never reset: a token is only ever compared against the
 * newest, so the count is free to run for the life of the pane.
 */
class BrowserActSequence {
  #newestToken = 0;

  /** Take the token for an act being dispatched now. Every later act outranks it. */
  public begin(): number {
    this.#newestToken += 1;
    return this.#newestToken;
  }

  /** Whether this token still names the newest act, and so may write. */
  public isNewest(token: number): boolean {
    return token === this.#newestToken;
  }

  /**
   * Retire every token taken so far, so nothing still in flight may write.
   *
   * The counter ADVANCES rather than resets, which is the whole difference between
   * this and minting a fresh sequence: a reset would start the replacement subject's
   * first act at the same number an outstanding act from the previous one already
   * holds, and `isNewest` would then let that stale act write against the new pane —
   * the defect, reintroduced by the fix for it.
   */
  public supersedeOutstanding(): void {
    this.#newestToken += 1;
  }
}

/** A refusal and the `(bridge, paneId)` the act that raised it was dispatched for. */
interface StampedActRefusal {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
  readonly refusal: ConsoleRefusal | undefined;
}

/** The pane's acts, and the one refusal they report between them. */
export interface BrowserPaneActs {
  /** The newest act's refusal, or `undefined` where the newest act did not refuse. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * Dispatch one act. The thunk answers with the refusal to render, or `undefined`
   * where the act was served; a rejection is normalized through the console's one
   * wire-rejection reader, so a code the other side sent survives.
   */
  run(act: () => Promise<ConsoleRefusal | undefined>, fallback: ActRejectionFallback): void;
  /** Refuse here and now, without crossing the boundary. Outranks anything in flight. */
  refuseLocally(code: string, detail: string): void;
  /** Clear what is on screen. Starts nothing, and supersedes nothing. */
  dismiss(): void;
}

/**
 * Hold one pane's act ordering and the one refusal it renders.
 *
 * The sequence is minted in a `useState` initializer rather than a `useRef` so it is
 * constructed once per mount and never on a re-render, which is the same shape the
 * pane's geometry publisher already takes. The three operations are stable for as
 * long as the subject is — only `refusal` changes — so a caller's `useCallback` over
 * them does not churn on every settled act.
 *
 * TWO MECHANISMS, BECAUSE THEY CLOSE TWO DIFFERENT GAPS. The stamp is compared
 * during RENDER, so the pass that first sees the replacement subject already shows
 * no refusal — an effect would clear it one pass late, and that pass is on screen.
 * Superseding runs in the effect's CLEANUP, so an act dispatched under the retired
 * subject writes nothing at all rather than writing a refusal the stamp then has to
 * hide; the same cleanup covers unmount, where there is no later render to compare.
 */
export function useBrowserPaneActs(bridge: ConsoleBridge, paneId: string): BrowserPaneActs {
  const [sequence] = useState(() => new BrowserActSequence());
  const [stamped, setStamped] = useState<StampedActRefusal>({
    bridge,
    paneId,
    refusal: undefined,
  });

  useEffect(
    () => () => {
      // The subject is changing, or the pane is going. Whatever is in flight was
      // dispatched for a pane this hook no longer serves.
      sequence.supersedeOutstanding();
    },
    [sequence, bridge, paneId],
  );

  const publish = useCallback(
    (refusal: ConsoleRefusal | undefined): void => {
      setStamped({ bridge, paneId, refusal });
    },
    [bridge, paneId],
  );

  const run = useCallback(
    (act: () => Promise<ConsoleRefusal | undefined>, fallback: ActRejectionFallback): void => {
      const token = sequence.begin();
      void act().then(
        (outcome) => {
          if (sequence.isNewest(token)) {
            publish(outcome);
          }
        },
        (failure: unknown) => {
          if (sequence.isNewest(token)) {
            publish(normalizeWireRejection(BROWSER_PANE_REFUSAL_ORIGIN, failure, fallback));
          }
        },
      );
    },
    [publish, sequence],
  );

  const refuseLocally = useCallback(
    (code: string, detail: string): void => {
      sequence.begin();
      publish(refuse(BROWSER_PANE_REFUSAL_ORIGIN, code, detail));
    },
    [publish, sequence],
  );

  const dismiss = useCallback((): void => {
    publish(undefined);
  }, [publish]);

  const refusal =
    stamped.bridge === bridge && stamped.paneId === paneId ? stamped.refusal : undefined;

  return { refusal, run, refuseLocally, dismiss };
}

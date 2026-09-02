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

import { useCallback, useState } from "react";

import { refusalFromRejection, refuse, type ConsoleRefusal } from "../../core/index.js";

/** The subsystem name every refusal this pane raises itself carries. */
const BROWSER_PANE_REFUSAL_ORIGIN = "browser-pane";

/**
 * The caller-written refusal for a rejection carrying no code of its own, derived
 * from the normalizer that consumes it rather than restated here — a second
 * declaration of that shape would agree with the first only until one was widened.
 */
type ActRejectionFallback = NonNullable<Parameters<typeof refusalFromRejection>[2]>;

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
 * Hold the pane's act ordering and the one refusal it renders.
 *
 * The sequence is minted in a `useState` initializer rather than a `useRef` so it is
 * constructed once per mount and never on a re-render, which is the same shape the
 * pane's geometry publisher already takes. The three operations are stable across
 * renders — only `refusal` changes — so a caller's `useCallback` over them does not
 * churn on every settled act.
 */
export function useBrowserPaneActs(): BrowserPaneActs {
  const [sequence] = useState(() => new BrowserActSequence());
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);

  const run = useCallback(
    (act: () => Promise<ConsoleRefusal | undefined>, fallback: ActRejectionFallback): void => {
      const token = sequence.begin();
      void act().then(
        (outcome) => {
          if (sequence.isNewest(token)) {
            setRefusal(outcome);
          }
        },
        (failure: unknown) => {
          if (sequence.isNewest(token)) {
            setRefusal(refusalFromRejection(BROWSER_PANE_REFUSAL_ORIGIN, failure, fallback));
          }
        },
      );
    },
    [sequence],
  );

  const refuseLocally = useCallback(
    (code: string, detail: string): void => {
      sequence.begin();
      setRefusal(refuse(BROWSER_PANE_REFUSAL_ORIGIN, code, detail));
    },
    [sequence],
  );

  const dismiss = useCallback((): void => {
    setRefusal(undefined);
  }, []);

  return { refusal, run, refuseLocally, dismiss };
}

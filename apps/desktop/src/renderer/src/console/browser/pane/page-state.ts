// What the pane KNOWS about the session's pages, as opposed to what the strip draws.
//
// `Spec-023 §Console Design (Meridian)` 12.2 gives the strip and the page picker one
// reading between them — "one tab per page this session owns" and "every page the
// session owns ... including background pages" are two renderings of one list — so
// the subscription and the shape it yields live here, and neither component holds a
// second copy of either. The rule this protects is the section's own: the chrome
// derives nothing. Which tab is selected, which page is shown, and whether a page is
// loading are all read off the frame, never inferred from the last act dispatched.
//
// THE SHAPES ARE DERIVED FROM THE GROWTH PORT rather than restated, for
// `navigation-state.ts`' reason: writing the page members out again would be a second
// declaration of a contract this family does not own, and the two would agree only
// until somebody widened one.
//
// WHY IT IS A SECOND SUBSCRIPTION AND NOT AN ARM OF THE FIRST. The navigation reading
// answers "where is the page this pane is showing"; this one answers "what pages does
// this session own". A pane showing nothing still owns pages, and a pane showing a
// page whose list has not arrived still has a URL to render — so a single reading
// would have to carry two independent absences and every consumer would branch on
// both anyway.

import { useEffect } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection } from "../../core/index.js";
import type { ReadingState } from "../../primitives/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import type { BrowserPaneRejectionFallback } from "./pane-refusals.js";

/** The subsystem name every refusal this module raises itself carries. */
const PAGE_LIST_REFUSAL_ORIGIN = "browser-pages";

/**
 * What a broken page subscription refuses under, where the failure carries no code.
 *
 * Distinct from the navigation subscription's fallback and deliberately so: the two
 * subscriptions fail independently, and a pane that lost its page list still reports
 * where it is. Collapsing them onto one code would tell a person the pane has stopped
 * being told anything when half of it is still being told.
 */
const PAGE_SUBSCRIPTION_FAILURE_FALLBACK: BrowserPaneRejectionFallback = {
  code: "page-subscription-failed",
  detail:
    "The pages this session owns are no longer being reported to this window. Closing the pane and opening it again starts a new subscription.",
};

/** The subscription's own outcome type, and the shapes read out of it. */
type PageListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribePages"]>>;
type PageListStream = Extract<PageListOutcome, { readonly status: "served" }>["value"];
type PageListFrame = PageListStream extends { readonly events: AsyncIterable<infer Event> }
  ? Event
  : never;

/** One page the session owns, as every surface in this family reads it. */
export type BrowserPage = PageListFrame["pages"][number];

/**
 * What the pane knows about the session's pages right now.
 *
 * The same four arms `navigation-state.ts` declares and for the same reasons — an
 * ended subscription is a fact rather than the absence of one, and the closed union
 * is what stops a consumer leaving it unhandled. `ended` carries no last frame: a
 * strip drawing tabs nobody is reporting any more offers close controls over pages
 * whose existence is a memory.
 */
export type PageListReading =
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & { readonly frame: PageListFrame })
  | Extract<ReadingState, { readonly kind: "refused" }>
  | { readonly kind: "ended" };

/** The reading before any subject has been answered, and after one has changed. */
const UNREAD_PAGE_LIST: PageListReading = { kind: "reading" };

/**
 * Subscribe to the pages this pane's session owns, for the life of the pane.
 *
 * Both arms are implemented, all four endings are handled, and the reading is held
 * for its subject — the three properties `navigation-state.ts` states at length and
 * this module obeys by construction rather than by restating them. The one difference
 * worth naming is what a changed subject costs here: a strip that kept the previous
 * pane's tabs would offer a close control that closes another pane's page, so the
 * unread arm is what a swapped subject renders.
 */
export function useReportedPages(bridge: ConsoleBridge, paneId: string): PageListReading {
  const { value: reading, publish } = useSubjectScopedState(bridge, paneId, () => UNREAD_PAGE_LIST);

  useEffect(() => {
    let stream: PageListStream | undefined;
    let cancelled = false;
    /** Close the acquired stream at most once, from whichever path reaches it first. */
    const closeStream = (): void => {
      const acquired = stream;
      stream = undefined;
      acquired?.close();
    };
    void (async () => {
      try {
        const outcome = await bridge.growth.browserSubscribePages({ paneId });
        if (cancelled) {
          // Whoever finishes last owns the stream: cleanup ran while `stream` was
          // still undefined, so a stream served after that point is closed here or
          // never.
          if (outcome.status === "served") {
            outcome.value.close();
          }
          return;
        }
        if (outcome.status === "unavailable") {
          publish({ kind: "refused", scope: "whole-answer", refusal: outcome });
          return;
        }
        stream = outcome.value;
        for await (const frame of stream.events) {
          if (cancelled) {
            return;
          }
          publish({ kind: "served", frame });
        }
        closeStream();
        if (!cancelled) {
          publish({ kind: "ended" });
        }
      } catch (failure) {
        closeStream();
        if (!cancelled) {
          publish({
            kind: "refused",
            scope: "whole-answer",
            refusal: normalizeWireRejection(
              PAGE_LIST_REFUSAL_ORIGIN,
              failure,
              PAGE_SUBSCRIPTION_FAILURE_FALLBACK,
            ),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [bridge, paneId, publish]);

  return reading;
}

/**
 * The pages a served reading carries, and nothing on any other arm.
 *
 * A helper rather than a `reading.kind === "served" ? … : []` at three call sites,
 * because the empty array those call sites would write is exactly the claim rule 8
 * forbids: "this session owns no pages" is a different sentence from "nobody has
 * answered yet", and a component that flattened them would render the first for the
 * second. The name says which question it answers, and every caller still branches on
 * the reading itself to decide what to draw around the result.
 */
export function pagesOf(reading: PageListReading): readonly BrowserPage[] {
  return reading.kind === "served" ? reading.frame.pages : [];
}

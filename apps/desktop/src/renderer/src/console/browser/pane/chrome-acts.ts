// What each control in the pane's chrome dispatches, in one place.
//
// `Spec-023 §Console Design (Meridian)` 12.2 Offers: "Every control dispatches one
// verb … over a closed twelve-member action set … One dispatch verb and twelve
// actions is the whole human side, and it is deliberately the same page registry the
// tool set drives, reached through a differently authorized surface." The strip, the
// picker, the overflow control, and the address field are four components; if each
// composed its own call the "one registry" claim would be four claims, and the day one
// of them acquired a second path nobody would notice.
//
// So the acts live here and the components take them as props. Each one is a thunk
// over the growth port and nothing else: no component in this family holds a bridge
// call, and none of them decides whether an act is allowed.
//
// ALL TWELVE ARE HERE, AND THE COUNT IS THE POINT. `navigate`, `back`, `forward`,
// `reload`, `stop`, `select`, `reorder`, `show`, `hide`, `create`, `close`, `devtools`
// — 12.2 closes the set at those, and the five that move the view were the ones a pane
// component is most tempted to keep, because the address row is where they are pressed.
// Keeping them there would have left this module holding seven of twelve while its own
// header quoted the twelve, so a reviewer counting the set would have counted the
// wrong list. Four further acts sit beside the set rather than inside it — reveal the
// page's file, pick an element, clear site data, open a local file — because they are
// 12.5's and 12.6's named operations and not members of the one page-registry verb.
//
// TWO REFUSALS THAT DO NOT CROSS THE BOUNDARY, and both are the design's own:
//
//   • The session page cap. 12.10 says a page cap "answers with the cap's name and
//     the current count", and the strip is drawing the count — so the create control
//     answers here rather than dispatching an act whose refusal would have to carry
//     a number the daemon would have to send back. This is NOT the renderer deriving
//     eligibility: the daemon enforces its own ceiling and this admission is a local
//     one over a local list, so a race resolves in the daemon's favour and the person
//     sees the daemon's refusal instead of this one.
//   • Site data with no session. The partition is keyed by session, so a pane with no
//     session behind it has no partition to clear, and dispatching would send an
//     empty key.
//
// CAPTURE IS NOT HERE, AND THAT IS THE ONE EXCEPTION WORTH NAMING. Every act below
// throws its answer away — the port either served or refused, and the refusal is the
// whole of what a surface renders. A capture's served answer is not disposable: it
// names the artifact the bytes became, the media type stored, and the byte length, and
// those three are what the produced-object shelf's card renders. So the capture act
// lives with the register that keeps them (`cards/captured-objects.ts`), and a second
// entry point here would be a second way to take one.
//
// EVERY OTHER REFUSAL IS THE PORT'S, rendered verbatim. Nothing here maps a wire code
// onto a friendlier one: `act-sequence.ts` normalizes a rejection through the
// console's one reader, and what the other side said survives.

import { useMemo } from "react";

import type { ConsoleBridge, GrowthOutcome } from "../../bridge/index.js";
import type { RejectionFallback } from "../../core/index.js";
import { admitAnotherPage } from "../bounds/bound-enforcement.js";
import type { BrowserPaneActs } from "./act-sequence.js";

/**
 * What a navigation act that never answered says, where the rejection carries no code.
 *
 * TWO FALLBACKS AND NOT SIXTEEN, split exactly where the sentence stops being true.
 * A person needs one thing from either — the call into the browser never came back —
 * and sixteen near-identical sentences would differ only by accident. But the sentence
 * below is about REACHING A PAGE, and that is false of reordering a tab or opening
 * developer tools: an act that never touched a page cannot report that a page was out
 * of reach. So the acts that move the view take this one and the rest take the second,
 * and neither says anything about the other's subject.
 */
const NAVIGATION_CALL_FALLBACK = {
  code: "navigation-call-failed",
  detail:
    "The page could not be reached from this window, because the call into the browser never answered.",
} as const;

/** The same, for the acts that operate on the pane's pages rather than on a location. */
const CHROME_CALL_FALLBACK = {
  code: "chrome-call-failed",
  detail:
    "This pane's controls could not be applied, because the call into the browser never answered.",
} as const;

/** Every act the pane's chrome dispatches, the address row's five included. */
export interface BrowserChromeActs {
  readonly navigate: (url: string) => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
  readonly stopLoading: () => void;
  readonly selectPage: (pageId: string) => void;
  readonly closePage: (pageId: string) => void;
  readonly createPage: () => void;
  /** `toIndex` addresses the list WITHOUT the moved page. See `tab-reorder.ts`. */
  readonly reorderPage: (pageId: string, toIndex: number) => void;
  readonly showPage: (pageId: string) => void;
  readonly hidePage: () => void;
  readonly openDevtools: (pageId: string) => void;
  readonly revealPageFile: (pageId: string) => void;
  readonly pickElement: () => void;
  readonly clearSiteData: () => void;
  readonly openLocalFile: (path: string) => void;
}

export interface BrowserChromeActsOptions {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
  /** The session the pane sits in, or `undefined` where the pane has none. */
  readonly sessionId: string | undefined;
  /** The pane's one act sequence and the one refusal it renders. */
  readonly acts: BrowserPaneActs;
  /** How many pages the strip is drawing, for the one cap the renderer can spend. */
  readonly pageCount: number;
}

export function useBrowserChromeActs(options: BrowserChromeActsOptions): BrowserChromeActs {
  const { bridge, paneId, sessionId, acts, pageCount } = options;
  const { run, refuseLocally } = acts;

  return useMemo((): BrowserChromeActs => {
    const dispatch = (
      act: () => Promise<GrowthOutcome<unknown>>,
      fallback: RejectionFallback = CHROME_CALL_FALLBACK,
    ): void => {
      run(async () => {
        const outcome = await act();
        return outcome.status === "unavailable" ? outcome : undefined;
      }, fallback);
    };
    return {
      navigate: (url) => {
        dispatch(
          async () => await bridge.growth.browserNavigate({ paneId, url }),
          NAVIGATION_CALL_FALLBACK,
        );
      },
      goBack: () => {
        dispatch(
          async () => await bridge.growth.browserGoBack({ paneId }),
          NAVIGATION_CALL_FALLBACK,
        );
      },
      goForward: () => {
        dispatch(
          async () => await bridge.growth.browserGoForward({ paneId }),
          NAVIGATION_CALL_FALLBACK,
        );
      },
      reload: () => {
        dispatch(
          async () => await bridge.growth.browserReload({ paneId }),
          NAVIGATION_CALL_FALLBACK,
        );
      },
      stopLoading: () => {
        dispatch(
          async () => await bridge.growth.browserStopLoading({ paneId }),
          NAVIGATION_CALL_FALLBACK,
        );
      },
      selectPage: (pageId) => {
        dispatch(async () => await bridge.growth.browserSelect({ paneId, pageId }));
      },
      closePage: (pageId) => {
        dispatch(async () => await bridge.growth.browserClose({ paneId, pageId }));
      },
      createPage: () => {
        const overCap = admitAnotherPage(pageCount);
        if (overCap !== undefined) {
          refuseLocally(overCap.code, overCap.detail);
          return;
        }
        dispatch(async () => await bridge.growth.browserCreate({ paneId }));
      },
      reorderPage: (pageId, toIndex) => {
        dispatch(async () => await bridge.growth.browserReorder({ paneId, pageId, toIndex }));
      },
      showPage: (pageId) => {
        dispatch(async () => await bridge.growth.browserShow({ paneId, pageId }));
      },
      hidePage: () => {
        dispatch(async () => await bridge.growth.browserHide({ paneId }));
      },
      openDevtools: (pageId) => {
        dispatch(async () => await bridge.growth.browserDevtools({ paneId, pageId }));
      },
      revealPageFile: (pageId) => {
        dispatch(async () => await bridge.growth.browserRevealPageFile({ paneId, pageId }));
      },
      pickElement: () => {
        dispatch(async () => await bridge.growth.browserPickElement({ paneId }));
      },
      clearSiteData: () => {
        if (sessionId === undefined) {
          refuseLocally(
            "no-session",
            "Site data is stored per session, and this pane is not in one, so there is no partition to clear.",
          );
          return;
        }
        dispatch(async () => await bridge.growth.browserClearSiteData({ sessionId }));
      },
      openLocalFile: (path) => {
        dispatch(async () => await bridge.growth.browserOpenFile({ paneId, path }));
      },
    };
  }, [bridge, pageCount, paneId, refuseLocally, run, sessionId]);
}

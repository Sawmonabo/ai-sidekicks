// Every chrome act, and which growth operation it actually dispatches.
//
// The table this covers is the family's whole reason for having one: twelve controls
// spread across three components, each of which must reach the operation named after
// it. A control wired to its neighbour's operation renders correctly, dispatches
// happily, and does the wrong thing to the page — so each act is dispatched here
// against a bridge that records which operation it reached and with what request.
//
// TWO ACTS REFUSE WITHOUT CROSSING THE BOUNDARY and they are covered separately: the
// page cap, which is renderer-side arithmetic 12.10 puts here, and the site-data act
// on a pane that sits in no session, which has no partition to name. Both must refuse
// LOCALLY — a call that went out and came back refused would be the daemon answering
// a question the console already knew the answer to.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { admitAnotherPage } from "../bounds/bound-enforcement.js";
import { useBrowserPaneActs } from "./act-sequence.js";
import { useBrowserChromeActs, type BrowserChromeActs } from "./chrome-acts.js";

const PANE_ID = "pane-browser-1";
const SESSION_ID = BROWSER_SCENARIO.sessionId;

/** A page count no cap refuses, and one every cap does. Both checked as premises. */
const ADMITTED_PAGE_COUNT = 0;
const REFUSED_PAGE_COUNT = Number.MAX_SAFE_INTEGER;

interface DispatchedCall {
  readonly operation: string;
  readonly request: unknown;
}

/**
 * A bridge whose every browser growth operation records itself and refuses.
 *
 * It refuses rather than serves because the growth port refuses too — every one of
 * these wires is on the slate and none is live — so a recorder that answered `served`
 * would put the surface into a state the console cannot reach.
 */
function recordingGrowthBridge(dispatched: DispatchedCall[]): ConsoleBridge {
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
  const growth = { ...base.growth } as Record<string, unknown>;
  for (const operation of Object.keys(growth)) {
    const served = growth[operation];
    if (typeof served !== "function") {
      continue;
    }
    growth[operation] = async (request: unknown): Promise<unknown> => {
      dispatched.push({ operation, request });
      return await (served as (input: unknown) => Promise<unknown>)(request);
    };
  }
  return { ...base, growth: growth as ConsoleBridge["growth"] };
}

interface ChromeHarness {
  /**
   * Dispatch one act, inside `act()`.
   *
   * The two local refusals publish into the pane's held state, so a bare call would
   * leave the reading one render behind and a case asserting on it would read the
   * state BEFORE the refusal — passing for a surface that refused nothing at all.
   */
  readonly dispatch: (act: (acts: BrowserChromeActs) => void) => void;
  readonly dispatched: readonly DispatchedCall[];
  readonly refusalCode: () => string | undefined;
}

function mountChromeActs(
  options: { readonly sessionId?: string | undefined; readonly pageCount?: number } = {},
): ChromeHarness {
  const dispatched: DispatchedCall[] = [];
  const bridge = recordingGrowthBridge(dispatched);
  const { result } = renderHook(() => {
    const paneActs = useBrowserPaneActs(bridge, PANE_ID);
    return {
      paneActs,
      chrome: useBrowserChromeActs({
        bridge,
        paneId: PANE_ID,
        sessionId: "sessionId" in options ? options.sessionId : SESSION_ID,
        acts: paneActs,
        pageCount: options.pageCount ?? 0,
      }),
    };
  });
  return {
    dispatch: (dispatchOne) => {
      act(() => {
        dispatchOne(result.current.chrome);
      });
    },
    dispatched,
    refusalCode: () => result.current.paneActs.refusal?.code,
  };
}

describe("the pane's chrome acts", () => {
  it("dispatches each page act to the operation named after it", () => {
    const harness = mountChromeActs();
    harness.dispatch((acts) => {
      acts.selectPage("page-a");
    });
    harness.dispatch((acts) => {
      acts.closePage("page-b");
    });
    harness.dispatch((acts) => {
      acts.showPage("page-c");
    });
    harness.dispatch((acts) => {
      acts.hidePage();
    });
    harness.dispatch((acts) => {
      acts.openDevtools("page-d");
    });
    harness.dispatch((acts) => {
      acts.revealPageFile("page-e");
    });
    harness.dispatch((acts) => {
      acts.pickElement();
    });
    harness.dispatch((acts) => {
      acts.openLocalFile("/repo/index.html");
    });
    expect(harness.dispatched.map((call) => call.operation)).toEqual([
      "browserSelect",
      "browserClose",
      "browserShow",
      "browserHide",
      "browserDevtools",
      "browserRevealPageFile",
      "browserPickElement",
      "browserOpenFile",
    ]);
  });

  it("carries the pane and the page on the request, and never invents a member", () => {
    const harness = mountChromeActs();
    harness.dispatch((acts) => {
      acts.selectPage("page-a");
    });
    expect(harness.dispatched[0]?.request).toEqual({ paneId: PANE_ID, pageId: "page-a" });
  });

  it("carries the move index the strip translated, unchanged", () => {
    const harness = mountChromeActs();
    harness.dispatch((acts) => {
      acts.reorderPage("page-a", 2);
    });
    expect(harness.dispatched[0]).toEqual({
      operation: "browserReorder",
      request: { paneId: PANE_ID, pageId: "page-a", toIndex: 2 },
    });
  });

  it("clears site data by SESSION, because the partition is the session's", () => {
    const harness = mountChromeActs();
    harness.dispatch((acts) => {
      acts.clearSiteData();
    });
    expect(harness.dispatched[0]).toEqual({
      operation: "browserClearSiteData",
      request: { sessionId: SESSION_ID },
    });
  });

  it("refuses site data locally on a pane that sits in no session", () => {
    const harness = mountChromeActs({ sessionId: undefined });
    harness.dispatch((acts) => {
      acts.clearSiteData();
    });
    expect(harness.dispatched).toEqual([]);
    expect(harness.refusalCode()).toBe("no-session");
  });

  it("creates a page while the strip is under the cap", () => {
    // The premise is asserted through the real admission rather than a copied number:
    // the ceiling lives in `browser-bounds.ts`, `bound-enforcement.test.ts` drives it
    // at the boundary, and this case is about the ACT consulting it.
    expect(admitAnotherPage(ADMITTED_PAGE_COUNT)).toBeUndefined();
    const harness = mountChromeActs({ pageCount: ADMITTED_PAGE_COUNT });
    harness.dispatch((acts) => {
      acts.createPage();
    });
    expect(harness.dispatched.map((call) => call.operation)).toEqual(["browserCreate"]);
  });

  it("refuses the page past the cap here, rather than asking the daemon", () => {
    expect(admitAnotherPage(REFUSED_PAGE_COUNT)).toBeDefined();
    const harness = mountChromeActs({ pageCount: REFUSED_PAGE_COUNT });
    harness.dispatch((acts) => {
      acts.createPage();
    });
    expect(harness.dispatched).toEqual([]);
    expect(harness.refusalCode()).toBe("bound-reached");
  });
});

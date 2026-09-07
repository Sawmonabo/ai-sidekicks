// The bridges the view-binding cases need, and the log that says what was called.
//
// One home for the two roles both suites beside it play: a fixture bridge whose attach
// and teardown are SERVED — the fixture port serves neither, so a case about a pane that
// got a view has to supply one — and an ordered call log, because every claim these
// cases make is about ORDER (attach before the first subscription) or about COUNT (one
// teardown and not two), and neither survives a per-suite copy that drifts.

import { fixtureBrowserBridge } from "./BrowserPane.test-support.js";
import type { ConsoleBridge, GrowthUnavailable } from "../../bridge/index.js";
import { refuse } from "../../core/index.js";

/** The operations these suites record, in the order the pane called them. */
export type PaneViewCall =
  | { readonly operation: "attach"; readonly paneId: string }
  | { readonly operation: "detach"; readonly paneId: string }
  | { readonly operation: "subscribe-navigation"; readonly paneId: string }
  | { readonly operation: "subscribe-pages"; readonly paneId: string };

/** The page a served attach answers with. Shape derived from the port, never restated. */
type AttachOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserPaneAttach"]>>;
type AttachedPage = Extract<AttachOutcome, { readonly status: "served" }>["value"]["page"];

/** One page, at the quiet value for every field no case here reads. */
export function attachedPage(pageId: string): AttachedPage {
  return {
    pageId,
    label: null,
    title: "",
    url: "about:blank",
    host: "",
    isLoading: false,
    isSelected: true,
    isShown: true,
  };
}

export interface RecordedViewBridge {
  readonly bridge: ConsoleBridge;
  /** Every recorded call, oldest first. Read for order and for count. */
  readonly calls: PaneViewCall[];
}

export interface RecordedViewBridgeOptions {
  /**
   * How the attach settles. `"served"` hands back a page; `"refused"` answers with a
   * host that said no; `"unasked"` leaves the fixture port's own arm in place, which is
   * the `wire-unregistered` refusal every browser operation carries in this build.
   */
  readonly attach: "served" | "refused" | "unasked";
  /**
   * How the teardown settles. Defaults to served.
   *
   * `"unasked"` leaves the fixture port's arm in place — the `wire-unregistered` refusal
   * this build answers every browser operation with — which is the one refused teardown
   * that must reach no diagnostic record.
   */
  readonly detach?: "served" | "refused" | "unasked";
}

/**
 * A bridge that records what the pane asked it for, and answers as the case requires.
 *
 * The refusing arms answer with the port's own refusal SHAPE rather than a bare object,
 * because that shape is what `isUnbuiltWireRefusal` reads: a hand-built refusal carrying
 * some other code would exercise the refused arm without ever exercising the reading
 * that tells the two absences apart.
 */
export function recordedViewBridge(options: RecordedViewBridgeOptions): RecordedViewBridge {
  const base = fixtureBrowserBridge();
  const calls: PaneViewCall[] = [];
  const refusalFor = async (
    operation: "browserPaneAttach" | "browserPaneDetach",
  ): Promise<GrowthUnavailable> => {
    // The port's OWN refusal for this operation, with its code replaced by one that is
    // not `wire-unregistered`: it keeps the ledger the port attaches — the operation, the
    // slate row, the document that owes the wire — rather than inventing a second refusal
    // shape here, and it is the arm `isUnbuiltWireRefusal` answers false for.
    const unasked = await base.growth[operation]({ paneId: "pane-refusal-probe" });
    if (unasked.status === "served") {
      throw new Error("the fixture port served a browser operation it is documented to refuse");
    }
    return {
      ...unasked,
      code: "call-rejected",
      cause: refuse("browser-host", "browser.pane_gone", "That pane is gone."),
    };
  };
  return {
    calls,
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        browserPaneAttach: async ({ paneId }) => {
          calls.push({ operation: "attach", paneId });
          if (options.attach === "served") {
            return { status: "served" as const, value: { page: attachedPage("page-1") } };
          }
          if (options.attach === "refused") {
            return refusalFor("browserPaneAttach");
          }
          return base.growth.browserPaneAttach({ paneId });
        },
        browserPaneDetach: async ({ paneId }) => {
          calls.push({ operation: "detach", paneId });
          if (options.detach === "refused") {
            return refusalFor("browserPaneDetach");
          }
          if (options.detach === "unasked") {
            return base.growth.browserPaneDetach({ paneId });
          }
          return { status: "served" as const, value: undefined };
        },
        browserSubscribeNavigation: async ({ paneId }) => {
          calls.push({ operation: "subscribe-navigation", paneId });
          return base.growth.browserSubscribeNavigation({ paneId });
        },
        browserSubscribePages: async ({ paneId }) => {
          calls.push({ operation: "subscribe-pages", paneId });
          return base.growth.browserSubscribePages({ paneId });
        },
      },
    },
  };
}

/** Which operations were called, in order, for the assertions that read a sequence. */
export function calledOperations(calls: readonly PaneViewCall[]): readonly string[] {
  return calls.map((call) => call.operation);
}

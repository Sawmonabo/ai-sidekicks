// What every browser-pane suite needs before it can ask the pane anything.
//
// One home for the four roles more than one of the sibling suites plays: the pane
// context and the mount that lets its navigation subscription settle, the refusal
// banner read by role rather than by text, the address field read by its label, and
// a bridge whose navigation subscription is served with the readings pushed one at a
// time. It holds nothing a single suite uses — the close-tab modifier, the rejecting
// overrides, and the view hosts each concern builds stay beside their reader.

import { act, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, createLiveBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SCRIPTED_PANE_VIEW_HOST_TRANSPORT } from "../../bridge/pane-view-host-script.js";
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import { FrameStore } from "../../store/index.js";
import type { ConsolePaneContext } from "../../seats/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The refusal banner the pane raises — a plain group, since the frame's announcer
 * owns the announcement — read by that role and scoped by the banner's own class,
 * so an unrelated group in the pane can never satisfy the query. Awaited through
 * `waitFor` because the port settles a refusal asynchronously and a bare role
 * query would answer before it lands.
 */
export function queryRefusalBanner(): HTMLElement | null {
  return (
    screen
      .queryAllByRole("group")
      .find((element) => element.classList.contains("meridian-refusal--banner")) ?? null
  );
}

export async function findRefusalBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = queryRefusalBanner();
    expect(banner).not.toBeNull();
    return banner as HTMLElement;
  });
}

/**
 * The bridge a fixture or end-to-end run hands this pane.
 *
 * Named rather than inlined at each mount, because three suites now need to reach
 * for the SAME window: the pane's view host is resolved from the bridge, so a case
 * about geometry and a case about navigation have to be describing one bridge or
 * they are describing two different windows.
 */
export function fixtureBrowserBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: BROWSER_SCENARIO });
}

/**
 * The bridge a live window hands this pane, over the same preload contract.
 *
 * The fixture's own `sidekicks` namespace IS that contract, so this is the real live
 * wrapper answering for a window with no view host — 12.11's third arm, reached
 * through the wiring table rather than asserted about it.
 */
export function liveBrowserBridge(): ConsoleBridge {
  return createLiveBridge(fixtureBrowserBridge().sidekicks);
}

/**
 * A fixture bridge whose scripted host says the pane it is asked about is gone.
 *
 * The arm no scenario can script — a pane's destruction is not a session event —
 * and the one a surface has to render, because the publisher disposes itself over
 * it and the viewport would otherwise go on offering "no page yet" forever.
 */
export function paneViewHostRefusing(detail: string): ConsoleBridge {
  return {
    ...fixtureBrowserBridge(),
    paneViewHostScript: {
      transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
      holdsPane: () => ({ holds: false, detail }),
    },
  };
}

function paneContext(
  bridge: ConsoleBridge = fixtureBrowserBridge(),
  paneId = DEFAULT_TEST_PANE_ID,
): {
  readonly context: ConsolePaneContext;
  readonly bridge: ConsoleBridge;
} {
  return {
    bridge,
    context: {
      // No `entity` member at all: the `browser` address is session-scoped, so the
      // kind's arm of the union carries none and an `undefined` one would be a
      // reference this pane is documented never to be a view of.
      kind: "browser",
      paneId,
      bridge,
      frameStore: new FrameStore(),
      sessionStore: undefined,
      uiStateStore: UiStateStore.opening(),
      draftStore: new DraftStore(),
      linkedSourcePaneId: undefined,
      focusHue: undefined,
    },
  };
}

/** The pane a suite mounts when it is not about which pane this is. */
export const DEFAULT_TEST_PANE_ID = "pane-browser-1";

/**
 * Mount the pane and hand back the re-render that swaps which pane it is FOR.
 *
 * The swap is what a deck performs when a slot changes subject: React keeps the
 * component instance and hands it a different `paneId`, so every piece of state the
 * pane carries between renders has to say whose it is. A suite that could only mount
 * a fresh tree could not reach that case at all.
 */
export async function mountBrowserPaneForSubject(
  bridge: ConsoleBridge,
  paneId: string,
  ProbeComponent?: React.ComponentType,
): Promise<BrowserPaneSubjectMount> {
  const built = paneContext(bridge, paneId);
  let mounted: RenderResult | undefined;
  // A component type rather than a ready-made node, and that is load-bearing: React
  // skips re-rendering a child whose element is referentially identical, so a probe
  // passed as a node would mount once and then observe none of the commits it exists
  // to observe. Instantiated here, each render hands it a fresh element.
  const tree = (subject: { readonly context: ConsolePaneContext }): React.JSX.Element => (
    <>
      <BrowserPane {...subject.context} />
      {ProbeComponent === undefined ? null : <ProbeComponent />}
    </>
  );
  await act(async () => {
    mounted = render(tree(built));
  });
  const rendered = mounted;
  if (rendered === undefined) {
    throw new Error("the browser pane did not mount");
  }
  const rerenderFor = async (nextBridge: ConsoleBridge, nextPaneId: string): Promise<void> => {
    const rebound = paneContext(nextBridge, nextPaneId);
    await act(async () => {
      rendered.rerender(tree(rebound));
    });
  };
  return {
    rebindTo: async (nextPaneId: string): Promise<void> => rerenderFor(bridge, nextPaneId),
    rebindToBridge: async (nextBridge: ConsoleBridge): Promise<void> =>
      rerenderFor(nextBridge, paneId),
  };
}

/**
 * The two swaps a mounted pane can be put through without being remounted.
 *
 * Both are things a real composition does and neither is a fresh tree: a deck moves
 * a slot to another pane, and a window hands the tree another bridge. They are named
 * together because the pane's state has to say WHOSE it is against both, and a suite
 * that could only reach one of them would leave the other's stale-subject case
 * untested.
 */
export interface BrowserPaneSubjectMount {
  readonly rebindTo: (nextPaneId: string) => Promise<void>;
  readonly rebindToBridge: (nextBridge: ConsoleBridge) => Promise<void>;
}

/**
 * Mount the pane and let its navigation subscription settle.
 *
 * The `await act` is not ceremony: the subscription resolves in a microtask after the
 * render, and a test that asserted before it landed would be asserting against a pane
 * one state transition younger than the one an operator ever sees.
 */
export async function renderBrowserPane(bridge?: ConsoleBridge): Promise<{
  readonly region: HTMLElement;
  readonly bridge: ConsoleBridge;
}> {
  const built = paneContext(bridge);
  await act(async () => {
    render(<BrowserPane {...built.context} />);
  });
  return { region: screen.getByRole("region", { name: "Browser" }), bridge: built.bridge };
}

/** The address field itself, read by its label so the query names what a person sees. */
export function addressField(): HTMLInputElement {
  return screen.getByLabelText("Destination") as HTMLInputElement;
}

type SubscribeOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>>;
type NavigationStream = Extract<SubscribeOutcome, { readonly status: "served" }>["value"];
export type NavigationEvent =
  NavigationStream["events"] extends AsyncIterable<infer Event> ? Event : never;

/** One reading, with the fields a case does not care about held at their quiet value. */
export function reportedState(
  url: string,
  overrides: Partial<NavigationEvent> = {},
): NavigationEvent {
  return {
    url,
    title: url,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  };
}

/**
 * A bridge whose navigation subscription is SERVED, with the readings pushed one at
 * a time by the test.
 *
 * The pushing is the point rather than a convenience: what the address field owes is
 * a behaviour ACROSS two readings — a second one arriving while somebody is typing,
 * and the same one arriving while nobody is — and a stream that yields its whole
 * script before the first assertion cannot tell those apart. `browserNavigate` is
 * left as the fixture port's own refusing arm, because a submit's job here is to
 * return the field to following whether the navigation lands or not.
 */
export function navigationReportingBridge(): {
  readonly bridge: ConsoleBridge;
  readonly report: (state: NavigationEvent) => void;
  /** End the producer's side, the way a daemon that has finished reporting would. */
  readonly endReporting: () => void;
} {
  const base = fixtureBrowserBridge();
  const queued: NavigationEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream: NavigationStream = {
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<NavigationEvent> {
        while (!closed) {
          const next = queued.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield next;
        }
      },
    },
    close: () => {
      closed = true;
      wake?.();
    },
  };
  return {
    report: (state) => {
      queued.push(state);
      wake?.();
      wake = undefined;
    },
    endReporting: () => {
      // The producer's own end rather than the consumer's `close`: the iterator runs
      // out, which is the case a pane holding the last frame gets wrong.
      closed = true;
      wake?.();
      wake = undefined;
    },
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        browserSubscribeNavigation: async () => ({ status: "served" as const, value: stream }),
      },
    },
  };
}

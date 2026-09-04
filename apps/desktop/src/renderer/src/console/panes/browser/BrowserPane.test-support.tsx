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
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
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

function paneContext(
  bridge: ConsoleBridge = createFixtureBridge({ scenario: BROWSER_SCENARIO }),
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
): Promise<{ readonly rebindTo: (nextPaneId: string) => Promise<void> }> {
  const built = paneContext(bridge, paneId);
  let mounted: RenderResult | undefined;
  await act(async () => {
    mounted = render(<BrowserPane {...built.context} />);
  });
  const rendered = mounted;
  if (rendered === undefined) {
    throw new Error("the browser pane did not mount");
  }
  return {
    rebindTo: async (nextPaneId: string): Promise<void> => {
      const rebound = paneContext(bridge, nextPaneId);
      await act(async () => {
        rendered.rerender(<BrowserPane {...rebound.context} />);
      });
    },
  };
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
  const base = createFixtureBridge({ scenario: BROWSER_SCENARIO });
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

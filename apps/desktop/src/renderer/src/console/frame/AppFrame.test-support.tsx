// What both frame suites need before they can render a frame.
//
// One home for the two roles each of them plays: the props `AppFrame` requires that
// no case is making a claim about, and the bridge host the frame resolves its clock
// from. It holds nothing a single suite uses — the exploding surface, the failure
// card's addressing, the banner, and the live regions each have one reader and stay
// beside it.

import { createTier1Bridge } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { SidekicksBridgeProvider, type ConsoleBridge } from "../bridge/index.js";
import { createLiveBridge } from "../bridge/live-bridge.js";
import type { ConsoleRoute } from "../routing/index.js";
import type { FrameBanner } from "../store/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./IconRail.js";

const RAIL_ENTRIES: readonly RailEntry[] = [
  { destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions },
];

export const SESSIONS_ROUTE: ConsoleRoute = { kind: "sessions" };

export function CalmSurface(): React.JSX.Element {
  return <p>the settings surface rendered</p>;
}

/** Everything `AppFrame` needs that a case is not making a claim about. */
export function frameProps(
  route: ConsoleRoute,
  banners: readonly FrameBanner[] = [],
): {
  route: ConsoleRoute;
  railEntries: readonly RailEntry[];
  railDestination: undefined;
  onSelectDestination: () => void;
  banners: readonly FrameBanner[];
  onDismissBanner: () => void;
} {
  return {
    route,
    railEntries: RAIL_ENTRIES,
    railDestination: undefined,
    onSelectDestination: () => undefined,
    banners,
    onDismissBanner: () => undefined,
  };
}

/**
 * A bridge host for the frame, because the frame resolves the window's clock.
 *
 * `AppFrame` mounts the live announcer, and the announcer arms the one timeout the
 * console's idle budget counts — so which clock it runs on is a property of the
 * WINDOW rather than of the primitive, and the frame reads it from the bridge. Both
 * arms are the real thing: `createTier1Bridge()` is the object the preload exposes
 * to a shipped window, and `createFixtureBridge` builds the real engine over the
 * real flagship scenario.
 */
export function bridgeWrapper(
  bridge: ConsoleBridge,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function BridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}

/** The wall-clock arm: what a shipped window resolves. */
export function liveBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  return bridgeWrapper(createLiveBridge(createTier1Bridge()));
}

export function backgroundOf(container: HTMLElement): HTMLElement {
  const background = container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

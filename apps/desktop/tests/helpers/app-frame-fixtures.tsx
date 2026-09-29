// What both frame suites need before they can render a frame.
//
// One home for the two roles each of them plays: the props `AppFrame` requires that
// no case is making a claim about, and the bridge host the frame resolves its clock
// from. It holds nothing a single suite uses — the exploding surface, the failure
// card's addressing, the banner, and the live regions each have one reader and stay
// beside it.
import { createStubBridge } from "@shared/preload-api.js";
import type { ReactNode } from "react";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { createLiveBridge } from "@renderer/services/platform/live-bridge.js";
import { FIXTURE_APP_META } from "@renderer/services/platform/platform-bridge.fixture.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import type { WindowBanner } from "@renderer/store/window/window-store.js";
import {
  RAIL_ENTRY_TEMPLATES,
  type RailEntry,
} from "@renderer/layout/NavigationRail/NavigationRail.js";

const RAIL_ENTRIES: readonly RailEntry[] = [
  { destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions },
];

export const SESSIONS_ROUTE: AppRoute = { kind: "sessions" };

export function CalmScreen(): React.JSX.Element {
  return <p>the settings screen rendered</p>;
}

/** Everything `AppFrame` needs that a case is not making a claim about. */
export function frameProps(
  route: AppRoute,
  banners: readonly WindowBanner[] = [],
): {
  route: AppRoute;
  railEntries: readonly RailEntry[];
  railDestination: undefined;
  onSelectDestination: () => void;
  banners: readonly WindowBanner[];
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
 * arms are the real thing: `createStubBridge()` is the object the preload exposes
 * to a shipped window, and `createFixtureBridge` builds the real engine over the
 * real concurrent-streaming scenario.
 */
export function bridgeWrapper(
  bridge: PlatformBridge,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function BridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return <PlatformBridgeProvider bridge={bridge}>{props.children}</PlatformBridgeProvider>;
  };
}

/** The wall-clock arm: what a shipped window resolves. */
export function liveBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  return bridgeWrapper(createLiveBridge(createStubBridge(FIXTURE_APP_META)));
}

export function backgroundOf(container: HTMLElement): HTMLElement {
  const background = container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

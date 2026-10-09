// What both frame suites need before they can render a frame: the props `AppFrame` requires that
// no case makes a claim about, the bridge host the frame resolves its clock from, and the
// announcer the frame mounts inside it. Anything a single suite uses (the exploding screen, the
// failure card's addressing, the banner, reading the live regions) stays beside its one reader.
import { createStubBridge } from "#shared/preload-api.js";
import type { ReactNode } from "react";
import type { Clock } from "#renderer/lib/clock.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { createLiveBridge } from "#renderer/services/platform/live-bridge.js";
import {
  FIXTURE_APP_META,
  FIXTURE_WINDOW_ID,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import type { WindowBanner } from "#renderer/store/window/store.js";
import { PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX } from "#renderer/features/sessions/pane-layout/measures.js";
import {
  RAIL_ENTRY_TEMPLATES,
  type NavigationRailProps,
} from "#renderer/layout/NavigationRail/NavigationRail.js";

/** A rail no case makes a claim about: one destination above the spacer, and Settings. */
const RAIL: NavigationRailProps = {
  entries: [{ destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions }],
  settingsEntry: { destination: "settings", ...RAIL_ENTRY_TEMPLATES.settings },
  current: undefined,
  onSelect: () => undefined,
  chords: {},
  sessionsList: {
    isExpanded: false,
    controlsId: "frame-fixture-sessions",
    onToggle: () => undefined,
  },
  attention: {
    isExpanded: false,
    controlsId: "frame-fixture-notifications",
    onToggle: () => undefined,
  },
  onCycleColorScheme: () => undefined,
  isUpdateStaged: false,
};

/** The route a frame renders when the case makes no claim about the address. */
export const SESSIONS_ROUTE: AppRoute = { kind: "sessions" };

/** A screen that renders without failing. */
export function CalmScreen(): React.JSX.Element {
  return <p>the settings screen rendered</p>;
}

/** Everything `AppFrame` needs that a case is not making a claim about. */
export function frameProps(
  route: AppRoute,
  banners: readonly WindowBanner[] = [],
): {
  route: AppRoute;
  rail: NavigationRailProps;
  banners: readonly WindowBanner[];
  onDismissBanner: () => void;
  minimumPaneWidthPx: number;
  onWindowFloorChange: () => void;
} {
  return {
    route,
    rail: RAIL,
    banners,
    onDismissBanner: () => undefined,
    // The pane floor a window passes the frame.
    minimumPaneWidthPx: PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX,
    onWindowFloorChange: () => undefined,
  };
}

/**
 * A bridge host for the frame, because the frame resolves the window's clock.
 *
 * `AppFrame` mounts the live announcer, which arms the one timeout the app's idle budget
 * counts, so the clock is a property of the window and the frame reads it from the resolution.
 * Both arms are real: `createStubBridge()` is `PreloadApi` with every round-trip member throwing
 * `NotImplementedError`, a bridge none of whose calls reaches main, and `createFixtureBridge`
 * builds the real engine over a scenario, whose frozen clock a case hands in beside it. Without a
 * clock the window runs on real time.
 */
export function bridgeWrapper(
  bridge: PlatformBridge,
  clock?: Clock,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function BridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return (
      <PlatformBridgeProvider bridge={bridge} {...(clock === undefined ? {} : { clock })}>
        {props.children}
      </PlatformBridgeProvider>
    );
  };
}

/**
 * A render wrapper with the window's announcer inside it, where the frame mounts it, so a
 * component that speaks can render under a bridge wrapper.
 */
export function withAnnouncer(
  Wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function WrapperWithAnnouncer(props: { readonly children: ReactNode }): React.JSX.Element {
    return (
      <Wrapper>
        <LiveAnnouncerProvider>{props.children}</LiveAnnouncerProvider>
      </Wrapper>
    );
  };
}

/**
 * The provider over a fixture bridge, on its engine's frozen clock.
 *
 * A component rather than a wrapper factory, so a case that re-renders a tree naming a
 * different fixture keeps one provider and exercises its in-place replacement.
 */
export function FixtureBridgeProvider(props: {
  readonly fixture: FixtureBridge;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <PlatformBridgeProvider
      bridge={props.fixture.bridge}
      clock={props.fixture.scenarioEngine.clock}
    >
      {props.children}
    </PlatformBridgeProvider>
  );
}

/** The wall-clock arm: what a shipped window resolves. */
export function liveBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  return bridgeWrapper(createLiveBridge(createStubBridge(FIXTURE_APP_META, FIXTURE_WINDOW_ID)));
}

/** The frame's background wrapper, which the frame makes inert behind an open overlay. */
export function backgroundOf(container: HTMLElement): HTMLElement {
  const background = container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

// The chrome: the rail, the sessions track, the banner stack, one region for the routed screen,
// and the box that measures the window's floor.
//
// The screen arrives as `children` so the frame depends on no feature. The background wrapper
// carries `inert` while a modal overlay is up: the dialog traps focus but leaves the rest of the
// app in the accessibility tree, and the wrapper is `display: contents` so the frame's grid still
// places the rail, the track and the column. `overlays` stays outside it, so the dialog remains
// reachable.
//
// This is separate from `AppFrame.tsx` because the announcement hook below must run under the
// announcer provider that `AppFrame` mounts.

import { RefusalBanner } from "#renderer/components/Refusal/RefusalBanner.js";
import { ErrorBoundary } from "#renderer/components/ErrorBoundary/ErrorBoundary.js";
import { type WindowBanner } from "#renderer/store/window/store.js";
import { useRefusalBannerAnnouncements } from "./hooks/useRefusalBannerAnnouncements.js";
import { NavigationRail, type RailEntry } from "../NavigationRail/NavigationRail.js";
import { formatRoute, type AppRoute } from "#renderer/routing/routes.js";
import { type RailDestination } from "#renderer/routing/readers.js";
import type { WindowSize } from "#shared/window/size.js";
import { WindowFloorProbe } from "./WindowFloorProbe.js";
import { useAnimateSessionsTrack } from "./hooks/useAnimateSessionsTrack.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";

/** What a caller hands the frame chrome. */
export interface FrameChromeProps {
  readonly route: AppRoute;
  readonly railEntries: readonly RailEntry[];
  readonly railDestination: RailDestination | undefined;
  readonly onSelectDestination: (destination: RailDestination) => void;
  readonly banners: readonly WindowBanner[];
  readonly onDismissBanner: (bannerId: string) => void;
  /** The screen the route resolves to. Mounted inside its own error boundary. */
  readonly children: React.ReactNode;
  /** Rendered above the screen: the palette, dialogs, anything window-scoped. */
  readonly overlays?: React.ReactNode;
  /** True while a modal overlay owns focus; the frame's background is `inert` meanwhile. */
  readonly modalOverlayOpen?: boolean;
  /** One line about the window itself, drawn above the banners. */
  readonly notice?: React.ReactNode;
  /** What the sessions track holds; with nothing, the track is closed and zero wide. */
  readonly sessionsTrack?: React.ReactNode;
  /** The narrowest one pane may be, in CSS px, the pane term of the window's floor. */
  readonly minimumPaneWidthPx: number;
  /** The window's smallest size, in CSS px, reported on first layout and on every change. */
  readonly onWindowFloorChange: (floor: WindowSize) => void;
}

/** The rail, banners and routed screen, with the background made inert under a modal overlay. */
export function FrameChrome(props: FrameChromeProps): React.JSX.Element {
  useRefusalBannerAnnouncements(props.banners);
  const screenScrollbarRef = useOverlayScrollbar<HTMLElement>(undefined, {
    start: "on-first-interaction",
  });
  const sessionsTrack = useAnimateSessionsTrack(props.sessionsTrack);
  return (
    <div
      ref={sessionsTrack.frameRef}
      className="meridian-frame"
      data-sessions-track={sessionsTrack.state}
      onTransitionEnd={sessionsTrack.onTransitionEnd}
    >
      <div className="meridian-frame__background" inert={props.modalOverlayOpen === true}>
        <NavigationRail
          entries={props.railEntries}
          current={props.railDestination}
          onSelect={props.onSelectDestination}
        />
        {sessionsTrack.content === undefined ? null : (
          // Inert while closing: content on its way out takes no focus and no press.
          <div className="meridian-frame__sessions-track" inert={sessionsTrack.state === "closing"}>
            {sessionsTrack.content}
          </div>
        )}
        <div className="meridian-frame__column">
          {props.notice}
          {props.banners.length === 0 ? null : (
            <div className="meridian-frame__banners">
              {props.banners.map((banner) => (
                <div key={banner.id} className="meridian-frame__banner">
                  {banner.dismissible ? (
                    <RefusalBanner
                      code={banner.code}
                      reason={banner.reason}
                      detail={banner.detail}
                      onDismiss={() => {
                        props.onDismissBanner(banner.id);
                      }}
                    />
                  ) : (
                    <RefusalBanner
                      code={banner.code}
                      reason={banner.reason}
                      detail={banner.detail}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <main className="meridian-frame__screen" ref={screenScrollbarRef}>
            {/* Keyed by the route so navigating away from a crash clears the boundary's error. */}
            <ErrorBoundary key={formatRoute(props.route)} regionName={screenNameFor(props.route)}>
              {props.children}
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <WindowFloorProbe
        minimumPaneWidthPx={props.minimumPaneWidthPx}
        onWindowFloorChange={props.onWindowFloorChange}
      />
      {props.overlays}
    </div>
  );
}

/** A name a person would use, for the boundary's copy. Never a route id. */
function screenNameFor(route: AppRoute): string {
  switch (route.kind) {
    case "sessions":
      return "The sessions list";
    case "session":
      return "The session screen";
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    case "pane-harness":
      // Fixture-only.
      return "The pane harness";
    case "not-found":
      return "This window";
  }
}

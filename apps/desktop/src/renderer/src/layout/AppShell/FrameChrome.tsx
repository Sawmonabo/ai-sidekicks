// The chrome itself: the rail, the banner stack, and one region for whatever the
// route names.
//
// The frame owns chrome and nothing else. It does not know what a session screen
// is, and the features do not know the frame exists — they register a renderer for a
// route and the router mounts it. That separation is what lets the features ship in
// parallel, and it is why the screen arrives as `children` rather than an import: an
// import would make the frame depend on every feature.
//
// THE BACKGROUND WRAPPER IS THE APP CHROME'S `inert` GUARD, and it is why the rail and the
// column are wrapped rather than left as direct children. The widget library's dialog
// runs under `modal="trap-focus"`, which traps focus and deliberately does not lock the
// document's scroll — and leaves inerting the app root to the app's chrome, because the dialog
// cannot know what "the rest of the app" is. Focus containment alone leaves the rail
// and the whole screen in the accessibility tree, reachable by every reader that
// navigates by structure rather than by focus. The wrapper carries `display: contents`,
// so it is a place to hang the attribute and not a box: the frame's grid still places
// the rail and the column itself, which is what keeps this a one-attribute change
// rather than a layout one. `overlays` stays OUTSIDE it — inerting the dialog along
// with the background would leave a person nothing to reach at all.
//
// THIS IS A SEPARATE MODULE FROM `AppFrame.tsx` for a reason that is not only the
// one-component rule: the announcement hook below has to run BELOW the window's
// announcer provider — context is read by tree position — and a component cannot
// consume a provider it renders itself. `AppFrame` mounts the provider and renders
// this; the prop contract is declared here, beside the body that reads every member
// of it, and re-exported there under the name callers type against.

import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import { ErrorBoundary } from "@renderer/components/ErrorBoundary/ErrorBoundary.js";
import { type WindowBanner } from "@renderer/store/window/window-store.js";
import { useRefusalBannerAnnouncements } from "./hooks/useRefusalBannerAnnouncements.js";
import { NavigationRail, type RailEntry } from "../NavigationRail/NavigationRail.js";
import { formatRoute, type AppRoute } from "@renderer/routing/routes.js";
import { type RailDestination } from "@renderer/routing/route-readers.js";

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
  /**
   * True while a modal overlay owns focus.
   *
   * The frame's background is `inert` for exactly that lifetime — see the
   * background-wrapper note in the file header. It is a prop rather than
   * something the frame works out for itself because `overlays` is filled by the
   * caller: the frame renders whatever it is handed and is not the owner
   * of any overlay's open state.
   */
  readonly modalOverlayOpen?: boolean;
}

export function FrameChrome(props: FrameChromeProps): React.JSX.Element {
  useRefusalBannerAnnouncements(props.banners);
  return (
    <div className="meridian-frame">
      <div className="meridian-frame__background" inert={props.modalOverlayOpen === true}>
        <NavigationRail
          entries={props.railEntries}
          current={props.railDestination}
          onSelect={props.onSelectDestination}
        />
        <div className="meridian-frame__column">
          {props.banners.length === 0 ? null : (
            <div className="meridian-frame__banners">
              {props.banners.map((banner) => (
                <div key={banner.id} className="meridian-frame__banner">
                  {banner.dismissible ? (
                    <RefusalBanner
                      code={banner.code}
                      detail={banner.detail}
                      onDismiss={() => {
                        props.onDismissBanner(banner.id);
                      }}
                    />
                  ) : (
                    <RefusalBanner code={banner.code} detail={banner.detail} />
                  )}
                </div>
              ))}
            </div>
          )}
          <main className="meridian-frame__screen">
            {/*
              KEYED BY THE ROUTE, so navigating away from a crash is the retry.
              The boundary's caught error is its own state, and with one identity
              across every route one screen's render throw would hide the NEXT
              screen behind the previous route's failure card until someone clicked
              "Try again" — a control offering to re-render a route they had already
              left. `formatRoute` rather than a second identity function: it is
              `routing/`'s existing total, round-tripping
              rendering of a route, so two routes are one boundary exactly when they
              are one address.
            */}
            <ErrorBoundary key={formatRoute(props.route)} regionName={screenNameFor(props.route)}>
              {props.children}
            </ErrorBoundary>
          </main>
        </div>
      </div>
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
      // Fixture-only, and named the way a person driving it would: the boundary's
      // copy reads "The pane harness could not be rendered", which is the truth
      // about the screen rather than about the pane inside it.
      return "The pane harness";
    case "not-found":
      return "This window";
  }
}

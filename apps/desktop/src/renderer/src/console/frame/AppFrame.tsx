// The frame: the rail, the banner stack, and one slot for whatever the route names.
//
// The frame owns chrome and nothing else. It does not know what a session workspace
// is, and the six 1C surface families do not know the frame exists — they register a
// renderer for a route and the frame mounts it. That separation is what lets the
// families ship in parallel, and it is why `surfaces` is a prop rather than an
// import: an import would make the frame depend on all six.
//
// Auxiliary windows get NO rail. `Spec-023 §Console Design (Meridian)` §The surface
// set makes them single-purpose windows with their own bridge instance and no shared
// store (I-023-12), and a rail whose destinations belong to another window would be
// three controls that navigate the wrong frame.

import { RefusalBanner } from "../primitives/index.js";
import { type FrameBanner } from "../store/index.js";
import { SurfaceErrorBoundary } from "./ErrorBoundary.js";
import { IconRail, type RailEntry } from "./IconRail.js";
import type { ConsoleRoute, RailDestination } from "../routing/index.js";

export interface AppFrameProps {
  readonly route: ConsoleRoute;
  readonly railEntries: readonly RailEntry[];
  readonly railDestination: RailDestination | undefined;
  readonly onSelectDestination: (destination: RailDestination) => void;
  readonly banners: readonly FrameBanner[];
  readonly onDismissBanner: (bannerId: string) => void;
  /** The surface the route resolves to. Mounted inside its own error boundary. */
  readonly children: React.ReactNode;
  /** Rendered above the surface: the palette, dialogs, anything window-scoped. */
  readonly overlays?: React.ReactNode;
}

export function AppFrame(props: AppFrameProps): React.JSX.Element {
  const isAuxiliary = props.route.kind === "auxiliary";
  return (
    <div className={isAuxiliary ? "meridian-frame meridian-frame--auxiliary" : "meridian-frame"}>
      {isAuxiliary ? null : (
        <IconRail
          entries={props.railEntries}
          current={props.railDestination}
          onSelect={props.onSelectDestination}
        />
      )}
      <div className="meridian-frame__column">
        {props.banners.length === 0 ? null : (
          <div className="meridian-frame__banners">
            {props.banners.map((banner) =>
              banner.dismissible ? (
                <RefusalBanner
                  key={banner.id}
                  code={banner.code}
                  detail={banner.detail}
                  onDismiss={() => {
                    props.onDismissBanner(banner.id);
                  }}
                />
              ) : (
                <RefusalBanner key={banner.id} code={banner.code} detail={banner.detail} />
              ),
            )}
          </div>
        )}
        <main className="meridian-frame__surface">
          <SurfaceErrorBoundary surfaceName={surfaceNameFor(props.route)}>
            {props.children}
          </SurfaceErrorBoundary>
        </main>
      </div>
      {props.overlays}
    </div>
  );
}

/** A name a person would use, for the boundary's copy. Never a route id. */
function surfaceNameFor(route: ConsoleRoute): string {
  switch (route.kind) {
    case "sessions":
      return "The sessions list";
    case "workspace":
      return "The session workspace";
    case "settings":
      return "Settings";
    case "auxiliary":
      return route.route === "timeline" ? "The timeline" : "The agent console";
    case "not-found":
      return "This window";
  }
}

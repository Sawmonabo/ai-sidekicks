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
//
// THE BACKGROUND WRAPPER IS THE SHELL'S `inert` GUARD, and it is why the rail and
// the column are wrapped rather than left as direct children. `Spec-023 §Console
// Libraries` adopts the dialog family under `modal="trap-focus"`, which traps focus
// and deliberately does not lock the document's scroll — and leaves inerting the app
// root to the shell, because the dialog cannot know what "the rest of the app" is.
// Focus containment alone leaves the rail and the whole surface in the accessibility
// tree, reachable by every reader that navigates by structure rather than by focus.
// The wrapper carries `display: contents`, so it is a place to hang the attribute
// and not a box: the frame's grid still places the rail and the column itself, which
// is what keeps this a one-attribute change rather than a layout one. `overlays`
// stays OUTSIDE it — inerting the dialog along with the background would leave a
// person nothing to reach at all.
//
// THE WINDOW'S ONE LIVE ANNOUNCER IS MOUNTED HERE, for the same reason and one
// more. `LiveAnnouncerProvider` renders its two regions above the frame root, so
// they are outside the `inert` wrapper and keep speaking while a dialog is open —
// which is when a refusal is most likely to be raised. And the frame is the widest
// thing that exists once per window: an announcer per surface would be N regions
// competing to be the one a reader hears, which is the defect the primitive exists
// to make unrepresentable. The frame is also its first consumer — see
// `banner-announcements.ts`.
//
// AND IT RUNS ON THE WINDOW'S CLOCK, not on the wall clock. The announcer arms one
// timeout — the hold before a standing message is cleared and the next one is
// spoken — and that is a timer like any other, so `Spec-023 §Console Design
// (Meridian)` §The fixture bridge's "the fixture clock is the only clock the
// renderer reads in fixture mode" binds it. Left on `RealClock` it was the one
// subsystem in a fixture window still reading wall time: a refusal raised by a
// scenario beat cleared on how fast the runner happened to be, so what a reader
// hears and what a screenshot captures both depended on the host. `useConsoleClock`
// is the same answer `ui-state-lifecycle.ts` and `session-lifecycle.ts` ask for,
// and the frame is where it is asked because `primitives/` sits below `bridge/` in
// the family DAG and cannot ask for itself.

import { useConsoleClock } from "../bridge/index.js";
import { LiveAnnouncerProvider, RefusalBanner } from "../primitives/index.js";
import { type FrameBanner } from "../store/index.js";
import { useRefusalBannerAnnouncements } from "./banner-announcements.js";
import { SurfaceErrorBoundary } from "./ErrorBoundary.js";
import { IconRail, type RailEntry } from "./IconRail.js";
import {
  formatRoute,
  isAuxiliaryRoute,
  type ConsoleRoute,
  type RailDestination,
} from "../routing/index.js";

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
  /**
   * True while a modal overlay owns focus.
   *
   * The frame's background is `inert` for exactly that lifetime — see the
   * background-wrapper note in the file header. It is a prop rather than
   * something the frame works out for itself because the overlay slot is filled
   * by the caller: the frame renders whatever it is handed and is not the owner
   * of any overlay's open state.
   */
  readonly modalOverlayOpen?: boolean;
}

/**
 * The window's chrome, wrapped in the announcer that outlives every surface in it.
 *
 * Two components rather than one because the announcement hook has to run BELOW the
 * provider — context is read by tree position — and a component cannot consume a
 * provider it renders itself.
 */
export function AppFrame(props: AppFrameProps): React.JSX.Element {
  const announcerClock = useConsoleClock();
  return (
    <LiveAnnouncerProvider clock={announcerClock}>
      <FrameChrome {...props} />
    </LiveAnnouncerProvider>
  );
}

function FrameChrome(props: AppFrameProps): React.JSX.Element {
  const isAuxiliary = isAuxiliaryRoute(props.route);
  useRefusalBannerAnnouncements(props.banners);
  return (
    <div className={isAuxiliary ? "meridian-frame meridian-frame--auxiliary" : "meridian-frame"}>
      <div className="meridian-frame__background" inert={props.modalOverlayOpen === true}>
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
            {/*
              KEYED BY THE ROUTE, so navigating away from a crash is the retry.
              The boundary's caught error is its own state and its identity used to
              be constant across every route, so one surface's render throw hid the
              NEXT surface behind the previous route's failure card until someone
              clicked "Try again" — a control that offered to re-render a route they
              had already left. `formatRoute` rather than a second identity
              function: it is the routing family's existing total, round-tripping
              rendering of a route, so two routes are one boundary exactly when they
              are one address.
            */}
            <SurfaceErrorBoundary
              key={formatRoute(props.route)}
              surfaceName={surfaceNameFor(props.route)}
            >
              {props.children}
            </SurfaceErrorBoundary>
          </main>
        </div>
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
    case "workflows":
      return "Workflows";
    case "settings":
      return "Settings";
    case "auxiliary":
      return route.route === "timeline" ? "The timeline" : "The agent console";
    case "not-found":
      return "This window";
  }
}

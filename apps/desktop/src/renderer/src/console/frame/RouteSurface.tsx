// Route in, surface out — and three ways of having nothing to show.
//
// Resolution happens DURING RENDER, deliberately: the registry is composed at module
// scope by the console's entry point, so a descriptor is there to be looked up on the
// first pass. Resolving in an effect instead would mean the first paint has already
// said the surface does not exist.
//
// The absences are kept apart because a person's next move differs for each of them,
// which is `Spec-023 §Console Design (Meridian)` rule 8:
//
//   • **Not-found** — the address names nothing. The way back is the sessions list.
//   • **A bare auxiliary route** — a WORKING window that has not been given a
//     subject. It gets the picker, not an error. The picker offers this window's
//     open sessions and owns its own absence — see `ContextPicker.tsx` for why
//     that source, and why it is not the route's session store.
//   • **A session still opening** — the route named a session and its store is not
//     open yet, which is a read in flight and renders as one.
//   • **A slot with no renderer** — reserved, not stubbed. The console says the
//     surface has not been built, which is true, rather than rendering an empty pane
//     that reads as a broken feature.

import { COMMAND_PALETTE_OPEN_CHORD } from "../palette/index.js";
import { ChordHint, Nothing } from "../primitives/index.js";
import { isAuxiliaryRoute, needsContextPicker } from "../routing/index.js";
import { ContextPicker } from "./ContextPicker.js";
import {
  consoleSurfaceRegistry,
  surfaceSlotFor,
  type ConsoleSurfaceContext,
} from "./surface-registry.js";

export interface RouteSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

/** Resolve a route to a surface. */
export function RouteSurface(props: RouteSurfaceProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;

  if (route.kind === "not-found") {
    return (
      <SurfaceAbsence>
        <Nothing
          kind="error"
          title="That address does not name anything in the console."
          detail={`Nothing is registered for ${route.attempted}. The Sessions list is the way back.`}
        />
      </SurfaceAbsence>
    );
  }

  // `needsContextPicker` owns the rule. `isAuxiliaryRoute` is beside it because it
  // is a type predicate and the rule's own helper is a boolean: the narrowing that
  // makes `route.route` readable below has to come from one of them, and neither is
  // a hand-written copy of the comparison they replaced.
  if (isAuxiliaryRoute(route) && needsContextPicker(route)) {
    return (
      <ContextPicker
        route={route.route}
        registry={context.sessionStoreRegistry}
        onChoose={(sessionId) => {
          context.frameStore.navigate({ ...route, sessionId });
        }}
      />
    );
  }

  // A route that names a session shows nothing of that session until its store is
  // open, and the open rides an effect rather than this render (`session-lifecycle.ts`
  // says why). So there is one frame where the store is absent, and the honest
  // rendering of that frame is a read in flight.
  if (context.frameStore.activeSessionId !== undefined && context.sessionStore === undefined) {
    return (
      <SurfaceAbsence>
        <Nothing kind="not-loaded" title="This session is opening." />
      </SurfaceAbsence>
    );
  }

  const slot = surfaceSlotFor(route);
  const descriptor = slot === undefined ? undefined : consoleSurfaceRegistry.descriptorFor(slot);
  if (descriptor === undefined) {
    return (
      <SurfaceAbsence>
        <Nothing
          kind="empty"
          title="This surface has not been built yet."
          detail={
            slot === undefined
              ? "The route resolves to no surface."
              : `Nothing is registered for the "${slot}" surface. It is reserved, not missing — the family that owns it has not shipped.`
          }
        />
      </SurfaceAbsence>
    );
  }
  return <>{descriptor.render(context)}</>;
}

/**
 * A whole-surface absence, composed rather than left in flow.
 *
 * The `Nothing` primitive's `empty` arm is a quiet line, which is right where it
 * belongs — inside a list that came back with no rows. A route that resolves to no
 * surface is a different scale of absence: the same quiet line pinned to the
 * top-left of a 1440 px window reads as a page that failed to finish painting. So
 * the frame centres it on a measure and pairs it with the one control that
 * definitely works, which keeps "there is nothing here" from also meaning "and
 * there is nothing you can do".
 *
 * Exported because this file is not the only producer of one: `legacy-surfaces.ts`
 * raises two more — the fixture-source refusal and the address-names-no-session
 * refusal — and both are the same scale of absence. A second centring wrapper
 * there would be two renderings of one idea, drifting apart the first time either
 * measure changed, and only the screenshot tier would ever see it.
 */
export function SurfaceAbsence(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-frame__absence">
      <div className="meridian-frame__absence-body">{props.children}</div>
      <p className="meridian-frame__absence-hint">
        <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} /> opens the command palette.
      </p>
    </div>
  );
}

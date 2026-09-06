// Route in, surface out — and four ways of having nothing to show.
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
//     subject. It gets the picker, not an error. The picker offers the node's
//     sessions and this window's open ones, and owns its own absence — see
//     `ContextPicker.tsx` for why those sources, and why neither is the route's
//     session store.
//   • **A session still opening** — the route named a session and its store is not
//     open yet, which is a read in flight and renders as one.
//   • **A slot with no renderer** — reserved, not stubbed. The console says the
//     surface has not been built, which is true, rather than rendering an empty pane
//     that reads as a broken feature.
//
// Three of the four reach the screen through the `SurfaceAbsence` primitive, which
// is the console's one centring wrapper; `seats/absorbed-surfaces.ts` raises two more
// through the same component, which is why it is a module and not a block in here.

import { Nothing, SurfaceAbsence } from "../primitives/index.js";
import { isAuxiliaryRoute, needsContextPicker } from "../routing/index.js";
import { ContextPicker } from "./ContextPicker.js";
import {
  consoleSurfaceRegistry,
  surfaceSlotFor,
  type ConsoleSurfaceContext,
} from "../seats/index.js";

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
        growth={context.bridge.growth}
        onChoose={(target) => {
          // The picker hands over a COMPLETE target, so the spread cannot build a
          // route the hash writer will refuse. It used to hand over a session id
          // and this line added it to whatever the route was — which on the
          // agent-console route produced a session with no agent, a shape the
          // shared grammar refuses by throwing, from inside the route-to-hash
          // effect where no surface boundary catches it.
          context.frameStore.navigate({ kind: "auxiliary", ...target });
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

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
// AND THE SURFACE THAT DOES MOUNT IS KEYED ON THE ADDRESS IT WAS MOUNTED AT. Two
// routes can resolve to ONE slot — a second session's workspace, a second pane kind
// in the fixture harness — and React reconciles the same component in the same
// position, so whatever state that surface holds survives a move to a subject it was
// never about. The fixture pane harness is where that was first observed: a hash
// change from one `#/pane-harness/…` address to another left its open-pane count
// standing, so the replacement route mounted the previous route's number of panes
// with no Open action, and on a same-kind session change React reused the pane
// instances themselves against the new session. The key is `formatRoute`'s own
// output rather than a second reading of the route, so there is one grammar deciding
// what "a different address" means.
//
// Three of the four reach the screen through the `SurfaceAbsence` primitive, which
// is the console's one centring wrapper; `seats/absorbed-surfaces.ts` raises three
// more through the same component, which is why it is a module and not a block in here.

import { Fragment } from "react";

import { Nothing, SurfaceAbsence } from "../primitives/index.js";
import {
  formatRoute,
  isAuxiliaryRoute,
  needsContextPicker,
  type ConsoleRoute,
} from "../routing/index.js";
import { ContextPicker } from "./ContextPicker.js";
import { warmRouteSurface } from "./rail-navigation.js";
import {
  consoleSurfaceRegistry,
  surfaceSlotFor,
  type ConsoleSurfaceContext,
} from "../seats/index.js";
import { useGenerationLatch } from "../store/index.js";

/**
 * The latch key the picker's warm-then-commit round is held under.
 *
 * ONE KEY AND NOT ONE PER ROUTE. A window shows at most one picker, and the rule this
 * expresses is "one pending commit per window" — a second choice is the same person
 * changing their mind about the same act. Keying it on the route would give a choice made
 * on one auxiliary route and a choice made on another separate rounds, which is precisely
 * the pair that must not both land.
 */
const PICKER_COMMIT_KEY = "context-picker-commit";

export interface RouteSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

/** Resolve a route to a surface. */
export function RouteSurface(props: RouteSurfaceProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;
  // Unconditionally, above every absence arm: the picker branch below is one of five
  // returns and a hook taken inside it would be taken on some renders and not others.
  const pickerCommitLatch = useGenerationLatch();

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
          const chosen: ConsoleRoute = { kind: "auxiliary", ...target };
          // WARMED, AND UNLIKE THE RAIL'S PRESS THIS ONE WAITS. Both use the same
          // helper, and the difference is what is on screen while it runs. A rail
          // press has a painted surface under it, so the fetch rides beside the
          // commit and the reserved frame is the honest thing to show for the frames
          // it is still in flight. This window has NOTHING under it: the picker is
          // the whole surface, and committing first replaced a working control with
          // a reserved region — after an explicit act, on the one path where the
          // console knew the destination before the person let go of the mouse. So
          // the picker stays up until the body has landed and the route commits onto
          // a settled module.
          //
          // `warmRouteSurface` never rejects, so a chunk that will not load still
          // navigates and surfaces at the mount, inside the console's own error
          // boundary — the window is not left sitting on a picker with no way out.
          //
          // AND THE COMMIT IS GUARDED ON BOTH WAYS THE WAIT CAN BE OVERTAKEN, because
          // waiting is what creates the window in which something else can happen. The
          // load takes as long as a chunk takes, and a continuation that simply
          // navigated when it settled wrote the destination it had been holding over
          // whatever the window had reached in the meantime.
          //
          //   • A SECOND CHOICE. `supersedeAndClaim` is the newest-intent-wins arm, which
          //     is what a person changing their mind about a subject is: the round the
          //     first choice took is abandoned, its `settle` installs nothing, and only
          //     the last press commits. Nothing behind a chunk fetch is cancellable, so
          //     the earlier load still finishes — it just lands nowhere.
          //   • A NAVIGATION AWAY. The latch does not see this one and must not be made
          //     to: nobody superseded the round, so it is still the newest choice, and
          //     the fact that disqualifies it is that the window is no longer where the
          //     choice was made. So the address is read from the store AT SETTLE TIME and
          //     compared with the one the picker was rendered at. Reading the store
          //     rather than the closed-over `route` is the whole point — the closure
          //     holds the render's route, which is the stale value.
          //
          // Both guards refuse silently, which is correct here and not a swallow: the
          // person is already looking at the destination they chose second, or at the one
          // they navigated to. A banner would report a race they resolved themselves.
          const openedAt = formatRoute(route);
          const commit = pickerCommitLatch.supersedeAndClaim(context.frameStore, PICKER_COMMIT_KEY);
          void warmRouteSurface(consoleSurfaceRegistry, chosen).then(() => {
            commit.settle(() => {
              if (formatRoute(context.frameStore.getState().route) !== openedAt) {
                return;
              }
              context.frameStore.navigate(chosen);
            });
            commit.release();
          });
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
  // Keyed, not bare: the fragment IS the mount, so a different address is a
  // different element in this position and React unmounts what the previous one
  // built rather than handing it to a subject it was not addressed at.
  return <Fragment key={formatRoute(route)}>{descriptor.render(context)}</Fragment>;
}

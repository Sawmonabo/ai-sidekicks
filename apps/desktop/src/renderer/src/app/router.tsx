// Route in, screen out — and two ways of having nothing to show.
//
// Resolution happens DURING RENDER, deliberately: the registry is composed at module
// scope by the console's entry point, so a descriptor is there to be looked up on the
// first pass. Resolving in an effect instead would mean the first paint has already
// said the screen does not exist.
//
// The absences are kept apart because a person's next move differs for each of them:
//
//   • **Not-found** — the address names nothing. The way back is the sessions list.
//   • **A session still opening** — the route named a session and its store is not
//     open yet, which is a read in flight and renders as one.
//
// A route whose slot has no registered screen is a composition defect, not an absence
// a person can act on, so it throws. One slot is the exception: only a fixture launch's
// composition registers the pane harness, so in any other window its address names
// nothing and renders as not-found.
//
// AND THE SCREEN THAT DOES MOUNT IS KEYED ON THE ADDRESS IT WAS MOUNTED AT. Two
// routes can resolve to ONE slot — a second session's screen, a second pane kind
// in the fixture harness — and React reconciles the same component in the same
// position, so whatever state that screen holds survives a move to a subject it was
// never about. The fixture pane harness is where that was first observed: a hash
// change from one `#/pane-harness/…` address to another left its open-pane count
// standing, so the replacement route mounted the previous route's number of panes
// with no Open action, and on a same-kind session change React reused the pane
// instances themselves against the new session. The key is `formatRoute`'s own
// output rather than a second reading of the route, so there is one grammar deciding
// what "a different address" means.
//
// Both reach the screen through the `ScreenNotice` primitive, which is the
// console's one centering wrapper; the transcript and the pending screen body draw
// through the same component, which is why it is a module and not a block in here.

import { Fragment } from "react";

import { Nothing, ScreenNotice } from "@renderer/console/primitives/index.js";
import { formatRoute } from "@renderer/routing/routes.js";
import {
  screenRegistry,
  findScreenNameForRoute,
  type ScreenContext,
} from "@renderer/console/seats/index.js";

export interface AppRouterProps {
  readonly context: ScreenContext;
}

/** Resolve a route to a screen. */
export function AppRouter(props: AppRouterProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;

  if (route.kind === "not-found") {
    return <AddressNamesNothing attempted={route.attempted} />;
  }

  // A route that names a session shows nothing of that session until its store is
  // open, and the open rides an effect rather than this render (`app/hooks/useSessionStoreRegistry.ts`
  // says why). So there is one frame where the store is absent, and the honest
  // rendering of that frame is a read in flight.
  if (context.frameStore.activeSessionId !== undefined && context.sessionStore === undefined) {
    return (
      <ScreenNotice>
        <Nothing kind="not-loaded" title="This session is opening." />
      </ScreenNotice>
    );
  }

  const slot = findScreenNameForRoute(route);
  const descriptor = slot === undefined ? undefined : screenRegistry.descriptorFor(slot);
  if (descriptor === undefined) {
    if (route.kind === "pane-harness") {
      return <AddressNamesNothing attempted={formatRoute(route)} />;
    }
    throw new Error(`no screen is registered for the ${route.kind} route`);
  }
  // Keyed, not bare: the fragment IS the mount, so a different address is a
  // different element in this position and React unmounts what the previous one
  // built rather than handing it to a subject it was not addressed at.
  return <Fragment key={formatRoute(route)}>{descriptor.render(context)}</Fragment>;
}

function AddressNamesNothing(props: { readonly attempted: string }): React.JSX.Element {
  return (
    <ScreenNotice>
      <Nothing
        kind="error"
        title="That address does not name anything in the console."
        detail={`Nothing is registered for ${props.attempted}. The Sessions list is the way back.`}
      />
    </ScreenNotice>
  );
}

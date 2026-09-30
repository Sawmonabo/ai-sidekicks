// Route in, screen out, and the two ways of having nothing to show.
//
// Resolution happens during render, since the registry is composed at module scope and an
// effect would let the first paint say the screen does not exist. A not-found address and a
// session still opening are kept apart because a person's next move differs. A route whose
// screen has no registration is a composition defect and throws; the exception is the pane
// harness, which only a fixture launch registers, so elsewhere its address renders as not-found.
//
// The mounted screen is keyed on `formatRoute(route)`. Two routes can resolve to one screen
// name (a second session, a second pane kind in the harness), and without the key React would
// hand the first route's state, such as the harness's open-pane count, to the second. Both
// absences draw through `ScreenNotice`, the console's one centering wrapper.

import { Fragment } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { ScreenNotice } from "@renderer/components/ScreenNotice/ScreenNotice.js";
import { formatRoute } from "@renderer/routing/routes.js";
import {
  screenRegistry,
  findScreenNameForRoute,
} from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

/** The screen context the router resolves the current route against. */
export interface AppRouterProps {
  readonly context: ScreenContext;
}

/**
 * Resolve the context's route to its screen, or to a not-found notice.
 *
 * Throws when a route has no registered screen, which is a composition defect.
 */
export function AppRouter(props: AppRouterProps): React.JSX.Element {
  const { context } = props;
  const { route } = context;

  if (route.kind === "not-found") {
    return <AddressNamesNothing attempted={route.attempted} />;
  }

  // The session's store opens from an effect, so there is one frame where it is absent; that
  // frame is a read in flight.
  if (context.frameStore.activeSessionId !== undefined && context.sessionStore === undefined) {
    return (
      <ScreenNotice>
        <Nothing kind="not-loaded" title="This session is opening." />
      </ScreenNotice>
    );
  }

  const screenName = findScreenNameForRoute(route);
  const descriptor =
    screenName === undefined ? undefined : screenRegistry.descriptorFor(screenName);
  if (descriptor === undefined) {
    if (route.kind === "pane-harness") {
      return <AddressNamesNothing attempted={formatRoute(route)} />;
    }
    throw new Error(`no screen is registered for the ${route.kind} route`);
  }
  // Keyed so a different address unmounts the previous screen's state.
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

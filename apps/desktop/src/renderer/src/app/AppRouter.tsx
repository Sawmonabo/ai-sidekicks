// Route in, screen out, and the two ways of having nothing to show: a not-found address, and a
// session still opening, which shows nothing at first and `Loading…` only once the read has run
// past the short loading delay, so a quick open never flashes a loading line.
//
// Resolution happens during render, since the registry is composed at module scope and an
// effect would let the first paint say the screen does not exist. A route whose screen has no
// registration is a composition defect and throws; the exception is the pane harness, which only
// a fixture launch registers, so elsewhere its address renders as not-found.
//
// The mounted screen is keyed on what it is about, not on the whole address: a second session or
// a second pane kind in the harness gets a fresh screen, so React never hands one subject's state
// to another, while a move inside one destination (a run's page on the workflows screen, a
// settings page, a message in the same session) keeps the screen and what it holds.

import { Fragment } from "react";

import { LoadingNotice } from "@renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { ScreenNotice } from "@renderer/components/ScreenNotice/ScreenNotice.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
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
    return <AddressNamesNothing />;
  }

  // The session's store opens from an effect, so there is one frame where it is absent; that
  // frame is a read in flight.
  if (context.frameStore.activeSessionId !== undefined && context.sessionStore === undefined) {
    return <SessionOpeningNotice />;
  }

  const screenName = findScreenNameForRoute(route);
  const descriptor =
    screenName === undefined ? undefined : screenRegistry.descriptorFor(screenName);
  if (descriptor === undefined) {
    if (route.kind === "pane-harness") {
      return <AddressNamesNothing />;
    }
    throw new Error(`no screen is registered for the ${route.kind} route`);
  }
  // Keyed so a different subject unmounts the previous screen's state.
  return <Fragment key={screenSubjectKey(route)}>{descriptor.render(context)}</Fragment>;
}

function SessionOpeningNotice(): React.JSX.Element {
  const clock = useClock();
  return (
    <ScreenNotice>
      <LoadingNotice clock={clock} title="Loading…" />
    </ScreenNotice>
  );
}

/**
 * What the mounted screen is about: the session for a session, the pane kind and session for the
 * harness, and the destination alone for the rest, whose screens follow their own address.
 */
function screenSubjectKey(route: Exclude<AppRoute, { kind: "not-found" }>): string {
  switch (route.kind) {
    case "session":
      return `session:${route.sessionId}`;
    case "pane-harness":
      return `pane-harness:${route.paneKind}:${route.sessionId}`;
    case "sessions":
    case "workflows":
    case "settings":
      return route.kind;
  }
}

function AddressNamesNothing(): React.JSX.Element {
  return (
    <ScreenNotice>
      <Nothing
        kind="error"
        title="That address does not name anything in the app."
        detail="The Sessions list is the way back."
      />
    </ScreenNotice>
  );
}

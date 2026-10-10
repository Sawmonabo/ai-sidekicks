// Route in, screen out, and a not-found address as the one way of having nothing to show. A
// session whose store is still opening draws its screen's frame, which the session screen fills
// once the store opens. Before the background service first answers, under the boot cover, every
// screen draws its own frame alone, told so by its context, so what it draws is in place when the
// cover fades.
//
// Resolution happens during render, since the registry is composed at module scope and an
// effect would let the first paint say the screen does not exist. A route whose screen has no
// registration is a composition defect and throws, with two exceptions: the pane harness, which
// only a fixture launch registers, so elsewhere its address renders as not-found; and the
// sidekicks and skills screens, which draw the empty frame until their features register them.
//
// The mounted screen is keyed on what it is about, not on the whole address: a second session or
// a second pane kind in the harness gets a fresh screen, so React never hands one subject's state
// to another, while a move inside one destination (a run's page on the workflows screen, a
// settings page, a message in the same session, `Browse plugins` and a definition under Sidekicks,
// a file in a skill folder) keeps the screen and what it holds.

import { Fragment } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { ScreenNotice } from "#renderer/components/ScreenNotice/ScreenNotice.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { screenRegistry, findScreenNameForRoute } from "#renderer/registries/screens/registry.js";
import { PendingScreenBody } from "#renderer/registries/screens/PendingScreenBody.js";
import { type ScreenContext } from "#renderer/registries/screens/context.js";

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

  const screenName = findScreenNameForRoute(route);
  const descriptor =
    screenName === undefined ? undefined : screenRegistry.descriptorFor(screenName);
  if (descriptor === undefined) {
    if (screenName === "sidekicks" || screenName === "skills") {
      return <PendingScreenBody />;
    }
    if (route.kind === "pane-harness") {
      return <AddressNamesNothing />;
    }
    throw new Error(`no screen is registered for the ${route.kind} route`);
  }
  // Keyed so a different subject unmounts the previous screen's state.
  return <Fragment key={screenSubjectKey(route)}>{descriptor.render(context)}</Fragment>;
}

/**
 * What the mounted screen is about: the session for a session, the pane kind and session for the
 * harness, and the destination alone for the rest, whose screens follow their own address; both
 * sidekicks arms are the one Sidekicks screen.
 */
function screenSubjectKey(route: Exclude<AppRoute, { kind: "not-found" }>): string {
  switch (route.kind) {
    case "session":
      return `session:${route.sessionId}`;
    case "pane-harness":
      return `pane-harness:${route.paneKind}:${route.sessionId}`;
    case "sidekicks":
    case "sidekicks-plugins":
      return "sidekicks";
    case "sessions":
    case "skills":
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

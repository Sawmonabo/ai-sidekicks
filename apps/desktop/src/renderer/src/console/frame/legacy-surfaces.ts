// Which shipped Tier-1 renderer family mounts in which console slot.
//
// Three families shipped before the console existed and were rendered by the
// renderer root directly: the session probe, the participant roster, and the
// runtime-node roster. When the console took over the root they stopped being
// rendered by anything, which is not a decision anybody made — it is what happens
// when a new mount point lands before the old surfaces are re-homed. This module
// re-homes them.
//
// ABSORBED BY IMPORT, NOT BY CALL. A plan-owned subtree whose owner MOUNTS INTO
// the console reaches the frame by calling `registerConsoleSurface`; the console
// imports it through no path, which is why the layering gate bans those subtrees
// outright. These three are the stated exception — they are shipped Tier-1
// components with no owner left to make the call, so the console absorbs them.
//
// WHY THIS IS A `.ts` MODULE THAT BUILDS ELEMENTS RATHER THAN A COMPONENT FILE.
// It owns a TABLE — slot, owner, and what mounts there — not a view. Written as a
// `.tsx` it would be one file holding three anonymous components, which is the
// shape the file-naming rule exists to prevent; split into three component files
// it would be three files whose only content is one element each, and the table
// itself — the part a reader actually needs — would be spread across four places.
//
// WHY EACH MOUNT IS GUARDED ON THE BRIDGE SOURCE. All three components read
// `window.sidekicks` directly rather than taking a bridge from context, so the
// console's fixture cannot stand in for the preload the way it does for every
// console-authored surface. Under the fixture they would reach past it: in a
// window with no preload at all they throw into the surface boundary and read as
// a crash, and in the fixture build they would answer from the live daemon beside
// fixture data in the same window, which is worse than answering nothing. So the
// frame says the question was not put, which is exactly what happened.

import { createElement, type ReactNode } from "react";

import type { SessionId } from "@ai-sidekicks/contracts";

import { Nothing } from "../primitives/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { SurfaceAbsence } from "./RouteSurface.js";
import { NodeRoster } from "../../runtime-node-attach/index.js";
import { SessionBootstrap } from "../../session-bootstrap/index.js";
// Deep, because `session-members/` ships no barrel. The other two are reached
// through theirs. Adding one is that family's own diff, not the console's — the
// console does not author files inside a subtree it merely absorbs.
import { ParticipantRoster } from "../../session-members/participant-roster.js";
import {
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
  type ConsoleSurfaceRegistry,
} from "./surface-registry.js";

/**
 * The three shipped families, and the slot each mounts in.
 *
 * `sessions` and `workspace` are the destinations that name these surfaces; the
 * runtime-node roster takes the `agent-console` auxiliary window because it is
 * about the machines a session's agents run on, and because that slot's route
 * grammar is the only remaining one that GUARANTEES the session id the roster
 * requires — the frame resolves a bare auxiliary route through its context picker
 * before any surface renders, so the mount needs no invented empty state.
 *
 * The components each family exports beyond these three take inputs no route
 * carries — an invite token, an attach draft — so a route cannot supply them and
 * a slot for them would be a slot nothing could ever fill.
 */
const LEGACY_SURFACES: readonly ConsoleSurfaceDescriptor[] = [
  {
    slot: "sessions",
    owner: "session-bootstrap",
    render: (context) => mountLegacySurface(context, () => createElement(SessionBootstrap)),
  },
  {
    slot: "workspace",
    owner: "session-members",
    render: (context) =>
      mountSessionScopedLegacySurface(context, (sessionId) =>
        createElement(ParticipantRoster, { sessionId }),
      ),
  },
  {
    slot: "agent-console",
    owner: "runtime-node-attach",
    render: (context) =>
      mountSessionScopedLegacySurface(context, (sessionId) =>
        createElement(NodeRoster, { sessionId }),
      ),
  },
];

/**
 * Claim a slot for each shipped Tier-1 family.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for the
 * same reason `registerConsoleFamilies` does: composition is the caller's, so a
 * test can compose into a registry it owns and an auxiliary window can compose a
 * subset without a second code path.
 */
export function registerLegacySurfaces(registry: ConsoleSurfaceRegistry): void {
  for (const descriptor of LEGACY_SURFACES) {
    registry.register(descriptor);
  }
}

/**
 * Render a shipped component, or say that no question was put.
 *
 * `not-checked` rather than `error`: nothing failed. The console is running
 * against the fixture, this surface reads the installed bridge directly, and so
 * the console declined to ask on its behalf. Reporting that as an error would
 * assert a failure that never happened, which is the conflation the five kinds of
 * nothing exist to prevent.
 */
function mountLegacySurface(context: ConsoleSurfaceContext, build: () => ReactNode): ReactNode {
  if (context.bridge.source !== "live") {
    // Centred, because this fills the whole surface. Left in flow it renders as a
    // strip in the top-left corner of the pane — the shape `SurfaceAbsence` exists
    // to prevent, and the one a reader mistakes for a paint that did not finish.
    return createElement(
      SurfaceAbsence,
      null,
      createElement(Nothing, {
        kind: "not-checked",
        title:
          "This surface reads the installed bridge, and this window is running on the fixture.",
        detail:
          "It renders in the application, where the preload bridge is installed. Nothing was asked of the daemon here.",
      }),
    );
  }
  return build();
}

/** The same, for a component that needs the session the route names. */
function mountSessionScopedLegacySurface(
  context: ConsoleSurfaceContext,
  build: (sessionId: SessionId) => ReactNode,
): ReactNode {
  return mountLegacySurface(context, () => {
    const sessionId = subjectSessionId(context.route);
    if (sessionId === undefined) {
      return createElement(
        SurfaceAbsence,
        null,
        createElement(Nothing, {
          kind: "empty",
          title: "This surface needs a session, and this address names none.",
          detail: "Open a session from the Sessions list and the surface follows it.",
        }),
      );
    }
    return build(sessionId);
  });
}

/**
 * The session a route is about, as the wire's branded id.
 *
 * The brand is compile-time nominal typing over a plain string, and the narrowing
 * happens HERE — once, named, at the one seam where an address segment becomes a
 * wire argument — rather than at each call site. It is deliberately not a
 * validation: whether the id names a session is the daemon's answer, every one of
 * these components already renders the daemon's refusal verbatim, and a
 * renderer-side UUID check would be a second authority on that question bought
 * with a schema validator in a bundle budget measured in kilobytes.
 */
function subjectSessionId(route: ConsoleRoute): SessionId | undefined {
  switch (route.kind) {
    case "workspace":
      return route.sessionId as SessionId;
    case "auxiliary":
      return route.sessionId === undefined ? undefined : (route.sessionId as SessionId);
    case "sessions":
    case "settings":
    case "not-found":
      return undefined;
  }
}

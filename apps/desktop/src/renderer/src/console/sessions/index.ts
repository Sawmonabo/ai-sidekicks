// The sessions family's door.
//
// One surface — the all-sessions list the `sessions` rail destination mounts — and
// the stylesheet it renders through, imported here and nowhere else. The list, the
// invitations shelf, the ordering rule, and the two durable view states behind them
// are reached deeply from inside; a door onto a room with no other entrance is not
// a door.
//
// This family REPLACES the shipped session probe's claim on the `sessions` slot.
// The probe itself is not discarded: it is the only caller of `session.create` and
// `session.join` that exists, so the list absorbs it into its own layout through
// `seats/absorbed-surfaces.ts` rather than re-authoring two live calls beside it —
// and mounts it ON THE START PRESS rather than with the surface, because the probe
// creates from its mount effect and the route lifecycle remounts this slot.
//
// THE OTHER WAY TO HAVE A SESSION IS COMPOSED RATHER THAN PROBED, and it is not this
// family's component. The draft control belongs to the workspace family, a view
// family this one may not import — `console-view-family-isolation` fails that edge —
// so it arrives as a COMPOSITION argument named by `families.ts`, the one file above
// every family. The COMPONENT rather than a built element: which component mounts is
// the root's decision, and which props it takes is this family's, because the bridge
// comes off the surface context the root cannot reach when it registers.

import "./sessions.css";

import { createElement, type ComponentType } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsoleSurfaceRegistry } from "../seats/index.js";
import { SessionsSurface } from "./SessionsSurface.js";

/** What the composition root supplies this family, because this family may not import it. */
export interface SessionsSurfaceComposition {
  readonly newSessionControl: ComponentType<{ readonly bridge: ConsoleBridge }>;
}

/** Claim the sessions surface slot. */
export function registerSessionsSurface(
  registry: ConsoleSurfaceRegistry,
  composition: SessionsSurfaceComposition,
): void {
  registry.register({
    slot: "sessions",
    owner: "collaboration-sessions",
    render: (context) =>
      createElement(SessionsSurface, {
        context,
        // NOT behind the absorbed mount's bridge-source guard, and that is the
        // difference between the two controls: the probe reaches `window.sidekicks`
        // directly, so the fixture cannot stand in for it, while the composed draft is
        // console-authored and takes the bridge it is handed. It runs on the fixture
        // exactly as it runs on the live preload.
        newSession: createElement(composition.newSessionControl, { bridge: context.bridge }),
      }),
  });
}

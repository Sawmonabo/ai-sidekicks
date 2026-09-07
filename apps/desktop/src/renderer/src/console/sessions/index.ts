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

import "./sessions.css";
import "./acts/session-acts.css";

import { createElement } from "react";

import type { ConsoleSurfaceRegistry, FrameBindingRegistry } from "../seats/index.js";
import { SessionAttentionBinding } from "./SessionAttentionBinding.js";
import { SessionsSurface } from "./SessionsSurface.js";

/** Claim the sessions surface slot. */
export function registerSessionsSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "sessions",
    owner: "collaboration-sessions",
    render: (context) => createElement(SessionsSurface, { context }),
  });
}

/**
 * Claim the frame-lifetime binding this family keeps.
 *
 * A SECOND REGISTRAR AND NOT A SECOND CALL INSIDE THE FIRST, because the two boards
 * are two different claims with two different lifetimes: the surface above is mounted
 * when a route names it, and this is mounted once for the window. A composition that
 * wanted the destination without the read — or the read without the destination —
 * would have no way to say so if one call claimed both.
 */
export function registerSessionAttentionBinding(registry: FrameBindingRegistry): void {
  registry.register({
    slot: "session-attention",
    owner: "collaboration-sessions",
    mount: (props) => createElement(SessionAttentionBinding, props),
  });
}

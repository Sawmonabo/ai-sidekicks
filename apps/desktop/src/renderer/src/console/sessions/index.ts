// The sessions family's door.
//
// One surface — the all-sessions list the `sessions` rail destination mounts — and
// the stylesheet it renders through, imported here and nowhere else.
//
// This family REPLACES the shipped session probe's claim on the `sessions` slot.
// The probe itself is not discarded: it is the only caller of `session.create` and
// `session.join` that exists, so the list absorbs it into its own layout through
// the frame's absorption helper rather than re-authoring two live calls beside it.

import "./sessions.css";

import { createElement } from "react";

import type { ConsoleSurfaceRegistry } from "../frame/surface-registry.js";
import { SessionsSurface } from "./SessionsSurface.js";

/** Claim the sessions surface slot. */
export function registerSessionsSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "sessions",
    owner: "collaboration-sessions",
    render: (context) => createElement(SessionsSurface, { context }),
  });
}

// Re-exports the `timeline.*` query binder. It carries the canonical
// method-to-schema descriptor so a caller cannot bind a name to the wrong shapes.
// Nothing calls it at bootstrap, so no `timeline.*` method is on the wire.

export { registerTimelineMethod } from "./timeline-methods.js";

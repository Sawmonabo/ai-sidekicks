// Re-exports the `transcript.*` binder, which takes one descriptor carrying the method name and
// its schemas, so a handler cannot be bound to another method's shapes.

export { registerTranscriptMethod } from "./transcript-methods.js";

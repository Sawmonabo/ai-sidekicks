// Re-exports the `timeline.*` binders and the `highlight.read` binder.
// `registerTimelineMethod` binds the queries and `registerTimelineSubscription`
// binds `timeline.subscribe`; BOTH are exported, because the query binder is
// TYPED to refuse the subscription. `registerTimelineBodyRead` binds
// `timeline.bodyRead` with the stored-row read it needs. Each carries the
// canonical method-to-schema descriptor so a caller cannot bind a name to the
// wrong shapes. Nothing calls these binders at bootstrap, so none of these
// methods is on the wire yet.

export { registerHighlightRead } from "./highlight-read.js";
export {
  registerTimelineBodyRead,
  registerTimelineMethod,
  registerTimelineSubscription,
  TimelineSubscriptionScopeError,
} from "./timeline-methods.js";

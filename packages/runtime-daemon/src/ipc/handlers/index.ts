// Re-exports the `timeline.*` binders: `registerTimelineMethod` for the three
// queries and `registerTimelineSubscription` for `timeline.subscribe`. BOTH are
// exported, because the query binder is TYPED to refuse the subscription, so a
// caller that could reach only the query binder could register three of the
// four methods. Each carries the canonical method-to-schema descriptor so a
// caller cannot bind a name to the wrong shapes. Nothing calls either binder at
// bootstrap, so no `timeline.*` method is on the wire.

export {
  registerTimelineMethod,
  registerTimelineSubscription,
  TimelineSubscriptionScopeError,
} from "./timeline-methods.js";

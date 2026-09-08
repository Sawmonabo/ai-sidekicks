// The census reading both stream suites drive their assertions from.
//
// Hoisted on this package's second-use rule the moment the kind tables moved to
// `session-event-stream-kinds.ts` and their suite moved with them: the readings a
// case needs about the census — which category a wire-verbatim string is registered
// under, which kinds one category registers, every kind it registers at all — beside
// the kinds one stream declares and a stable order to compare two sets in. A second
// copy of `carriedKindsOf` is two suites disagreeing about what "the kinds this
// stream carries" is read THROUGH, which is the disagreement the routing table itself
// exists to end.
//
// THE CENSUS IS RE-KEYED AND KEPT, NOT EXPORTED. `SESSION_EVENT_CATEGORY_BY_TYPE` is
// keyed to the `SessionEventType` union, so asking it about an arbitrary string needs
// a cast at every call site, and the questions these suites ask are all "is this
// wire-verbatim string registered, and as what" — a string question. What leaves this
// module is therefore the derived reading rather than the collection: an exported
// `Map` is one mutable object every importer shares however it is annotated, which is
// what `no-restricted-syntax` says here and what `apps/desktop/AGENTS.md` §State and
// views says everywhere.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type EventCategory } from "@ai-sidekicks/contracts";

import {
  sessionEventStreamFor,
  type ConsoleSessionEventStreamName,
} from "./session-event-streams.js";

/** The registered forward, non-state rollback row — the state stream's second arm. */
export const ROLLED_BACK_KIND = "run.rolled_back";

const CATEGORY_BY_REGISTERED_KIND: ReadonlyMap<string, EventCategory> = new Map(
  SESSION_EVENT_CATEGORY_BY_TYPE,
);

/** Every event type the census registers, in census order. */
export const EVERY_REGISTERED_EVENT_KIND: readonly string[] = [
  ...CATEGORY_BY_REGISTERED_KIND.keys(),
];

/**
 * The category this wire-verbatim string is registered under, or `undefined` when
 * the census registers no such event type at all.
 */
export function registeredCategoryOf(eventKind: string): EventCategory | undefined {
  return CATEGORY_BY_REGISTERED_KIND.get(eventKind);
}

/** Every registered event type in one category, read from the census. */
export function registeredKindsIn(category: EventCategory): readonly string[] {
  return [...CATEGORY_BY_REGISTERED_KIND.entries()]
    .filter(([, registeredCategory]) => registeredCategory === category)
    .map(([eventType]) => eventType);
}

/** The kinds one stream that declares a kind list carries, as the table declares them. */
export function carriedKindsOf(subscriptionName: ConsoleSessionEventStreamName): readonly string[] {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined || stream.scope === "whole-session") {
    throw new Error(`${subscriptionName} declares no kind list, so it carries none`);
  }
  return stream.carriedKinds;
}

/** One order to compare two sets of kinds in, so neither side's order is the claim. */
export function sorted(kinds: Iterable<string>): readonly string[] {
  return [...kinds].sort();
}

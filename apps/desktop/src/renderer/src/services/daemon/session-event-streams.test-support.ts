// The census readings both stream suites use, so they agree on what a stream carries and can
// compare sets in one order. The census map is not exported: it is keyed to `SessionEventType`,
// the suites ask about arbitrary strings, and an exported `Map` is one mutable object every
// importer shares.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type EventCategory } from "@ai-sidekicks/contracts";

import { sessionEventStreamFor, type SessionEventStreamName } from "./session-event-streams.js";

/** The registered rollback row, the state stream's second arm. */
export const ROLLED_BACK_KIND = "run.rolled_back";

const CATEGORY_BY_REGISTERED_KIND: ReadonlyMap<string, EventCategory> = new Map(
  SESSION_EVENT_CATEGORY_BY_TYPE,
);

/** Every event type the census registers, in census order. */
export const EVERY_REGISTERED_EVENT_KIND: readonly string[] = [
  ...CATEGORY_BY_REGISTERED_KIND.keys(),
];

/** The category this wire-verbatim string is registered under, or `undefined` if none. */
export function registeredCategoryOf(eventKind: string): EventCategory | undefined {
  return CATEGORY_BY_REGISTERED_KIND.get(eventKind);
}

/** Every registered event type in one category, read from the census. */
export function registeredKindsIn(category: EventCategory): readonly string[] {
  return [...CATEGORY_BY_REGISTERED_KIND.entries()]
    .filter(([, registeredCategory]) => registeredCategory === category)
    .map(([eventType]) => eventType);
}

/** The kinds one stream declares, as the table declares them; throws for a stream with no list. */
export function carriedKindsOf(subscriptionName: SessionEventStreamName): readonly string[] {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined || stream.scope !== "selected-kinds") {
    throw new Error(`${subscriptionName} declares no kind list, so it carries none`);
  }
  return stream.carriedKinds;
}

/** One order to compare two sets of kinds in, so neither side's order is the claim. */
export function sorted(kinds: Iterable<string>): readonly string[] {
  return [...kinds].sort();
}

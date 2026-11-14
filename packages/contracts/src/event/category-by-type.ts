// Each session event type's category as a map, for a reader that looks a type up before the
// event is checked.
import type { EventCategory } from "../generated/event/envelope.js";
import type { SessionEventType } from "../generated/event/registry.js";
import { SESSION_EVENT_CATEGORY_RECORD } from "../generated/event/type-categories.js";

/**
 * Each registered wire type's category. A `ReadonlyMap`, not an object, so an untrusted
 * `.get(type)` read before checking cannot walk the prototype chain to `__proto__` or
 * `constructor`.
 */
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as [SessionEventType, EventCategory][],
);

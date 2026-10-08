// The envelope version of the session events the daemon writes outside a run.

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";

/**
 * The envelope version of a session's lifecycle and directory events, its shells' changes of
 * holder and its purge receipts; parsed at load, so a bad literal throws at import.
 */
export const SESSION_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

// The event every apply-chokepoint failure-mode suite hands the store: the session they drive and
// the overrides shape their cases use to make one member wrong at a time. The event literal and
// the sequence-to-timestamp rule live in `@test/helpers/session-events.js`; several cases
// deliver sequences `Date` cannot represent (`NaN`, infinities), so a builder that threw on
// them would fail before the store saw the event it must refuse.

import type { ProjectedSessionEvent } from "./entities/entities.js";
import { eventOfKind } from "@test/helpers/session-events.js";

/** One event at `sequence`, on the session every suite drives. */
export function eventAt(
  sequence: number,
  overrides: Partial<ProjectedSessionEvent> = {},
): ProjectedSessionEvent {
  return { ...eventOfKind("session-1", "run.starting", sequence), ...overrides };
}

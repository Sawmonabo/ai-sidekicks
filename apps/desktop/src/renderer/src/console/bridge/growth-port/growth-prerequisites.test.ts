// An `event-type` slate row claims a type is absent from the shipped census. This is
// the gate that reads the claim instead of believing it.
//
// I-023-13 already checks that every ledger entry resolves to a slate row and that
// every entry is fixture-only while its row is unregistered. Both of those are checks
// on the ledger's INTERNAL agreement, and an `event-type` row makes a claim about
// something outside it: that `packages/contracts` does not register the type. Nothing
// read that. The day `Plan-016 T1.13` widens the census by its two agent-switch
// terminals, the two rows below would have gone on reporting a debt already paid —
// and the surfaces waiting on them would have gone on rendering the absence, because
// nothing would have told anyone the wire had landed.
//
// The check runs in the direction the slate is written in: a row that names a type is
// asserting the type is NOT registered, so a registered type is the red case. The
// negative control is the other half — a type that IS registered has to be found by
// the same lookup, or a lookup that always answered "absent" would pass the whole
// table and prove nothing.
//
// WHY A ROW MAY NAME NO TYPE, AND WHY THAT IS RECORDED RATHER THAN ALLOWED. A row
// whose unmet need is a registration COUNTED rather than enumerated has no list to
// carry: the console does not hold the twenty-four workflow event types anywhere, and
// writing them here from a document would be this package authoring a wire shape.
// That row is named below with its reason, so the class stays a tripwire — a new
// `event-type` row that carries neither a list nor an entry there is a red case
// rather than a silent hole.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { GROWTH_PREREQUISITES } from "./growth-prerequisites.js";
import type { GrowthPrerequisiteEntry, GrowthPrerequisiteId } from "./growth-entry.js";

/** The canonical registry the daemon's own type census is read out of. */
function isRegisteredEventType(candidate: string): boolean {
  return SESSION_EVENT_CATEGORY_BY_TYPE.has(candidate as SessionEventType);
}

/**
 * The `event-type` rows that enumerate no type, with the reason each one cannot.
 *
 * A debt with a name on it, on `slate-row-consumers.test.ts`' own pattern: deleting an
 * entry to make the gate pass is the move this table exists to make visible.
 */
const EVENT_TYPE_ROWS_THAT_ENUMERATE_NOTHING: Readonly<
  Partial<Record<GrowthPrerequisiteId, string>>
> = {
  workflowEventTypeRegistration:
    "a registration counted rather than enumerated — the console holds the twenty-four workflow event types nowhere, and spelling them here from a document would be this package authoring a wire shape",
};

function eventTypeEntries(): readonly GrowthPrerequisiteEntry[] {
  return Object.values(GROWTH_PREREQUISITES).filter((entry) => entry.kind === "event-type");
}

describe("growth prerequisites — an event-type row's claim is checked against the census", () => {
  it("walks a table with event-type rows in it", () => {
    // The vacuity floor: a filter that matched nothing would pass every case below.
    expect(eventTypeEntries().length).toBeGreaterThan(0);
  });

  it("names no type the shipped census already registers", () => {
    const landed = eventTypeEntries().flatMap((entry) =>
      (entry.unregisteredEventTypes ?? []).filter(isRegisteredEventType).map((eventType) => ({
        entry: entry.id,
        eventType,
      })),
    );

    expect(
      landed,
      "these event types are registered now — delete their slate rows, and wire the surfaces that were waiting",
    ).toEqual([]);
  });

  it("carries the two agent-switch terminals as separate rows", () => {
    // The defect this member was added for: the ledger named the failure terminal and
    // not the applied one, so a reader concluded the console was owed one event. They
    // are registered by one amendment and consumed by different surfaces.
    const named = eventTypeEntries().flatMap((entry) => entry.unregisteredEventTypes ?? []);

    expect(named).toContain("agent.provider_switched");
    expect(named).toContain("agent.provider_switch_failed");
    expect(GROWTH_PREREQUISITES.agentProviderSwitchedEvent.slateRow).toBe(
      "agent-provider-switch-terminal",
    );
    expect(GROWTH_PREREQUISITES.agentProviderSwitchFailedEvent.slateRow).toBe(
      "agent-provider-switch-failure",
    );
  });

  it("negative control: the census lookup finds a type that IS registered", () => {
    // Without this, a lookup that answered "absent" for everything would pass the
    // whole table — including on the day the two terminals land.
    expect(isRegisteredEventType("agent.config_updated")).toBe(true);
    expect(isRegisteredEventType("agent.provider_switched")).toBe(false);
  });

  it("holds every event-type row to a list, or to a recorded reason for having none", () => {
    const unenumerated = eventTypeEntries()
      .filter((entry) => entry.unregisteredEventTypes === undefined)
      .map((entry) => entry.id)
      .filter((id) => EVENT_TYPE_ROWS_THAT_ENUMERATE_NOTHING[id] === undefined);

    expect(
      unenumerated,
      "an event-type row that names no type is unreadable by the check above — enumerate its types, or record why it cannot",
    ).toEqual([]);
  });

  it("holds no recorded reason for a row that now enumerates its types", () => {
    // The other direction, so an entry does not outlive the gap it excused.
    const nowEnumerated = Object.keys(EVENT_TYPE_ROWS_THAT_ENUMERATE_NOTHING).filter(
      (id) => GROWTH_PREREQUISITES[id as GrowthPrerequisiteId].unregisteredEventTypes !== undefined,
    );

    expect(nowEnumerated, "this row carries its types now — take it off the reason table").toEqual(
      [],
    );
  });

  it("never carries an empty list, which would read as a checked claim about nothing", () => {
    const empty = eventTypeEntries()
      .filter((entry) => entry.unregisteredEventTypes?.length === 0)
      .map((entry) => entry.id);

    expect(empty).toEqual([]);
  });
});

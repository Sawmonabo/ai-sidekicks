// One runtime-node roster entry, built once for both suites that need one.
//
// The model suite reads what the picker's rows are built FROM, and the dialog suite
// serves a roster over the bridge and then changes it; both need an admitted entry and
// neither owns the shape. Written twice it would drift exactly where drift is invisible
// — the `healthState` arm, which is nullable on the wire and `undefined` after this
// family's own reader has folded it.

import type { RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

/**
 * Overrides as a case writes them.
 *
 * The wire's ids are branded and nothing in a test mints one, so the builder loosens
 * exactly those and leaves every union member exact — the shape
 * `repo-mounts.test-support.ts` uses for the same reason. `healthState` is spelled
 * nullable rather than optional because that is what the wire makes it: a node with no
 * presence row carries `null`, and `undefined` is what this family's reader turns that
 * into.
 */
export interface RosterEntryOverrides {
  readonly nodeId?: string;
  readonly state?: RuntimeNodeRosterEntry["state"];
  readonly healthState?: RuntimeNodeRosterEntry["healthState"];
  readonly readOnly?: boolean;
}

export function rosterEntry(overrides: RosterEntryOverrides = {}): RuntimeNodeRosterEntry {
  return {
    nodeId: "9f2c4a10-0000-4000-8000-000000000002",
    userId: "9f2c4a10-0000-4000-8000-000000000010",
    state: "online",
    healthState: "online",
    lastHeartbeatAt: "2026-01-01T09:00:00.000Z",
    readOnly: false,
    capabilities: {},
    clientVersion: "1.4",
    attachedAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  } as RuntimeNodeRosterEntry;
}

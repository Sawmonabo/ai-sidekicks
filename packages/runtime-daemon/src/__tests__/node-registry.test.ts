// NodeRegistry over a real SQLite file: the registration is keyed by machine and owning user,
// needs no session, and a re-registration keeps the first-seen time.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../database/__fixtures__/scratch-file.js";
import type { NodeTrustStateRow } from "../node-registry.js";
import { NodeRegistry } from "../node-registry.js";

// `NodeId` is a daemon-minted opaque scalar, not a UUID.
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const OWNER_USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const OTHER_USER_ID: string = "01J0PB0000NN5J5J5J5J5J5J5J";

let scratch: ScratchDatabase;

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
});

function tableRowCount(tableName: string): number {
  const row = scratch.reader.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

describe("NodeRegistry", () => {
  it("keys the registration by machine and owning user", async () => {
    const registry = new NodeRegistry(scratch);
    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeUndefined();

    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeDefined();
    expect(registry.lookup(NODE_ID, OTHER_USER_ID)).toBeUndefined();
    expect(registry.lookup("node-never-registered", OWNER_USER_ID)).toBeUndefined();
  });

  it("registers without a session: only the registration row is written", async () => {
    const beforeSnapshots: number = tableRowCount("session_snapshots");

    await new NodeRegistry(scratch).register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    expect(tableRowCount("session_events")).toBe(0);
    expect(tableRowCount("session_snapshots")).toBe(beforeSnapshots);
  });

  it("refreshes only updated_at on re-registration", async () => {
    const clock: string[] = ["2026-06-02T12:00:00.000Z", "2026-06-03T08:30:00.000Z"];
    let tick: number = 0;
    const registry = new NodeRegistry(scratch, () => {
      const instant: string | undefined = clock[tick++];
      if (instant === undefined) {
        throw new Error("the test clock ran out of instants");
      }
      return instant;
    });

    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });
    await registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    const row: NodeTrustStateRow | undefined = registry.lookup(NODE_ID, OWNER_USER_ID);
    expect(row?.established_at).toBe(clock[0]);
    expect(row?.updated_at).toBe(clock[1]);
  });
});

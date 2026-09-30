// NodeRegistry over a real SQLite file: the registration is keyed by machine and owning user,
// needs no session, and a re-registration keeps the first-seen time.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import type { NodeTrustStateRow } from "../node-registry.js";
import { NodeRegistry } from "../node-registry.js";

// `NodeId` is a daemon-minted opaque scalar, not a UUID.
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const OWNER_USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const OTHER_USER_ID: string = "01J0PB0000NN5J5J5J5J5J5J5J";

interface TestContext {
  database: DatabaseType;
  temporaryDirectory: string;
}

let context: TestContext;

beforeEach(() => {
  const temporaryDirectory: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-node-registry-"));
  context = { database: openDatabase(join(temporaryDirectory, "test.db")), temporaryDirectory };
});

afterEach(() => {
  context.database.close();
  rmSync(context.temporaryDirectory, { recursive: true, force: true });
});

function tableRowCount(tableName: string): number {
  const row = context.database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

describe("NodeRegistry", () => {
  it("keys the registration by machine and owning user", () => {
    const registry = new NodeRegistry(context.database);
    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeUndefined();

    registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(registry.lookup(NODE_ID, OWNER_USER_ID)).toBeDefined();
    expect(registry.lookup(NODE_ID, OTHER_USER_ID)).toBeUndefined();
    expect(registry.lookup("node-never-registered", OWNER_USER_ID)).toBeUndefined();
  });

  it("registers without a session: only the registration row is written", () => {
    const beforeSnapshots: number = tableRowCount("session_snapshots");
    const beforeUserKeys: number = tableRowCount("user_keys");

    new NodeRegistry(context.database).register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    expect(tableRowCount("session_events")).toBe(0);
    expect(tableRowCount("session_snapshots")).toBe(beforeSnapshots);
    expect(tableRowCount("user_keys")).toBe(beforeUserKeys);
  });

  it("refreshes only updated_at on re-registration", () => {
    const clock: string[] = ["2026-06-02T12:00:00.000Z", "2026-06-03T08:30:00.000Z"];
    let tick: number = 0;
    const registry = new NodeRegistry(context.database, () => {
      const instant: string | undefined = clock[tick++];
      if (instant === undefined) {
        throw new Error("the test clock ran out of instants");
      }
      return instant;
    });

    registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });
    registry.register({ nodeId: NODE_ID, ownerUserId: OWNER_USER_ID });

    expect(tableRowCount("node_trust_state")).toBe(1);
    const row: NodeTrustStateRow | undefined = registry.lookup(NODE_ID, OWNER_USER_ID);
    expect(row?.established_at).toBe(clock[0]);
    expect(row?.updated_at).toBe(clock[1]);
  });
});

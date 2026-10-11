// A runtime binding store over a scratch database for each test, with the test's own connection
// for raw reads and staged rows, and a binding's spawn-bound record shaped as real contract values.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach } from "vitest";

import { makeAdvancingClock } from "../../__fixtures__/advancing-clock.js";
import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { RuntimeBindingStore, type RuntimeBindingSpawnConfig } from "../runtime-binding-store.js";

/** The run most tests bind. */
export const RUN_ID: string = "run-01J0ND0000NN5J5J5J5J5J5J";
/** A run whose bindings must not show up under `RUN_ID`. */
export const OTHER_RUN_ID: string = "run-01J0ND0000NN5K5K5K5K5K5K";
/** The provider most tests bind. */
export const DRIVER_NAME: ProviderName = "claude";
/** A canonical contract version. */
export const CONTRACT_VERSION: string = "1.2.3";

/** A sandboxed posture, as a run starts with it. */
export const EXECUTION_POSTURE: ExecutionPosture = {
  writableRoots: ["/workspace/repo"],
  mode: "sandboxed",
  credentialPolicyRef: "policy://default",
};

/** A spawn-bound record with every member of the closed key set. */
export const FULL_SPAWN_CONFIG: RuntimeBindingSpawnConfig = {
  executionPosture: EXECUTION_POSTURE,
  callbackTools: [
    { name: "ask_human", description: "Ask the person", inputSchema: { type: "object" } },
  ],
  subagentPolicy: { enabled: false },
  toolServers: [
    { serverName: "sidekicks", enabled: true },
    { serverName: "github", enabled: false },
  ],
  outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  providerAccountId: "acct-01J0ND0000NN5J5J5J5J5J5J",
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  outputSpeed: "on",
};

/** The store and the test's own connection to the database under it, fresh for each test. */
export interface BindingDatabase {
  /** A store over this test's database, its ids `binding-0`, `binding-1` and on. */
  makeStore(now?: () => string): RuntimeBindingStore;
  /** The test's own connection, for raw reads and rows the store would refuse. */
  connection(): DatabaseType;
}

/** Opens a scratch database before each test of the calling file and closes it after. */
export function useBindingDatabase(): BindingDatabase {
  let scratch: ScratchDatabase | undefined;
  let connection: DatabaseType | undefined;
  beforeEach(async () => {
    scratch = await openScratchDatabase();
    connection = new Database(scratch.databasePath);
  });
  afterEach(async () => {
    connection?.close();
    await scratch?.close();
  });
  const opened = (): { scratch: ScratchDatabase; connection: DatabaseType } => {
    if (scratch === undefined || connection === undefined) {
      throw new Error("The binding database opens only inside a test");
    }
    return { scratch, connection };
  };
  return {
    makeStore: (now = makeAdvancingClock()) => {
      let counter = 0;
      return new RuntimeBindingStore(opened().scratch, {
        now,
        newId: () => `binding-${(counter++).toString()}`,
      });
    },
    connection: () => opened().connection,
  };
}

/** The `spawn_config` column as it landed, which the store's parsing reads cannot show. */
export function readRawSpawnConfig(connection: DatabaseType, id: string): string {
  const row = connection
    .prepare(`SELECT spawn_config FROM runtime_bindings WHERE id = ?`)
    .get(id) as { spawn_config: string } | undefined;
  if (row === undefined) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
  return row.spawn_config;
}

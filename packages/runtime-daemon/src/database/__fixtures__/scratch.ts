// A daemon database in a temporary folder, opened the way the daemon opens it: the writer holds
// the one read-write connection on its worker thread, and reads go through a read-only one.

import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import {
  closeDatabaseConnections,
  openDatabaseConnections,
  type DatabaseConnections,
} from "../connection/lifecycle.js";

/** An open scratch database; `close` closes both connections and removes the folder. */
export interface ScratchDatabase extends DatabaseConnections {
  readonly databasePath: string;
  readonly close: () => Promise<void>;
}

/**
 * Opens a fresh database with its schema in a new temporary folder; the writer's service log lines
 * go to `writeServiceLog`, or nowhere.
 */
export async function openScratchDatabase(
  writeServiceLog: ServiceLogWriter = () => {},
): Promise<ScratchDatabase> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aisk-database-"));
  const databasePath = path.join(folder, "daemon.db");
  const connections = await openDatabaseConnections({
    databasePath,
    writeServiceLog,
  });
  return {
    ...connections,
    databasePath,
    close: async () => {
      await closeDatabaseConnections(connections);
      await rm(folder, { recursive: true, force: true });
    },
  };
}

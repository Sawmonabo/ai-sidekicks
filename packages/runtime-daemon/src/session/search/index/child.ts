// The search index's build, in a child process of its own that the search thread starts and waits
// on, so the build's memory goes with the process: it opens the daemon's database read-only, builds
// the index from it and exits. A failed build sends what it threw before the process exits with a
// failure, and the process exits as soon as the daemon is gone, so it never outlives it; a build cut
// short leaves only its own folder, which the next build clears.

import type { Database as DatabaseType } from "better-sqlite3";

import { withCleanupFailures } from "../../../cleanup-failures.js";
import { openDatabaseReader } from "../../../database/connection/setup.js";
import { carryError } from "../../../worker/carried-error.js";
import { buildSearchIndex, type SearchIndexBuildFailure } from "./rebuild.js";
import { IndexRowReader } from "./rows.js";

const sendToDaemon = process.send?.bind(process);
if (sendToDaemon === undefined) {
  throw new Error("The search index's build runs only as a child process the daemon starts");
}
const [databasePath, indexFolderPath, lastOutboxId] = process.argv.slice(2);
if (databasePath === undefined || indexFolderPath === undefined || lastOutboxId === undefined) {
  throw new Error(
    "The search index's build is started with the database, the index folder and the outbox id",
  );
}

const exitAsDaemonGone = (): void => {
  process.exit(1);
};
process.once("disconnect", exitAsDaemonGone);

let reader: DatabaseType | undefined;
try {
  reader = openDatabaseReader(databasePath);
  await buildSearchIndex(indexFolderPath, new IndexRowReader(reader), Number(lastOutboxId));
  reader.close();
  process.off("disconnect", exitAsDaemonGone);
  process.exit(0);
} catch (error) {
  const cleanupFailures: unknown[] = [];
  try {
    reader?.close();
  } catch (closeError) {
    cleanupFailures.push(closeError);
  }
  const failure: SearchIndexBuildFailure = {
    type: "failed",
    error: carryError(withCleanupFailures(error, cleanupFailures, "The search index's build")),
  };
  process.off("disconnect", exitAsDaemonGone);
  // Exits once the failure is handed over, or at once when the daemon can no longer hear it.
  sendToDaemon(failure, undefined, undefined, () => {
    process.exit(1);
  });
}

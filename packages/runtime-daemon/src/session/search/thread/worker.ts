// The search thread: a read-only connection of its own to the daemon's database and the search
// index beside it, on which every session and transcript search runs and every outbox batch is read
// and applied, so no index call and no search read ever holds the daemon's main thread. It opens
// the index, building it again in a child process when it cannot serve, and brings it in step with
// the database before it answers its first search. From then on each notice that writes committed
// has it apply what the outbox holds, and a merge runs on the index's own thread while searches go
// on.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { withCleanupFailures } from "../../../cleanup-failures.js";
import {
  carrySearchError,
  type SearchThreadAnswer,
  type SearchThreadCall,
  type SearchThreadReply,
  type SearchThreadRequest,
  type SearchThreadWorkerData,
} from "./messages.js";
import { openSearchServices, type SearchServices } from "./services.js";

if (parentPort === null) {
  throw new Error("The search thread runs only as a worker thread");
}
const port: MessagePort = parentPort;
const post = (reply: SearchThreadReply): void => {
  port.postMessage(reply);
};

const { databasePath, indexFolderPath } = workerData as SearchThreadWorkerData;

// Writes that commit while the index opens are applied once it has.
let isApplyDue = false;
const noteWritesWhileOpening = (request: SearchThreadRequest): void => {
  if (request.type === "writes-committed") {
    isApplyDue = true;
  }
};
port.on("message", noteWritesWhileOpening);

void open();

async function open(): Promise<void> {
  let reader: DatabaseType | undefined;
  try {
    reader = new Database(databasePath, { readonly: true, fileMustExist: true });
    const services = await openSearchServices({
      reader,
      databasePath,
      indexFolderPath,
      onApplied: (applied) => {
        post({ type: "index-applied", applied });
      },
    });
    port.off("message", noteWritesWhileOpening);
    serve(reader, services);
    post({ type: "opened", rebuildReason: services.rebuildReason });
    if (isApplyDue) {
      applyWaiting(services);
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      reader?.close();
    } catch (closeError) {
      cleanupFailures.push(closeError);
    }
    post({
      type: "open-failed",
      error: carrySearchError(
        withCleanupFailures(error, cleanupFailures, "The search thread's open"),
      ),
    });
    port.close();
  }
}

function serve(connection: DatabaseType, services: SearchServices): void {
  // The merge under way, which a close waits for.
  let merging: Promise<void> | undefined;
  port.on("message", (request: SearchThreadRequest) => {
    if (request.type === "writes-committed") {
      applyWaiting(services);
      return;
    }
    const answering = answer(request).then(
      (answered) => {
        post({ ...answered, id: request.id });
      },
      (error: unknown) => {
        post({ type: "failed", id: request.id, error: carrySearchError(error) });
      },
    );
    if (request.type === "merge") {
      merging = answering;
    }
    if (request.type === "close") {
      void answering.then(() => {
        port.close();
      });
    }
  });

  async function answer(call: SearchThreadCall): Promise<SearchThreadAnswer> {
    switch (call.type) {
      case "session.search":
        return { type: "session-searched", response: services.sessionSearch.search(call.request) };
      case "transcript.search":
        return {
          type: "transcript-searched",
          response: services.transcriptSearch.search(call.request),
        };
      case "merge":
        return { type: "merged", isMoreToMerge: await services.mergeWhileIdle() };
      case "close":
        await merging;
        try {
          await services.close();
        } finally {
          connection.close();
        }
        return { type: "closed" };
    }
  }
}

// A failed apply leaves the index behind the database, so the main thread hears of it and fails
// every search from then on.
function applyWaiting(services: SearchServices): void {
  void services.applyWaiting().catch((error: unknown) => {
    post({ type: "index-failed", error: carrySearchError(error) });
  });
}

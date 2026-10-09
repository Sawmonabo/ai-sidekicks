// The search thread: a read-only connection of its own to the daemon's database and the search
// index beside it, on which every session and transcript search runs and every outbox batch is read
// and applied, so no index call and no search read ever holds the daemon's main thread. It opens
// the index, building it again in a child process when it cannot serve, and brings it in step with
// the database before it answers its first search. From then on each notice that writes committed
// has it apply what the outbox holds, and a merge runs on the index's own thread while searches go
// on. A close that comes while the index opens ends a build under way and answers once the build's
// process has exited, so no build outlives the thread.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type { Database as DatabaseType } from "better-sqlite3";

import { withCleanupFailures } from "../../../cleanup-failures.js";
import { openDatabaseReader } from "../../../database/connection/setup.js";
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

// Writes that commit while the index opens are applied once it has. A close while it opens aborts
// the open and is answered once the open has settled.
let isApplyDue = false;
let closeWhileOpeningId: number | undefined;
const opening = new AbortController();
const noteRequestsWhileOpening = (request: SearchThreadRequest): void => {
  if (request.type === "writes-committed") {
    isApplyDue = true;
  } else if (request.type === "close") {
    closeWhileOpeningId = request.id;
    opening.abort(new Error("The search thread closed while its index opened"));
  }
};
port.on("message", noteRequestsWhileOpening);

void open();

async function open(): Promise<void> {
  let reader: DatabaseType | undefined;
  try {
    reader = openDatabaseReader(databasePath);
    const services = await openSearchServices({
      reader,
      databasePath,
      indexFolderPath,
      onApplied: (applied) => {
        post({ type: "index-applied", applied });
      },
      signal: opening.signal,
    });
    port.off("message", noteRequestsWhileOpening);
    if (closeWhileOpeningId !== undefined) {
      answerClose(closeWhileOpeningId, closeServices(reader, services));
      return;
    }
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
    const failure = carrySearchError(
      withCleanupFailures(error, cleanupFailures, "The search thread's open"),
    );
    if (closeWhileOpeningId === undefined) {
      post({ type: "open-failed", error: failure });
    } else if (error === opening.signal.reason && cleanupFailures.length === 0) {
      post({ type: "closed", id: closeWhileOpeningId });
    } else {
      post({ type: "failed", id: closeWhileOpeningId, error: failure });
    }
    port.close();
  }
}

// Closes the index, then the thread's connection, whichever fails.
async function closeServices(connection: DatabaseType, services: SearchServices): Promise<void> {
  try {
    await services.close();
  } finally {
    connection.close();
  }
}

// Answers the close request `id` once `closing` settles, then ends the thread.
function answerClose(id: number, closing: Promise<void>): void {
  void closing
    .then(
      () => {
        post({ type: "closed", id });
      },
      (error: unknown) => {
        post({ type: "failed", id, error: carrySearchError(error) });
      },
    )
    .then(() => {
      port.close();
    });
}

function serve(connection: DatabaseType, services: SearchServices): void {
  // The merge under way, which a close waits for.
  let merging: Promise<void> | undefined;
  port.on("message", (request: SearchThreadRequest) => {
    if (request.type === "writes-committed") {
      applyWaiting(services);
      return;
    }
    if (request.type === "close") {
      answerClose(
        request.id,
        Promise.resolve(merging).then(() => closeServices(connection, services)),
      );
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
  });

  async function answer(
    call: Exclude<SearchThreadCall, { readonly type: "close" }>,
  ): Promise<SearchThreadAnswer> {
    switch (call.type) {
      case "session.search":
        return { type: "session-searched", response: services.sessionSearch.search(call.request) };
      case "transcript.search":
        return {
          type: "transcript-searched",
          response: services.transcriptSearch.search(call.request, call.damagedFromSequence),
        };
      case "merge":
        return { type: "merged", isMoreToMerge: await services.mergeSegments() };
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

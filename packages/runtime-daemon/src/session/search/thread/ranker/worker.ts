// A ranker: a worker thread with a read-only connection of its own, on which the search thread
// has one rowid range of a broad search's ranking read, so the ranges are scored at once rather
// than one after another. The search thread has the read opened as soon as its own starts, and
// learns the index version it sees, which tells whether every range read the index its page reads;
// the range is then ranked within that read, which ends with the ranking.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { SearchIndexVersion } from "../../index/version.js";
import { SessionTextRanking, type RankedRange } from "../../ranking.js";
import { carryError } from "../../../../worker-thread/carried-error.js";
import type { RankerReply, RankerRequest, RankerWorkerData } from "./messages.js";

if (parentPort === null) {
  throw new Error("A ranker runs only as a worker thread");
}
const port: MessagePort = parentPort;
const post = (reply: RankerReply, transfer: ArrayBuffer[] = []): void => {
  port.postMessage(reply, transfer);
};

const { databasePath } = workerData as RankerWorkerData;
let connection: DatabaseType | undefined;
try {
  connection = new Database(databasePath, { readonly: true, fileMustExist: true });
} catch (error) {
  post({ type: "open-failed", error: carryError(error) });
  port.close();
}
if (connection !== undefined) {
  serve(connection);
  post({ type: "opened" });
}

function serve(reader: DatabaseType): void {
  const ranking = new SessionTextRanking(reader);
  const indexVersion = new SearchIndexVersion(reader);
  const endRead = (): void => {
    if (reader.inTransaction) {
      reader.exec("COMMIT");
    }
  };
  port.on("message", (request: RankerRequest) => {
    switch (request.type) {
      case "open-read": {
        let version: number;
        try {
          reader.exec("BEGIN");
          // The read's first statement fixes what the read sees.
          version = indexVersion.read();
        } catch (error) {
          post({ type: "rank-failed", error: carryError(error) });
          return;
        }
        post({ type: "read-opened", version });
        return;
      }
      case "rank": {
        let range: RankedRange;
        try {
          try {
            range = request.readsSessions
              ? ranking.rankRangeWithSessions(request.matchExpression, request.range)
              : ranking.rankRange(request.matchExpression, request.range);
          } finally {
            endRead();
          }
        } catch (error) {
          post({ type: "rank-failed", error: carryError(error) });
          return;
        }
        post(
          {
            type: "ranked",
            rowids: range.rowids,
            ranks: range.ranks,
            sessionRowids: range.sessionRowids,
            sequences: range.sequences,
          },
          [range.rowids, range.ranks, range.sessionRowids, range.sequences].flatMap((column) =>
            column === undefined ? [] : [column.buffer],
          ),
        );
        return;
      }
      case "end-read":
        try {
          endRead();
        } catch (error) {
          post({ type: "rank-failed", error: carryError(error) });
          return;
        }
        post({ type: "read-ended" });
        return;
      case "close":
        reader.close();
        post({ type: "closed" });
        port.close();
        return;
    }
  });
}

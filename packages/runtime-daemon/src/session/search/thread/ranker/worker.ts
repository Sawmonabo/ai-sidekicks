// A ranker: a worker thread with a read-only connection of its own, on which the search thread
// has one rowid range of a broad search's ranking read, so the ranges are scored at once rather
// than one after another. Each range is read in one read with the index version it saw, which
// tells the search thread whether every range read the same index.

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
  const rankRange = reader.transaction(
    (request: Extract<RankerRequest, { type: "rank" }>): [number, RankedRange] => [
      indexVersion.read(),
      request.readsSessions
        ? ranking.rankRangeWithSessions(request.matchExpression, request.range)
        : ranking.rankRange(request.matchExpression, request.range),
    ],
  );
  port.on("message", (request: RankerRequest) => {
    switch (request.type) {
      case "rank": {
        let version: number;
        let range: RankedRange;
        try {
          [version, range] = rankRange(request);
        } catch (error) {
          post({ type: "rank-failed", error: carryError(error) });
          return;
        }
        post(
          {
            type: "ranked",
            version,
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
      case "close":
        reader.close();
        post({ type: "closed" });
        port.close();
        return;
    }
  });
}

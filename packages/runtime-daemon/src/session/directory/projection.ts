// The session directory row as a projection of the log, which a rebuild replaces: the row's
// event-derived columns are folded from the session's events and written over the row, or into a
// new one where the row was lost. The row is never deleted, so the columns services write, its
// group among them, outlive the rebuild, and the search index keeps the rows it holds by the row's
// rowid.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";

import {
  ProjectionFailureError,
  type SessionProjection,
  type SessionProjectionFold,
} from "../../recovery/projection-rebuild.js";
import type { SessionDirectoryRow } from "../records.js";
import { directoryRowStatement, foldDirectoryRow, openDirectoryRow } from "./row.js";

function foldDirectory(): SessionProjectionFold {
  let row: SessionDirectoryRow | undefined;
  return {
    apply(event: SessionEvent) {
      if (row === undefined) {
        if (event.type !== "session.created") {
          throw new ProjectionFailureError(
            `Session ${event.sessionId}'s log opens with ${event.type}, not session.created`,
          );
        }
        row = openDirectoryRow(event);
        return [directoryRowStatement(row)];
      }
      if (event.type === "session.created") {
        throw new ProjectionFailureError(
          `Session ${event.sessionId}'s log holds a second session.created`,
        );
      }
      const next = foldDirectoryRow(row, event);
      if (isSameRow(row, next)) {
        return [];
      }
      row = next;
      return [directoryRowStatement(row)];
    },
  };
}

function isSameRow(row: SessionDirectoryRow, next: SessionDirectoryRow): boolean {
  return (Object.keys(row) as (keyof SessionDirectoryRow)[]).every(
    (field) => row[field] === next[field],
  );
}

/**
 * The `sessions` row as a rebuild replaces it. Almost every event moves the row's last activity,
 * so the fold reads every registered event type.
 */
export const SESSION_DIRECTORY_PROJECTION: SessionProjection = {
  name: "sessions",
  eventTypes: new Set(SESSION_EVENT_CATEGORY_BY_TYPE.keys()),
  clearStatements: () => [],
  createFold: foldDirectory,
};

// Reading one step's input, output or log by the payload reference its row stores: an inline
// payload is read here and paged by item; a payload kept as an artifact is answered as its
// reference, which the artifact read follows.

import type { Statement } from "better-sqlite3";

import type { WorkflowPayloadRef } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type {
  WorkflowStepReadRequest,
  WorkflowStepReadResponse,
} from "@ai-sidekicks/contracts/workflow/run/step/methods";

import type { DatabaseConnections } from "../../database/connections.js";
import { workflowStepNotFound } from "./refusals.js";

interface PayloadRow {
  readonly node_id: string;
  readonly attempt: number;
  readonly payload_ref: string;
}

const READ_PAYLOAD_SQL = `SELECT node_id, attempt,
    CASE @which WHEN 'input' THEN input_ref WHEN 'output' THEN output_ref ELSE log_ref END
      AS payload_ref
  FROM workflow_steps
  WHERE workflow_run_id = @workflowRunId AND execution_index = @executionIndex`;

// An inline page's cursor is the index of the first item it starts at.
const ITEM_CURSOR_PATTERN = /^(0|[1-9]\d*)$/u;

/** Reads one step's stored payloads for its step panel. */
export class WorkflowStepPayloadReader {
  readonly #readPayload: Statement<
    [{ which: string; workflowRunId: string; executionIndex: number }],
    PayloadRow
  >;

  constructor(database: Pick<DatabaseConnections, "reader">) {
    this.#readPayload = database.reader.prepare(READ_PAYLOAD_SQL);
  }

  /**
   * The request's payload of the step it names. An inline payload is paged from the cursor's item,
   * `limit` items at a time or the rest when no limit is given, with a cursor while items remain;
   * an artifact payload is its reference, whole. Throws `workflow.not_found` for a step that is
   * not stored, and throws for a cursor past the payload's end or not one this reader wrote.
   */
  read(request: WorkflowStepReadRequest): WorkflowStepReadResponse {
    const row = this.#readPayload.get({
      which: request.which,
      workflowRunId: request.workflowRunId,
      executionIndex: request.executionIndex,
    });
    if (row === undefined || row.node_id !== request.nodeId || row.attempt !== request.attempt) {
      throw workflowStepNotFound(request);
    }
    // The row stores the reference the engine wrote from a typed value.
    const payload = JSON.parse(row.payload_ref) as WorkflowPayloadRef;
    const answer = {
      nodeId: request.nodeId,
      executionIndex: request.executionIndex,
      which: request.which,
    };
    if (payload.kind === "artifact") {
      return { ...answer, payload };
    }
    const start = request.cursor === undefined ? 0 : readItemCursor(request.cursor);
    if (start > payload.items.length) {
      throw new Error(
        `Cursor ${String(start)} is past the payload's ${String(payload.items.length)} items`,
      );
    }
    const end =
      request.limit === undefined
        ? payload.items.length
        : Math.min(start + request.limit, payload.items.length);
    return {
      ...answer,
      payload: { kind: "inline", items: payload.items.slice(start, end) },
      nextCursor: end < payload.items.length ? String(end) : undefined,
    };
  }
}

function readItemCursor(cursor: string): number {
  if (!ITEM_CURSOR_PATTERN.test(cursor)) {
    throw new Error(`"${cursor}" is not a step payload cursor`);
  }
  return Number(cursor);
}

// A daemon for the runs list that pages as the contract says one does: each run listed once
// across pages, a cursor naming where the last page ended rather than an offset, so a run that
// arrives between two pages shifts nothing. A case can add a run while the table is open, with or
// without the notice the daemon would send for it, delete one, and count what the table asked.

import type {
  WorkflowRunListResponse,
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow-run-records";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow-run";

import { WORKFLOW_RUN_RECORDS, summaryOfRun } from "@fixtures/data/workflow-runs.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { WORKFLOW_NOTICE_STREAM } from "@renderer/services/daemon/session-event-streams.js";

/** The runs list's daemon: its rows, the call arm and stream arm it answers through. */
export class RunListDaemon {
  #rows: WorkflowRunSummary[];
  readonly #streamHandlers = new Set<(payload: unknown) => void>();

  /** Answer `workflow.runList` itself and pass every other call to the playback. */
  public readonly answer = async (
    call: RecordedDaemonCall,
    passThrough: () => Promise<unknown>,
  ): Promise<unknown> =>
    call.method === "workflow.runList" ? this.#page(call.params) : passThrough();

  /** Open the workflow stream through the playback, keeping its handler so a case can notify. */
  public readonly open = (
    passThrough: (deliver?: (payload: unknown) => void) => Unsubscribe,
    handler: (payload: unknown) => void,
    _request: unknown,
    _onEnded: unknown,
    event: string,
  ): Unsubscribe => {
    const release = passThrough();
    if (event !== WORKFLOW_NOTICE_STREAM) {
      return release;
    }
    this.#streamHandlers.add(handler);
    return () => {
      this.#streamHandlers.delete(handler);
      release();
    };
  };

  public constructor(rows: readonly WorkflowRunSummary[] = playbackRunRows()) {
    this.#rows = [...rows];
  }

  /** Every run, newest first. */
  public get rows(): readonly WorkflowRunSummary[] {
    return this.#rows;
  }

  /** A new run at the top of the list, told to the stream as the daemon tells it when asked. */
  public arrive(run: WorkflowRunSummary, options: { readonly isNotified: boolean }): void {
    this.#rows = [run, ...this.#rows];
    if (options.isNotified) {
      this.notify(run);
    }
  }

  /** Delete a run, told to the stream as the daemon tells a removal. */
  public remove(workflowRunId: WorkflowRunId): void {
    this.#rows = this.#rows.filter((row) => row.workflowRunId !== workflowRunId);
    for (const handler of this.#streamHandlers) {
      handler({ kind: "runsRemoved", workflowRunIds: [workflowRunId] });
    }
  }

  /** Send the stream's notice that `run` moved. */
  public notify(run: WorkflowRunSummary): void {
    for (const handler of this.#streamHandlers) {
      handler({ kind: "run", run });
    }
  }

  #page(params: unknown): WorkflowRunListResponse {
    const { cursor, limit } = params as { readonly cursor?: string; readonly limit?: number };
    const start =
      cursor === undefined ? 0 : this.#rows.findIndex((row) => row.workflowRunId === cursor) + 1;
    const end = limit === undefined ? this.#rows.length : start + limit;
    const runs = this.#rows.slice(start, end);
    const last = runs.at(-1);
    return {
      runs,
      ...(end < this.#rows.length && last !== undefined ? { nextCursor: last.workflowRunId } : {}),
      totalCount: this.#rows.length,
    };
  }
}

/** The runs the playback holds, newest first, as the daemon lists them. */
export function playbackRunRows(): WorkflowRunSummary[] {
  return WORKFLOW_RUN_RECORDS.toSorted(
    (left, right) => left.startedMinutesAgo - right.startedMinutesAgo,
  ).map(summaryOfRun);
}

/** A run id no playback run holds, numbered so a case can mint as many as it needs. */
export function mintedRunId(index: number): WorkflowRunId {
  return `019b7a10-0280-75e5-8510-ada11a5b${String(index).padStart(4, "0")}` as WorkflowRunId;
}

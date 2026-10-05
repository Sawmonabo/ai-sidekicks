// How far down the runs table reads: the filters it is under and how many pages `Load earlier`
// has asked for, and the answer a read gives back, which names the ask it answered so the tab can
// tell rows still being replaced from rows that answer what is asked now.

import type { WorkflowRunListResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import type { Refusal } from "@renderer/lib/refusal/refusal.js";

import type { RunFilters } from "./run-filters.js";

/** How many runs one page of the table asks for: more than a screen of rows. */
export const RUNS_PAGE_SIZE = 50;

/** What the runs table asks the daemon for: its filters, and how many pages deep. */
export interface RunListAsk {
  readonly filters: RunFilters;
  /** At least one; `Load earlier` adds one, and a filter change starts again at one. */
  readonly pageCount: number;
}

/**
 * The runs drawn for one ask: the runs, where the next page starts, and the total. `pageCount` is
 * how many pages the rows hold, which is the ask's own count unless `Load earlier` could not read
 * the last one, when `earlierRefusal` says why.
 */
export interface RunListAnswer {
  readonly ask: RunListAsk;
  readonly response: WorkflowRunListResponse;
  readonly pageCount: number;
  readonly earlierRefusal?: Refusal;
}

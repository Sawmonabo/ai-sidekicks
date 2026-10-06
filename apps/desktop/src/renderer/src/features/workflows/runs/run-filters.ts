// The runs table's four filters — workflow, status, trigger and date range — and nothing else:
// the request each set asks the daemon, the note a set matching nothing reads in its own words,
// and the record they are kept in on this device so they come back the way they were left.

import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TRIGGER_KINDS,
  type WorkflowRunStatus,
  type WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/run";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowRunListRequest } from "@ai-sidekicks/contracts/workflow/run/records";

import { MILLISECONDS_PER_DAY } from "#renderer/lib/instant.js";
import { RUN_STATUS_WORDS, TRIGGER_KIND_WORDS } from "../words.js";

/** The date ranges the filter offers, from the last day to the last thirty days. */
export const RUN_DATE_RANGES = ["day", "week", "month"] as const;

/** One date range, derived from {@link RUN_DATE_RANGES}. */
export type RunDateRange = (typeof RUN_DATE_RANGES)[number];

/**
 * The four filters as the person set them; an absent member narrows nothing, and the date range
 * always narrows.
 */
export interface RunFilters {
  readonly definitionId?: string;
  readonly status?: WorkflowRunStatus;
  readonly triggerKind?: WorkflowTriggerKind;
  readonly dateRange: RunDateRange;
}

/** The filters the tab opens on and `Clear filters` returns to: the last 7 days, nothing else. */
export const NO_RUN_FILTERS: RunFilters = { dateRange: "week" };

/** The record key the filters are kept under on this device. */
export const RUN_FILTERS_KEY = "workflow-run-filters";

/** Each date range's control label, the words a no-match note says it in, and its span. */
export const RUN_DATE_RANGE_WORDS: Readonly<
  Record<RunDateRange, { readonly label: string; readonly phrase: string; readonly days: number }>
> = {
  day: { label: "Last 24 hours", phrase: "last 24 hours", days: 1 },
  week: { label: "Last 7 days", phrase: "last 7 days", days: 7 },
  month: { label: "Last 30 days", phrase: "last 30 days", days: 30 },
};

/** Whether the filters differ from the ones the tab opens on, so `Clear filters` would act. */
export function hasRunFilters(filters: RunFilters): boolean {
  return (
    filters.definitionId !== undefined ||
    filters.status !== undefined ||
    filters.triggerKind !== undefined ||
    filters.dateRange !== NO_RUN_FILTERS.dateRange
  );
}

/** The `workflow.runList` request a set of filters asks, its date range counted back from now. */
export function runListRequestFor(filters: RunFilters, nowMs: number): WorkflowRunListRequest {
  const { days } = RUN_DATE_RANGE_WORDS[filters.dateRange];
  return {
    ...(filters.definitionId === undefined
      ? {}
      : { definitionId: filters.definitionId as WorkflowDefinitionId }),
    ...(filters.status === undefined ? {} : { status: [filters.status] }),
    ...(filters.triggerKind === undefined ? {} : { triggerKind: [filters.triggerKind] }),
    startedAfter: new Date(nowMs - days * MILLISECONDS_PER_DAY).toISOString(),
  };
}

/**
 * The note a set of filters matching nothing reads, in the filters' own words:
 * `No run matches Failed in the last 7 days.`, or `No run in the last 7 days.` with only the
 * range set.
 */
export function noRunMatchSentence(filters: RunFilters, workflowName: string | undefined): string {
  const named = [
    filters.definitionId === undefined ? undefined : (workflowName ?? "this workflow"),
    filters.status === undefined ? undefined : RUN_STATUS_WORDS[filters.status],
    filters.triggerKind === undefined ? undefined : TRIGGER_KIND_WORDS[filters.triggerKind],
  ].filter((word): word is string => word !== undefined);
  const { phrase } = RUN_DATE_RANGE_WORDS[filters.dateRange];
  if (named.length === 0) {
    return `No run in the ${phrase}.`;
  }
  const subject =
    named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `No run matches ${subject} in the ${phrase}.`;
}

/** The filters as the `selection` record they are kept in: one identifier per set filter. */
export function persistedRunFilters(filters: RunFilters): Record<string, string> {
  return {
    ...(filters.definitionId === undefined ? {} : { workflow: filters.definitionId }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.triggerKind === undefined ? {} : { trigger: filters.triggerKind }),
    range: filters.dateRange,
  };
}

/**
 * The filters a kept record holds, or `undefined` for a record this app did not write. A member
 * naming a value the contract no longer has is dropped rather than shown.
 */
export function narrowRunFilters(raw: unknown): RunFilters | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const workflow = record["workflow"];
  const status = WORKFLOW_RUN_STATUSES.find((candidate) => candidate === record["status"]);
  const triggerKind = WORKFLOW_TRIGGER_KINDS.find((candidate) => candidate === record["trigger"]);
  const dateRange =
    RUN_DATE_RANGES.find((candidate) => candidate === record["range"]) ?? NO_RUN_FILTERS.dateRange;
  return {
    ...(typeof workflow === "string" && workflow !== "" ? { definitionId: workflow } : {}),
    ...(status === undefined ? {} : { status }),
    ...(triggerKind === undefined ? {} : { triggerKind }),
    dateRange,
  };
}

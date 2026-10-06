// What the run graph shows about each node, read from the document and the run's steps: the
// state its ring carries, whether that ring is amber, whether the node is disabled, the item
// count of its first output, the failure line with its failing item, the words a screen reader
// hears, which node is live and which edges a run is flowing through. Pure and free of the graph
// library, so the page's own chunk can read it without pulling the canvas in.

import type {
  WorkflowDocument,
  WorkflowNode,
} from "@ai-sidekicks/contracts/workflow/definition/definition";
import type {
  WorkflowStep,
  WorkflowStepStatus,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/run";
import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import { formatCount, formatDayClock } from "#renderer/lib/wire/figures.js";
import { isLaterStep, isPersonWaitCause } from "../../steps.js";
import {
  STEP_STATUS_WORDS,
  WAIT_CAUSE_WORDS,
  itemCountWords,
} from "#renderer/features/workflows/words.js";

/** One node as the run draws it: its own document fields and the state of its latest step. */
export interface RunGraphNodeView {
  readonly node: WorkflowNode;
  /** The latest step's status; a node with no step yet is `pending`, which reads `Idle`. */
  readonly status: WorkflowStepStatus;
  /** What a waiting step waits on; absent on every other state. */
  readonly waitCause: WorkflowWaitCause | undefined;
  /** True only on a step waiting on a person, the one state whose ring is amber. */
  readonly isWaitingOnPerson: boolean;
  /** True on a node the document disables, whose input the engine passes straight through. */
  readonly isDisabled: boolean;
  /** `Attempt 2` on a node whose latest step is a retry; absent on a first attempt. */
  readonly attemptWords: string | undefined;
  /** How many items left the node's first output, once its latest step ran through. */
  readonly outputCount: number | undefined;
  /**
   * The failure's first line, verbatim, after the failing item where the error names one
   * (`Item 2 · The summary came back empty`); present only on a failed node that carries either.
   */
  readonly errorLine: string | undefined;
  /**
   * The instant a waiting step resumes itself, `Resumes at 6:00 AM` or `Resumes at Tomorrow 6:00
   * AM`, where one is armed.
   */
  readonly resumeLine: string | undefined;
  /** What the ring says in words, such as `Failed` or `Waiting on your approval`. */
  readonly stateWords: string;
  /** The node's accessible name: every line it draws, such as `Summarize · Failed · Attempt 2`. */
  readonly accessibleName: string;
}

/** Whether a step in each status is live: doing something or held, and not finished. */
const IS_LIVE_STATUS: Readonly<Record<WorkflowStepStatus, boolean>> = {
  pending: false,
  running: true,
  waiting: true,
  "waiting-memory": true,
  succeeded: false,
  failed: false,
  skipped: false,
  canceled: false,
};

/**
 * Whether a step in each status ran through to an output of its own: a success, or a skip,
 * which passes a disabled node's input on or hands on no items. A failed or canceled step's
 * output is not what its node gave.
 */
const HAS_OWN_OUTPUT: Readonly<Record<WorkflowStepStatus, boolean>> = {
  pending: false,
  running: false,
  waiting: false,
  "waiting-memory": false,
  succeeded: true,
  failed: false,
  skipped: true,
  canceled: false,
};

/** A node's first output handle, in the document's `<mode>/<type>/<index>` handle grammar. */
const FIRST_OUTPUT_HANDLE = "outputs/main/0";

/**
 * Every node of the document, the trigger first, each carrying the state of its latest step.
 *
 * A node's latest step is the one with the highest `executionIndex` among its steps, so a node
 * that ran in a loop shows its last pass and a retried node its last attempt. A resume instant's
 * day is counted from `nowMs`.
 */
export function runGraphNodeViews(
  document: WorkflowDocument,
  steps: readonly WorkflowStep[],
  edgeItemCounts: readonly WorkflowEdgeItemCount[],
  nowMs: number,
): readonly RunGraphNodeView[] {
  const latestByNode = latestStepByNode(steps);
  const firstOutputCounts = firstOutputItemCounts(document, edgeItemCounts);
  return [document.trigger, ...document.nodes].map((node) =>
    nodeView(node, latestByNode.get(node.id), firstOutputCounts.get(node.id), nowMs),
  );
}

/**
 * The node whose step is live: of the steps running, waiting or held for memory, the latest by
 * execution order. Absent once the run has nothing live, which is when the graph fits whole.
 */
export function liveNodeId(steps: readonly WorkflowStep[]): string | undefined {
  let live: WorkflowStep | undefined;
  for (const step of steps) {
    if (IS_LIVE_STATUS[step.status] && isLaterStep(step, live)) {
      live = step;
    }
  }
  return live?.nodeId;
}

/**
 * The edges a run is flowing through: each edge into a node whose latest step is running, from
 * a node that step's recorded sources name, so a join fed by one branch flows only on that one.
 */
export function flowingEdgeIds(
  document: WorkflowDocument,
  steps: readonly WorkflowStep[],
): ReadonlySet<string> {
  const sourcesByRunningNode = new Map<string, ReadonlySet<string>>();
  for (const step of latestStepByNode(steps).values()) {
    if (step.status === "running") {
      const sourceNodeIds = step.source.flatMap((source) => (source === null ? [] : source.nodeId));
      sourcesByRunningNode.set(step.nodeId, new Set(sourceNodeIds));
    }
  }
  return new Set(
    document.edges
      .filter((edge) => sourcesByRunningNode.get(edge.target)?.has(edge.source) === true)
      .map((edge) => edge.id),
  );
}

function latestStepByNode(steps: readonly WorkflowStep[]): Map<string, WorkflowStep> {
  const latest = new Map<string, WorkflowStep>();
  for (const step of steps) {
    if (isLaterStep(step, latest.get(step.nodeId))) {
      latest.set(step.nodeId, step);
    }
  }
  return latest;
}

/**
 * Each node's first-output count, read off an edge leaving its first output handle: every edge
 * off one handle carries the same count, summed over every pass, and an edge nothing went
 * through carries 0, as the edge itself reads.
 */
function firstOutputItemCounts(
  document: WorkflowDocument,
  edgeItemCounts: readonly WorkflowEdgeItemCount[],
): ReadonlyMap<string, number> {
  const countByEdge = new Map(edgeItemCounts.map((entry) => [entry.edgeId, entry.itemCount]));
  const counts = new Map<string, number>();
  for (const edge of document.edges) {
    if (edge.sourceHandle === FIRST_OUTPUT_HANDLE) {
      counts.set(edge.source, countByEdge.get(edge.id) ?? 0);
    }
  }
  return counts;
}

function nodeView(
  node: WorkflowNode,
  step: WorkflowStep | undefined,
  firstOutputEdgeCount: number | undefined,
  nowMs: number,
): RunGraphNodeView {
  const status = step?.status ?? "pending";
  const waitCause = status === "waiting" ? step?.waitCause : undefined;
  const resumeAt = status === "waiting" ? step?.resumeAt : undefined;
  const resumeLine =
    resumeAt === undefined ? undefined : `Resumes at ${formatDayClock(resumeAt, nowMs)}`;
  const stateWords =
    waitCause === undefined
      ? STEP_STATUS_WORDS[status]
      : `${STEP_STATUS_WORDS[status]} on ${WAIT_CAUSE_WORDS[waitCause]}`;
  const isDisabled = node.disabled === true;
  const attemptWords =
    step === undefined || step.attempt === 1 ? undefined : `Attempt ${formatCount(step.attempt)}`;
  const outputCount = step === undefined ? undefined : ownOutputCount(step, firstOutputEdgeCount);
  const errorLine = status === "failed" ? failureLine(step) : undefined;
  return {
    node,
    status,
    waitCause,
    isWaitingOnPerson: isPersonWaitCause(waitCause),
    isDisabled,
    attemptWords,
    outputCount,
    errorLine,
    resumeLine,
    stateWords,
    accessibleName: [
      node.name,
      isDisabled ? "Disabled" : undefined,
      stateWords,
      attemptWords,
      outputCount === undefined ? undefined : itemCountWords(outputCount),
      errorLine,
      resumeLine,
    ]
      .filter(isPresent)
      .join(" · "),
  };
}

/**
 * The count of a step that ran through: its first output's edge count where an edge leaves
 * that handle, else the count its output holds, inline or as an artifact.
 */
function ownOutputCount(
  step: WorkflowStep,
  firstOutputEdgeCount: number | undefined,
): number | undefined {
  if (!HAS_OWN_OUTPUT[step.status]) {
    return undefined;
  }
  if (firstOutputEdgeCount !== undefined) {
    return firstOutputEdgeCount;
  }
  return step.outputRef.kind === "inline" ? step.outputRef.items.length : step.outputRef.itemCount;
}

/**
 * The failing item, numbered from 0 as `$itemIndex` and the payload table number it, then the
 * error's first line.
 */
function failureLine(step: WorkflowStep | undefined): string | undefined {
  const itemIndex = step?.error?.itemIndex;
  const parts = [
    itemIndex === undefined ? undefined : `Item ${formatCount(itemIndex)}`,
    firstLine(step?.error?.message),
  ].filter(isPresent);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function isPresent(part: string | undefined): part is string {
  return part !== undefined;
}

function firstLine(message: string | undefined): string | undefined {
  const line = message?.split("\n", 1)[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
}

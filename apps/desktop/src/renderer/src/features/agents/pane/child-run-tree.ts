// The session's child runs laid out as one tree in the order the work happened: each child under
// the run or helper that dispatched it, at its depth. A child whose parent is not in the tree, such
// as one a lead run dispatched, is a root. Each child has exactly one parent, so walking down from
// the roots never meets a cycle.

import type { ChildRunLink } from "@ai-sidekicks/contracts/orchestration";
import { RUN_TERMINAL_STATES, type RunState } from "@ai-sidekicks/contracts/run/state";

/** One child as the tree draws it: the link, its stable key and how deep it sits. */
export interface ChildRunTreeRow {
  readonly key: string;
  readonly link: ChildRunLink;
  /** 0 for a root, one more for each ancestor in the tree. */
  readonly depth: number;
}

/** The children in tree order, each after its parent and its parent's earlier children. */
export function childRunTreeRows(children: readonly ChildRunLink[]): readonly ChildRunTreeRow[] {
  const keys = new Set(children.map(keyOf));
  const childrenByParentKey = new Map<string, ChildRunLink[]>();
  const roots: ChildRunLink[] = [];
  for (const child of children) {
    const parentKey = parentKeyOf(child);
    if (!keys.has(parentKey)) {
      roots.push(child);
      continue;
    }
    const siblings = childrenByParentKey.get(parentKey) ?? [];
    siblings.push(child);
    childrenByParentKey.set(parentKey, siblings);
  }
  const rows: ChildRunTreeRow[] = [];
  const visit = (link: ChildRunLink, depth: number): void => {
    const key = keyOf(link);
    rows.push({ key, link, depth });
    for (const child of childrenByParentKey.get(key) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  return rows;
}

/** Whether a child in this state has finished, so its row dims where it stands. */
export function isChildRunSettled(state: RunState): boolean {
  return SETTLED_STATES.has(state);
}

const SETTLED_STATES: ReadonlySet<RunState> = new Set<RunState>(RUN_TERMINAL_STATES);

/** A run child by its run; a provider's helper by its run and handle, unique only within it. */
function keyOf(link: ChildRunLink): string {
  return link.kind === "run" ? runKey(link.childRunId) : helperKey(link.runId, link.childHandle);
}

/** The key of the run or helper that dispatched this child. */
function parentKeyOf(link: ChildRunLink): string {
  if (link.kind === "run") {
    return runKey(link.parentRunId);
  }
  return link.parentChildHandle === undefined
    ? runKey(link.runId)
    : helperKey(link.runId, link.parentChildHandle);
}

function runKey(runId: string): string {
  return `run:${runId}`;
}

function helperKey(runId: string, childHandle: string): string {
  return `helper:${runId}:${childHandle}`;
}

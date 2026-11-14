// Where a generated contract check found its fault, in the wire's issue path: the check names the
// place as a JSON pointer, and an issue names it step by step, an array's index as a number.

import {
  ISSUE_PATH_SEGMENTS_MAX,
  type IssuePathSegment,
} from "@ai-sidekicks/contracts/jsonrpc/issue";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";

/**
 * The issue path of each fault `check` left when it last refused `value`. Read it right after that
 * call: the check keeps only its newest refusal's faults.
 */
export function checkFaultPaths(
  check: SchemaCheck<unknown>,
  value: unknown,
): { readonly path: IssuePathSegment[] }[] {
  return (check.errors ?? []).map((fault) => ({ path: issuePathOf(fault.instancePath, value) }));
}

// The issue path of a check's JSON-pointer `instancePath` into `value`: an array's index as a
// number, a member's name as text, at most the issue path's step limit.
function issuePathOf(instancePath: string, value: unknown): IssuePathSegment[] {
  const path: IssuePathSegment[] = [];
  let step = value;
  for (const pointerStep of instancePath.split("/").slice(1, ISSUE_PATH_SEGMENTS_MAX + 1)) {
    const key = pointerStep.replaceAll("~1", "/").replaceAll("~0", "~");
    const segment: IssuePathSegment = Array.isArray(step) ? Number(key) : key;
    path.push(segment);
    step = step !== null && typeof step === "object" ? Reflect.get(step, segment) : undefined;
  }
  return path;
}

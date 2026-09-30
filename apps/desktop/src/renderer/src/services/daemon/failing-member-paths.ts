// The refusal sentence's one clause about which members failed. It obeys the rule in
// `daemon-reply.ts` that no refused value reaches a detail sentence: this is the one reading of a
// validator's error object.

import { lossyStringify, readGuardedProperty } from "@renderer/lib/wire-errors.js";

/** How many failing member paths a refusal sentence names before it stops. */
const NAMED_FAILING_PATH_CAP = 3;

/**
 * Name the members that failed, without naming what was in them. The validator's own message
 * interpolates the rejected values, which may be user content, so only paths are rendered.
 *
 * Takes `unknown` because the validator is not imported above the bridge, and is total: reads go
 * through `readGuardedProperty` and segments through `lossyStringify`, so a null, a throwing
 * getter or a null-prototype segment yields no clause instead of a throw. Exported for
 * `callDaemon` only, so no view composes a second refusal sentence.
 */
export function describeFailingPaths(error: unknown): string {
  const issues = readGuardedProperty(error, "issues");
  if (!Array.isArray(issues)) {
    return "";
  }
  const paths = [
    ...new Set(
      issues
        .map((issue: unknown) => {
          const path = readGuardedProperty(issue, "path");
          return Array.isArray(path) && path.length > 0
            ? path.map((segment: unknown) => lossyStringify(segment)).join(".")
            : undefined;
        })
        .filter((path): path is string => path !== undefined),
    ),
  ];
  if (paths.length === 0) {
    return "";
  }
  const named = paths.slice(0, NAMED_FAILING_PATH_CAP).join(", ");
  return paths.length > NAMED_FAILING_PATH_CAP ? ` (at ${named}, and more)` : ` (at ${named})`;
}

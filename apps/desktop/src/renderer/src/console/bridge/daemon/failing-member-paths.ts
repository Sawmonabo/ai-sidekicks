// The refusal sentence's one clause about WHICH members failed.
//
// SPLIT FROM `daemon-reply.ts`, whose header owns the rule this obeys: no refused
// value ever reaches a detail sentence. That module is the call door and this is the
// one reading it takes of a validator's error object — a different job with a
// different hazard, and together they were one file past the package's ceiling.

import { lossyStringify, readGuardedProperty } from "../../../../../shared/wire-errors.js";

/**
 * How many failing member paths a refusal sentence names before it stops.
 *
 * A bound rather than the whole list: a response that is wrong in forty places is
 * wrong in one way, and forty paths in a sentence is not a sentence. Three is
 * enough to tell a reader which part of the reply moved.
 */
const NAMED_FAILING_PATH_CAP = 3;

/**
 * Name the members that failed, without naming what was in them.
 *
 * PATHS ONLY. A path is a member name the contract itself publishes; the value at
 * that path is whatever the wire or the caller supplied, which may be participant
 * content. The validator's own message interpolates those values, which is why it
 * is never rendered.
 *
 * Takes `unknown` because that is honestly what a caller of this module knows about
 * a validator's error object: the registry types its schemas through the contracts
 * package's re-exported `ZodType` so that nothing above the bridge imports the
 * validator, and the same reason applies to its errors. A shape this cannot read
 * yields no clause rather than a wrong one.
 *
 * TOTAL, because that sentence is a claim and not a hope. A cast to
 * `{ issues?: unknown }` reads a property, a property read runs a getter, and both
 * `null` and `undefined` throw a `TypeError` on the way in — from inside the one
 * module that answers for a value nobody validated. Every read here therefore goes
 * through `readGuardedProperty`, which collapses absent and unreadable to the same
 * `undefined`, and every path segment through the family's total stringifier rather
 * than bare `String(...)`, which runs ToPrimitive and throws on a null-prototype
 * segment. Both are cheap on a path that only runs once something has already failed.
 *
 * Exported for the call door and for its co-located test, and for nothing else:
 * `bridge/index.ts` deliberately publishes neither this nor the registry behind it.
 * A surface that could reach a reading of a validator's error would be a surface
 * that could compose a second refusal sentence.
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

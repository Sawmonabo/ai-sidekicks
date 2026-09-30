/**
 * Compares the permission posture a session was started with against the one a resume asks for,
 * and digests the output schema so a change is noticed.
 */

import { type ExecutionPosture } from "@ai-sidekicks/contracts";
import { createHash } from "node:crypto";

// The `ExecutionPosture` axes a spawn realizes, in mismatch-report order; `startRun` refuses a run
// differing on any (see `#assertSpawnBoundRealization`). Enumerated from the contract type, not
// sampled: a skipped axis would admit a run into a process whose sandbox differs from its posture.
// Set axes compare order-insensitively, scalars strictly.
const CLAUDE_POSTURE_SCALAR_AXES = [
  "mode",
  "networkAccess",
  "credentialPolicyRef",
  "profileName",
] as const;

const CLAUDE_POSTURE_SET_AXES = ["allowedDomains", "writableRoots"] as const;

type ClaudePostureScalarAxis = (typeof CLAUDE_POSTURE_SCALAR_AXES)[number];

type ClaudePostureSetAxis = (typeof CLAUDE_POSTURE_SET_AXES)[number];

function readPostureScalarAxis(
  posture: ExecutionPosture,
  axis: ClaudePostureScalarAxis,
): string | undefined {
  // Read through the widened view: `credentialPolicyRef` is `never` on `trusted`, and
  // `profileName` is optional.
  const widened = posture as Partial<Record<ClaudePostureScalarAxis, string>>;
  return widened[axis];
}

function readPostureSetAxis(
  posture: ExecutionPosture,
  axis: ClaudePostureSetAxis,
): readonly string[] | undefined {
  const widened = posture as Partial<Record<ClaudePostureSetAxis, readonly string[]>>;
  return widened[axis];
}

// Order-insensitive but multiplicity-sensitive: a duplicated root is a different declaration.
function postureSetAxisDiffers(
  runValue: readonly string[] | undefined,
  spawnValue: readonly string[] | undefined,
): boolean {
  if (runValue === undefined || spawnValue === undefined) {
    return runValue !== spawnValue;
  }
  if (runValue.length !== spawnValue.length) {
    return true;
  }
  const sortedRun = [...runValue].sort();
  const sortedSpawn = [...spawnValue].sort();
  return sortedRun.some((entry, index) => entry !== sortedSpawn[index]);
}

/**
 * Names the first posture axis on which a run differs from its session's spawn posture, or
 * undefined when none does.
 */
export function findPostureDivergence(
  runPosture: ExecutionPosture,
  spawnPosture: ExecutionPosture,
): string | undefined {
  for (const axis of CLAUDE_POSTURE_SCALAR_AXES) {
    const runValue = readPostureScalarAxis(runPosture, axis);
    const spawnValue = readPostureScalarAxis(spawnPosture, axis);
    if (runValue !== spawnValue) {
      return `${axis} (run ${String(runValue)}, session ${String(spawnValue)})`;
    }
  }
  for (const axis of CLAUDE_POSTURE_SET_AXES) {
    const runValue = readPostureSetAxis(runPosture, axis);
    const spawnValue = readPostureSetAxis(spawnPosture, axis);
    if (postureSetAxisDiffers(runValue, spawnValue)) {
      return `${axis} (run ${JSON.stringify(runValue)}, session ${JSON.stringify(spawnValue)})`;
    }
  }
  return undefined;
}

// Stable serialization: keys sorted recursively, array order kept (it is meaningful in JSON
// Schema, e.g. `prefixItems`). `undefined` keys are dropped, as `JSON.stringify` drops them.
function canonicalizeJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    // Code-unit order, not `localeCompare`: the digest must not depend on the host locale.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJsonValue(entryValue)}`)
    .join(",")}}`;
}

/**
 * A boolean "is one bound?" would admit a run with schema B into a process spawned with schema A.
 */
export function digestOutputSchema(outputSchema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJsonValue(outputSchema)).digest("hex");
}

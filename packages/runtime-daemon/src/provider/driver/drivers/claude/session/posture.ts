/**
 * Compares the permission posture a session was started with against the one a resume asks for,
 * and digests the output schema so a change is noticed.
 */

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/driver";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../../../../events/canonicalizer.js";

// The `ExecutionPosture` axes a spawn realizes, in mismatch-report order; `startRun` refuses a run
// differing on any (see `assertClaudeSpawnBoundRealization`). Enumerated from the contract type,
// not sampled: a skipped axis would admit a run into a process whose sandbox differs from its
// posture. Set axes compare order-insensitively, scalars strictly.
const CLAUDE_POSTURE_SCALAR_AXES = ["mode", "credentialPolicyRef"] as const;

const CLAUDE_POSTURE_SET_AXES = ["writableRoots"] as const;

type ClaudePostureScalarAxis = (typeof CLAUDE_POSTURE_SCALAR_AXES)[number];

function readPostureScalarAxis(
  posture: ExecutionPosture,
  axis: ClaudePostureScalarAxis,
): string | undefined {
  return posture[axis];
}

// Order-insensitive but multiplicity-sensitive: a duplicated root is a different declaration.
function postureSetAxisDiffers(
  runValue: readonly string[],
  spawnValue: readonly string[],
): boolean {
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
    const runValue = runPosture[axis];
    const spawnValue = spawnPosture[axis];
    if (postureSetAxisDiffers(runValue, spawnValue)) {
      return `${axis} (run ${JSON.stringify(runValue)}, session ${JSON.stringify(spawnValue)})`;
    }
  }
  return undefined;
}

/**
 * The SHA-256 of an output schema's canonical JSON bytes: key order does not change it, array order
 * does (it is meaningful in JSON Schema, e.g. `prefixItems`). Throws when the schema has no
 * canonical form. A digest, not a boolean "is one bound?", so a run with schema B is never admitted
 * into a process spawned with schema A.
 */
export function digestOutputSchema(outputSchema: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJson(outputSchema)).digest("hex");
}

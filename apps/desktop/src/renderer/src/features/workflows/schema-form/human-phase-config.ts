// What a `human` phase's config says, read off an untyped record: the prompt and the input
// schema, each absent where it is not what it should be. Deadline, claim and revision are the
// run's facts, not the definition's, so they are not read here.

import type { WorkflowPhaseDefinition } from "@renderer/services/wire-shapes/workflow-definition-body.js";

/** What a human phase asks, as its definition declares it. */
export interface HumanPhaseFormConfig {
  /** The question, as the author wrote it. Absent where the definition carries none. */
  readonly prompt: string | undefined;
  /** The schema the answer is shaped by, left `unknown`: the mapper decides what a schema is. */
  readonly inputSchema: unknown;
}

/** The phase type whose config carries a form. */
const HUMAN_PHASE_TYPE = "human";

/**
 * Read one phase's form config. `undefined` covers both a non-human phase and a human phase
 * with no schema, since the mount renders nothing for either.
 */
export function humanPhaseFormConfigOf(
  phase: WorkflowPhaseDefinition,
): HumanPhaseFormConfig | undefined {
  if (phase.type !== HUMAN_PHASE_TYPE) {
    return undefined;
  }
  const config = phase.config;
  if (config === undefined || config["inputSchema"] === undefined) {
    return undefined;
  }
  return {
    prompt: typeof config["prompt"] === "string" ? config["prompt"] : undefined,
    inputSchema: config["inputSchema"],
  };
}

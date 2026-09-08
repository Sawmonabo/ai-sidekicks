// What a `human` phase's config says, read off a record nothing has typed.
//
// THE CONFIG IS UNTYPED ON THE WIRE. A phase definition carries `config` as an open
// record — the definition body declares no shape for it, because the shape differs by
// phase type — so a reader has to probe rather than cast. Every member below is absent
// where it is not a string, which is the same answer as absent: neither reads as a value.
//
// TWO MEMBERS AND NO OTHERS. The prompt is what the phase asks; the input schema is what
// it asks for. The deadline posture, the claim state and the revision token are the RUN's
// facts rather than the definition's, and a reader of a definition has none of them — so
// this module names none of them either, rather than reading absence as a default.
//
// A PHASE THAT IS NOT `human` HAS NO FORM CONFIG, and the caller asks before it reads:
// this module answers what a record holds and takes no view on whether the phase should
// have held it.

import type { WorkflowPhaseDefinition } from "../../bridge/index.js";

/** What a human phase asks, as its definition declares it. */
export interface HumanPhaseFormConfig {
  /** The question, as the author wrote it. Absent where the definition carries none. */
  readonly prompt: string | undefined;
  /**
   * The schema the answer is shaped by, untyped on purpose.
   *
   * Handed to the mapper as `unknown` rather than narrowed here, because the mapper's
   * whole job is to decide what a schema is and its fallback is what covers everything
   * it is not. A narrowing here would be that decision made twice, in two places, with
   * only one of them able to say why it went the way it did.
   */
  readonly inputSchema: unknown;
}

/** The phase type whose config carries a form. */
const HUMAN_PHASE_TYPE = "human";

/**
 * Read one phase's form config, or nothing where this phase has no form.
 *
 * `undefined` covers two cases on purpose — a phase that is not a human phase, and a
 * human phase whose definition declared no schema — because a surface renders nothing for
 * both, and a second discriminator would be a distinction nothing acts on.
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

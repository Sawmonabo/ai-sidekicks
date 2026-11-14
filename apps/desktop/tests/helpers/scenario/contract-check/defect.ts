// What a scenario contract defect is, and the fault formatter its reasons are built from.
//
// A leaf: the aggregate entry answers in this shape and three axis modules construct one, so
// declaring it in any of them would make the others import a sibling for a type, and declaring it
// in the entry would close a cycle. The formatter is here so every leg reporting a check's refusal
// shares one spelling of "where the fault is, and which rule it breaks".

import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";

/**
 * One way a scenario contradicts the shipped wire contract.
 *
 * A list of these rather than a thrown error, so one run reports every defect in every scenario.
 */
export interface ScenarioContractDefect {
  readonly scenarioId: string;
  /** The beat or reply at fault, in the form a failure message prints. */
  readonly subject: string;
  /** What is wrong, and what would make it right. */
  readonly reason: string;
}

/**
 * The faults `check` left when it last refused a value, as one sentence fragment: each fault's
 * place, as a JSON pointer such as `/payload/runVersion` or `(root)` for the whole value, and the
 * rule it breaks. Read it right after that call: the check keeps only its newest refusal's faults.
 */
export function describeCheckFaults(check: SchemaCheck<unknown>): string {
  return (check.errors ?? [])
    .map((fault) => `${fault.instancePath || "(root)"}: breaks the "${fault.keyword}" rule`)
    .join("; ");
}

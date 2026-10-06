// Matching a typed definition name against the enumeration, and offering candidates. The match is
// exact and case-insensitive with no prefix arm: a run is not undoable by typing more, so
// `deploy` must never start `deploy-production`. Case is folded because a name is a label, not a
// wire identifier. Candidates are a prefix reading, since an unfinished word is a prefix.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";

/** What resolving a typed name against the enumeration answered. */
export type WorkflowDefinitionMatch =
  | { readonly status: "matched"; readonly definition: WorkflowDefinitionSummary }
  | { readonly status: "none" }
  | { readonly status: "ambiguous"; readonly count: number };

/**
 * Match one typed name against the saved workflows. A name is held once, but two names that differ
 * only in case fold together, so that typed name is ambiguous.
 */
export function matchWorkflowDefinition(
  definitions: readonly WorkflowDefinitionSummary[],
  typedName: string,
): WorkflowDefinitionMatch {
  const wanted = foldName(typedName);
  const matches = definitions.filter((definition) => foldName(definition.name) === wanted);
  const [only] = matches;
  if (only === undefined) {
    return { status: "none" };
  }
  return matches.length === 1
    ? { status: "matched", definition: only }
    : { status: "ambiguous", count: matches.length };
}

/**
 * The definitions a partially typed name could still become; an empty prefix offers all.
 *
 * @consumedBy the definitions a `/workflow start` name autocompletes over
 */
export function workflowDefinitionCandidates(
  definitions: readonly WorkflowDefinitionSummary[],
  typedPrefix: string | undefined,
): readonly WorkflowDefinitionSummary[] {
  const wanted = typedPrefix === undefined ? "" : foldName(typedPrefix);
  return definitions.filter((definition) => foldName(definition.name).startsWith(wanted));
}

/** One name, folded the one way this module compares names. */
function foldName(name: string): string {
  return name.toLocaleLowerCase();
}

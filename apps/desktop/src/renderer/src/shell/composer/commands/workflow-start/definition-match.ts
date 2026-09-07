// Matching a typed definition name against the enumeration, and offering candidates.
//
// THE MATCH IS EXACT AND CASE-INSENSITIVE, WITH NO PREFIX ARM. A prefix match would
// start `deploy-production` for somebody who typed `deploy`, which is the one mistake
// an accelerator must not make: a run is not a search result, and the act is not
// undoable by typing more. Case is folded because a definition name is a person's
// label rather than a wire identifier, and refusing on capitalisation would be
// refusing a name they read correctly.
//
// CANDIDATES ARE A DIFFERENT QUESTION AND SO A DIFFERENT FUNCTION. What a person is
// still typing is a prefix by definition, and a list offered against it is a list —
// nothing starts from it without the exact name landing on the line first. Both
// readings fold case the same way and both are here, so the surface that offers a
// candidate and the path that starts it cannot come apart on what a name matches.

import type { WorkflowDefinitionSummary } from "../../../../console/bridge/index.js";

/** What resolving a typed name against the enumeration answered. */
export type WorkflowDefinitionMatch =
  | { readonly status: "matched"; readonly definition: WorkflowDefinitionSummary }
  | { readonly status: "none" }
  | { readonly status: "ambiguous"; readonly count: number };

/**
 * Match one typed name against the definitions a session can start.
 *
 * Exported beside the dispatch because it is the whole of the naming rule, and a case
 * that drove it through a growth port would be asserting the rule and the transport
 * at once.
 */
export function matchWorkflowDefinition(
  definitions: readonly WorkflowDefinitionSummary[],
  typedName: string,
): WorkflowDefinitionMatch {
  const wanted = foldName(typedName);
  const matches = definitions.filter((definition) => foldName(definition.name) === wanted);
  // `resolvesAtThisContext` is the enumeration's own answer to which entry a start
  // would pick when one name is defined at several scopes, so the narrowing is the
  // wire's rather than a scope order this module would have to keep in step.
  const resolved = matches.filter((definition) => definition.resolvesAtThisContext);
  const candidates = resolved.length > 0 ? resolved : matches;
  const [only] = candidates;
  if (only === undefined) {
    return { status: "none" };
  }
  return candidates.length === 1
    ? { status: "matched", definition: only }
    : { status: "ambiguous", count: candidates.length };
}

/**
 * The definitions a partially typed name could still become.
 *
 * A prefix reading, which is what an unfinished word is. The empty prefix offers
 * everything, because a person who has typed the verb and nothing else is asking what
 * there is — the same question the plus menu's picker answers, reached from the line.
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

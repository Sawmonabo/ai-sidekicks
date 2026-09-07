// The one command root the composer registers for workflows, and how its line reads.
//
// `Spec-017 §Chat-start surface (SA-38)` states the surface exactly: "The session
// composer registers exactly one command root, `workflow`, with exactly one V1 verb,
// `start`: `/workflow start <name>`." The root is what the recogniser matches and the
// palette lists; the verb and the definition name that follows it are this module's
// grammar and nobody else's.
//
// WHY THE ROOT IS THE REGISTERED ID AND THE VERB IS NOT PART OF IT. The composer
// splits a directive line at the first run of whitespace and hands the recogniser the
// FIRST WORD alone, so a registered id carrying a space is unreachable by
// construction. Registering `workflow.start` therefore made the documented form
// `/workflow start <name>` parse as the unregistered name `workflow` — a loud refusal
// for the one line the spec says must work — while the palette prefilled a dotted form
// the spec does not define. Taking the bare root is not a namespace spent on one verb:
// the spec says verb additions are additive-MINOR, so a second verb is a second word
// in THIS grammar rather than a second registered id.
//
// THE VERB SET IS CLOSED AND DECLARED ONCE. An unrecognised verb is its own reading
// rather than an absent name, because the two have different remedies: one is a
// spelling a person can fix and the other is a workflow that does not exist.

import { readDirectiveName } from "../../directive-syntax.js";

/** The console command id this family registers, recognises, and is listed under. */
export const WORKFLOW_COMMAND_ROOT = "workflow";

/**
 * Every verb the root takes at V1. One, and the spec says so.
 *
 * A tuple rather than a union so the vocabulary is declared once: a verb added here
 * reaches the reading below and the copy that names it as a compile-time fact.
 */
export const WORKFLOW_COMMAND_VERBS = ["start"] as const;

/** One such verb. Derived, so nothing restates the set. */
export type WorkflowCommandVerb = (typeof WORKFLOW_COMMAND_VERBS)[number];

/** What the palette entry types for somebody who found the command there. */
export const WORKFLOW_START_DIRECTIVE_PREFILL: string = `/${WORKFLOW_COMMAND_ROOT} ${WORKFLOW_COMMAND_VERBS[0]} `;

/**
 * What a line naming the workflow root reads as.
 *
 * Three arms and each is a different sentence: the line named no verb, it named one
 * this root does not take, or it named `start` — in which case the definition name is
 * whatever follows, which is `undefined` while nothing follows it yet.
 */
export type WorkflowCommandReading =
  | { readonly status: "start"; readonly definitionName: string | undefined }
  | { readonly status: "verb-missing" }
  | { readonly status: "verb-unknown"; readonly verb: string };

/**
 * Read one composer line as a workflow command, or answer `undefined` for any other.
 *
 * Takes the RAW line rather than a name and an argument, because both readers need
 * different halves of it: the directive handler wants the definition name a complete
 * line carries, and the discovery surface wants to know that the argument is being
 * typed while it still is. Splitting that into two parsers is how the surface offering
 * candidates and the path acting on them come to disagree about what a line says.
 *
 * The root is read through `directive-syntax.ts` rather than by a prefix test of this
 * module's own, so the line the popover opens on, the line the router intercepts, and
 * the line this grammar parses are one decision.
 */
export function readWorkflowCommandLine(lineText: string): WorkflowCommandReading | undefined {
  if (readDirectiveName(lineText) !== WORKFLOW_COMMAND_ROOT) {
    return undefined;
  }
  const afterRoot = lineText.slice(`/${WORKFLOW_COMMAND_ROOT}`.length).trimStart();
  if (afterRoot.length === 0) {
    return { status: "verb-missing" };
  }
  const firstSpace = afterRoot.search(/\s/u);
  const verb = firstSpace === -1 ? afterRoot : afterRoot.slice(0, firstSpace);
  if (!isWorkflowCommandVerb(verb)) {
    return { status: "verb-unknown", verb };
  }
  const argument = firstSpace === -1 ? "" : afterRoot.slice(firstSpace).trim();
  return { status: "start", definitionName: argument.length === 0 ? undefined : argument };
}

/** The line a completed candidate puts on the composer, trailing space included. */
export function workflowStartLineFor(definitionName: string): string {
  return `${WORKFLOW_START_DIRECTIVE_PREFILL}${definitionName}`;
}

/** Whether one word is a verb this root takes. Narrows, so no caller re-tests it. */
function isWorkflowCommandVerb(verb: string): verb is WorkflowCommandVerb {
  return (WORKFLOW_COMMAND_VERBS as readonly string[]).includes(verb);
}

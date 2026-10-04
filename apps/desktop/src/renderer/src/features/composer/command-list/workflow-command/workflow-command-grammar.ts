// The one command root the composer registers for workflows, and how its line reads:
// `/workflow start <name>`. The recognizer is handed only the first word, so a registered id
// containing a space would be unreachable and `workflow.start` would parse the documented form as
// the unregistered name `workflow`. A second verb is a second word here, not a second id. An
// unrecognized verb is its own reading, never read as the name of a workflow.

import { readSlashCommandName, splitFirstWord } from "../../slash-command-syntax.js";

/** The console command id the workflow command is registered, recognized, and listed under. */
export const WORKFLOW_COMMAND_ROOT = "workflow";

/** Every verb the root takes. A tuple, so the vocabulary is declared once and reaches the copy. */
export const WORKFLOW_COMMAND_VERBS = ["start"] as const;

/** One such verb. Derived, so nothing restates the set. */
export type WorkflowCommandVerb = (typeof WORKFLOW_COMMAND_VERBS)[number];

/** What the palette entry types for somebody who found the command there. */
export const WORKFLOW_START_COMMAND_PREFILL: string =
  `/${WORKFLOW_COMMAND_ROOT} ` + `${WORKFLOW_COMMAND_VERBS[0]} `;

/** What a line naming the workflow root reads as: no verb, an unknown verb, or `start`. */
export type WorkflowCommandReading =
  | { readonly status: "start"; readonly definitionName: string | undefined }
  | { readonly status: "verb-missing" }
  | { readonly status: "verb-unknown"; readonly verb: string };

/**
 * Read one composer line as a workflow command, or answer `undefined` for any other. Takes the
 * raw line because the handler wants the definition name of a complete line and the command list
 * wants to know an argument is still being typed. The root is read through
 * `slash-command-syntax.ts`, so the popover, router and this grammar agree on what a line says.
 */
export function readWorkflowCommandLine(lineText: string): WorkflowCommandReading | undefined {
  if (readSlashCommandName(lineText) !== WORKFLOW_COMMAND_ROOT) {
    return undefined;
  }
  const afterRoot = lineText.slice(`/${WORKFLOW_COMMAND_ROOT}`.length).trimStart();
  if (afterRoot.length === 0) {
    return { status: "verb-missing" };
  }
  const { word: verb, rest } = splitFirstWord(afterRoot);
  if (!isWorkflowCommandVerb(verb)) {
    return { status: "verb-unknown", verb };
  }
  const argument = rest.trim();
  return { status: "start", definitionName: argument.length === 0 ? undefined : argument };
}

/**
 * The line a completed candidate puts on the composer.
 *
 * @consumedBy the composer's workflow candidate list
 */
export function workflowStartLineFor(definitionName: string): string {
  return `${WORKFLOW_START_COMMAND_PREFILL}${definitionName}`;
}

/** Whether one word is a verb this root takes. Narrows, so no caller re-tests it. */
function isWorkflowCommandVerb(verb: string): verb is WorkflowCommandVerb {
  return (WORKFLOW_COMMAND_VERBS as readonly string[]).includes(verb);
}

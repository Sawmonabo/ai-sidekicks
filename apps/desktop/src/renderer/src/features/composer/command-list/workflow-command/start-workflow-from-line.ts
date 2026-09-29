// Starting a workflow from the line, by the name a person types.
//
// Somebody who knows the definition's name types it, and the run starts without a menu,
// a list, or a second click.
//
// WHICH IS WHY THE COMMAND REGISTRY IS NOT THE PATH THAT RUNS IT. A console command's
// `run()` takes nothing: the registry is keyed for a palette, where there is no line
// and no argument. So `hooks/useWorkflowStartHandlers.ts` hands the executor a
// DIRECTIVE-LINE HANDLER for the root id, and the executor prefers it over the
// registry's argument-free `invoke`.
//
// THE NAME IS RESOLVED AGAINST THE ENUMERATION AND NEVER GUESSED. `workflowRunStart`
// is keyed by `workflowVersionId`, which a person does not have and cannot type, so
// the accelerator reads the definitions this session can start — every page of them —
// and matches the typed name against them. Three answers, three different sentences:
// nothing matched, more than one matched, or exactly one did — and the pin it starts
// is that entry's own `latestWorkflowVersionId`, never a version this module chose.
//
// THE TWO CALLS ARE ARGUMENTS. This module holds the accelerator's logic and none of the
// wire: the caller supplies the call that reads a page of definitions and the call that
// starts a run.
//
// NOTHING HERE DECIDES WHETHER A START WOULD BE PERMITTED. That is the daemon's answer,
// and a renderer that pre-empted it would be projecting an eligibility it does not own.
// A call that rejects rejects the whole line; the caller that supplies the calls owns
// what a person is told.

import type { CommandOutcome, ComposerCommandLine } from "../../types.js";
import { clientCommandRefusal } from "../client-command-recognizer.js";
import {
  readWorkflowDefinitions,
  type ReadWorkflowDefinitionPage,
} from "./definition-enumeration.js";
import { matchWorkflowDefinition } from "./definition-match.js";
import {
  WORKFLOW_COMMAND_ROOT,
  WORKFLOW_COMMAND_VERBS,
  WORKFLOW_START_COMMAND_PREFILL,
  readWorkflowCommandLine,
} from "./workflow-command-grammar.js";

/** The pinned version a start is issued against, and the session it starts in. */
export interface WorkflowStartRequest {
  readonly workflowVersionId: string;
  readonly sessionId: string;
}

/** The two calls the accelerator makes, both supplied by the caller. */
export interface WorkflowStartOperations {
  readonly readDefinitionPage: ReadWorkflowDefinitionPage;
  /** Starts one run; resolves when the daemon has accepted it. */
  readonly startRun: (request: WorkflowStartRequest) => Promise<void>;
}

/** What the accelerator needs to start a run, all of it the composer's own. */
export interface WorkflowStartInput {
  readonly operations: WorkflowStartOperations;
  /** The session this composer is addressed within, or nothing where it has none. */
  readonly sessionId: string | undefined;
}

/**
 * Run the accelerator for one typed line.
 *
 * Two calls and one settlement. The refusals here name what the person typed,
 * because nothing was asked on those paths.
 */
export async function startWorkflowFromLine(
  line: ComposerCommandLine,
  input: WorkflowStartInput,
): Promise<CommandOutcome> {
  const reading = readWorkflowCommandLine(line.text);
  if (reading === undefined || reading.status === "verb-missing") {
    return refusedArgument(
      `${WORKFLOW_COMMAND_ROOT} needs a verb. Type ${WORKFLOW_START_COMMAND_PREFILL.trimEnd()} followed by the workflow's name.`,
    );
  }
  if (reading.status === "verb-unknown") {
    return refusedArgument(
      `${WORKFLOW_COMMAND_ROOT} takes ${WORKFLOW_COMMAND_VERBS.join(", ")} and nothing else, so ${reading.verb} was not run.`,
    );
  }
  const { definitionName } = reading;
  if (definitionName === undefined) {
    return refusedArgument(
      `${WORKFLOW_START_COMMAND_PREFILL.trimEnd()} starts a workflow by name, and this line named none. Type the definition's name after the command.`,
    );
  }
  const { sessionId } = input;
  if (sessionId === undefined) {
    return {
      status: "refused",
      refusal: clientCommandRefusal(
        "command-unavailable-here",
        `${WORKFLOW_START_COMMAND_PREFILL.trimEnd()} starts a workflow in a session, and this composer is not addressed within one.`,
      ),
    };
  }
  const listed = await readWorkflowDefinitions(input.operations.readDefinitionPage, sessionId);
  const match = matchWorkflowDefinition(listed.definitions, definitionName);
  if (match.status === "none") {
    return refusedArgument(`No workflow this session can start is named ${definitionName}.`);
  }
  if (match.status === "ambiguous") {
    return refusedArgument(
      `${String(match.count)} workflows this session can start are named ${definitionName}, so nothing was started.`,
    );
  }
  // The entry's own pin, never a version this module chose: a start is against a
  // pinned version, and the enumeration is what says which version a name is at.
  await input.operations.startRun({
    workflowVersionId: match.definition.latestWorkflowVersionId,
    sessionId,
  });
  return { status: "applied" };
}

/** A local refusal about what was typed. Nothing was asked on any of these paths. */
function refusedArgument(detail: string): CommandOutcome {
  return { status: "refused", refusal: clientCommandRefusal("command-argument-invalid", detail) };
}

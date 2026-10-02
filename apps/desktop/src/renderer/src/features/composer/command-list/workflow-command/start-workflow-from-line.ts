// Starting a workflow from the line by the name a person types. The registry's `run()` takes no
// argument, so `hooks/useWorkflowStartHandlers.ts` hands the executor a line handler for the root
// id, which it prefers over `invoke`. The name is matched against the whole enumeration, never
// guessed: `workflowRunStart` needs a `workflowVersionId` a person cannot type, and the start uses
// that entry's own `latestWorkflowVersionId`. Whether a start is permitted is the daemon's answer,
// not pre-empted here. The two calls are arguments; a call that rejects rejects the whole line.

import type { CommandOutcome, ComposerCommandLine } from "../../types.js";
import { consoleCommandRefusal } from "../console-command-recognizer.js";
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

/** The two calls the line handler makes, both supplied by the caller. */
export interface WorkflowStartOperations {
  readonly readDefinitionPage: ReadWorkflowDefinitionPage;
  /** Starts one run; resolves when the daemon has accepted it. */
  readonly startRun: (request: WorkflowStartRequest) => Promise<void>;
}

/** What the line handler needs to start a run, all of it the composer's own. */
export interface WorkflowStartInput {
  readonly operations: WorkflowStartOperations;
  /** The session this composer is addressed within, or nothing where it has none. */
  readonly sessionId: string | undefined;
}

/**
 * Start the run a typed `/workflow start <name>` names. The refusals here name what was typed,
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
      refusal: consoleCommandRefusal(
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
  // The entry's own pin: the enumeration says which version a name is at.
  await input.operations.startRun({
    workflowVersionId: match.definition.latestWorkflowVersionId,
    sessionId,
  });
  return { status: "applied" };
}

/** A local refusal about what was typed. Nothing was asked on any of these paths. */
function refusedArgument(detail: string): CommandOutcome {
  return { status: "refused", refusal: consoleCommandRefusal("command-argument-invalid", detail) };
}

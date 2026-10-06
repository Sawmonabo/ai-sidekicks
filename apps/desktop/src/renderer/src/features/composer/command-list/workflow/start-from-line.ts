// Starting a workflow from the line by the name a person types. The registry's `run()` takes no
// argument, so `hooks/useWorkflowStartHandlers.ts` hands the executor a line handler for the root
// id, which it prefers over `invoke`. The name is matched against the whole enumeration, never
// guessed: `workflowRunStart` needs a `workflowVersionId` a person cannot type, and the start uses
// that entry's own `latestWorkflowVersionId`. Whether a start is permitted is the daemon's answer,
// not pre-empted here. The two calls are arguments; a call that rejects rejects the whole line.

import type { CommandOutcome, ComposerCommandLine } from "../../types.js";
import {
  readWorkflowDefinitions,
  type ReadWorkflowDefinitionPage,
} from "./definition/enumeration.js";
import { matchWorkflowDefinition } from "./definition/match.js";
import { readWorkflowCommandLine } from "./grammar.js";

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
 * Start the run a typed `/workflow run <name>` names. A line it cannot act on (no verb, a verb
 * it does not take, no name, a name no workflow here carries, no session) starts nothing
 * and is sent as typed, so the provider answers it and the console adds nothing.
 */
export async function startWorkflowFromLine(
  line: ComposerCommandLine,
  input: WorkflowStartInput,
): Promise<CommandOutcome> {
  const reading = readWorkflowCommandLine(line.text);
  const { sessionId } = input;
  if (
    reading?.status !== "run" ||
    reading.definitionName === undefined ||
    sessionId === undefined
  ) {
    return { status: "send-as-typed" };
  }
  const listed = await readWorkflowDefinitions(input.operations.readDefinitionPage);
  const match = matchWorkflowDefinition(listed.definitions, reading.definitionName);
  if (match.status !== "matched") {
    return { status: "send-as-typed" };
  }
  // The entry's own pin: the enumeration says which version a name is at.
  await input.operations.startRun({
    workflowVersionId: match.definition.latestWorkflowVersionId,
    sessionId,
  });
  return { status: "applied" };
}

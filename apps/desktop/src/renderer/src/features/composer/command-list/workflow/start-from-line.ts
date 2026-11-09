// Starting a workflow from the line by the name a person types. The registry's `run()` takes no
// argument, so `hooks/useWorkflowStartHandlers.ts` hands the executor a line handler for the root
// id, which it prefers over `invoke`. The name is matched against the whole enumeration, never
// guessed: `workflow.run.start` needs a `workflowVersionId` a person cannot type, and the start
// uses that entry's own `latestWorkflowVersionId`. Each line is one start under its own fresh
// idempotency key, in the chat mode a run started from a conversation takes. Whether a start is
// permitted is the daemon's answer, not preempted here. The two calls are arguments; a call that
// rejects rejects the whole line.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionListCursor } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { WorkflowRunStartRequest } from "@ai-sidekicks/contracts/workflow/run/control";

import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { CommandOutcome, ComposerCommandLine } from "../../types.js";
import {
  readWorkflowDefinitions,
  type ReadWorkflowDefinitionPage,
} from "./definition/enumeration.js";
import { matchWorkflowDefinition } from "./definition/match.js";
import { readWorkflowCommandLine } from "./grammar.js";

/** The two calls the line handler makes, both supplied by the caller. */
export interface WorkflowStartOperations {
  readonly readDefinitionPage: ReadWorkflowDefinitionPage;
  /** Starts one run; resolves when the daemon has accepted it. */
  readonly startRun: (request: WorkflowRunStartRequest) => Promise<void>;
}

/** What the line handler needs to start a run, all of it the composer's own. */
export interface WorkflowStartInput {
  readonly operations: WorkflowStartOperations;
  /** The session this composer is addressed within, or nothing where it has none. */
  readonly sessionId: string | undefined;
}

/**
 * The two calls over the daemon: the definition list, page by page, and the product's one
 * `workflow.run.start` sender. A refused call rejects with the daemon's own refusal.
 */
export function workflowStartOperationsOver(bridge: PlatformBridge): WorkflowStartOperations {
  return {
    readDefinitionPage: async (request) => {
      const page = unwrapDaemonReply(
        await callDaemon(
          bridge,
          "workflow.definition.list",
          request.cursor === undefined
            ? {}
            : { cursor: heldIdAsWireId<WorkflowDefinitionListCursor>(request.cursor) },
        ),
      );
      return { definitions: page.definitions, nextCursor: page.nextCursor };
    },
    startRun: async (request) => {
      unwrapDaemonReply(await callDaemon(bridge, "workflow.run.start", request));
    },
  };
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
    clientIdempotencyKey: crypto.randomUUID(),
    workflowVersionId: match.definition.latestWorkflowVersionId,
    sessionId: heldIdAsWireId<SessionId>(sessionId),
    mode: "chat",
  });
  return { status: "applied" };
}

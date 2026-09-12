// Starting a workflow from the line, by the name a person can read off the picker.
//
// The plus menu's picker is the surface a person browses definitions in and it is
// another plan's to build. This is the accelerator beside it: somebody who already
// knows the definition's name types it, and the run starts without a menu, a list, or
// a second click. Both entry points reach the same two wires, so the accelerator is a
// shortcut through the picker's own act rather than a second way to start a run.
//
// WHICH IS WHY THE COMMAND REGISTRY IS NOT THE PATH THAT RUNS IT. A console command's
// `run()` takes nothing: the registry is keyed for a palette, where there is no line
// and no argument. So this module hands the executor a DIRECTIVE-LINE HANDLER for the
// root id, and the executor prefers it over the registry's argument-free `invoke`.
//
// THE NAME IS RESOLVED AGAINST THE ENUMERATION AND NEVER GUESSED. `workflowRunStart`
// is keyed by `workflowVersionId`, which a person does not have and cannot type, so
// the accelerator reads the definitions this session can start — every page of them —
// and matches the typed name against them. Three answers, three different sentences:
// nothing matched, more than one matched, or exactly one did — and the pin it starts
// is that entry's own `latestWorkflowVersionId`, never a version this module chose.
//
// THE ORIGINATING CHANNEL TRAVELS WITH THE START. A start issued from a channel carries
// the originating channel as an additive-optional `channelId` on
// `WorkflowRunStartRequest` — provenance and progress-surface binding only. The
// composer already knows which channel it is addressed within, so the field is read off
// that address and never composed here; the daemon validates the start before it binds
// a surface, and this module neither pre-empts nor re-derives that.
//
// EVERY DAEMON REFUSAL IS CARRIED VERBATIM. `workflow.start_denied` is the one this
// path exists to surface, and it reaches the composer as the port's own refusal with
// its own code and sentence. Nothing here re-words it, and nothing here decides in
// advance whether a start would be permitted — that is the daemon's answer, and a
// renderer that pre-empted it would be projecting an eligibility it does not own.

import { useMemo } from "react";

import { settleGrowthRead, type GrowthPort } from "../../../../console/bridge/index.js";
import type { CommandOutcome, DirectiveLine } from "../../router/command-executor.js";
import { clientCommandRefusal } from "../client-command-recognizer.js";
import type { DirectiveLineHandlers } from "../directive-line-handlers.js";
import { readWorkflowDefinitions } from "./definition-enumeration.js";
import { matchWorkflowDefinition } from "./definition-match.js";
import {
  WORKFLOW_COMMAND_ROOT,
  WORKFLOW_COMMAND_VERBS,
  WORKFLOW_START_DIRECTIVE_PREFILL,
  readWorkflowCommandLine,
} from "./grammar.js";

/** What the accelerator needs to start a run, all of it the composer's own. */
export interface WorkflowStartInput {
  readonly growth: GrowthPort;
  /** The session this composer is addressed within, or nothing where it has none. */
  readonly sessionId: string | undefined;
  /**
   * The channel this composer is addressed within, where it is addressed at one.
   *
   * Wire-verbatim and passed through: a start from a channel is chat-borne and says
   * so, and a start from anywhere else carries no channel rather than a guessed one.
   */
  readonly channelId: string | undefined;
}

/**
 * Run the accelerator for one typed line.
 *
 * Two calls and one settlement. A refusal from either call is carried with its own
 * code and sentence — `workflow.start_denied` among them — and the local refusals
 * name what the person typed rather than what the daemon said, because nothing was
 * asked on those paths.
 */
export async function startWorkflowFromLine(
  line: DirectiveLine,
  input: WorkflowStartInput,
): Promise<CommandOutcome> {
  const reading = readWorkflowCommandLine(line.text);
  if (reading === undefined || reading.status === "verb-missing") {
    return refusedArgument(
      `${WORKFLOW_COMMAND_ROOT} needs a verb. Type ${WORKFLOW_START_DIRECTIVE_PREFILL.trimEnd()} followed by the workflow's name.`,
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
      `${WORKFLOW_START_DIRECTIVE_PREFILL.trimEnd()} starts a workflow by name, and this line named none. Type the definition's name after the command.`,
    );
  }
  const { sessionId } = input;
  if (sessionId === undefined) {
    return {
      status: "refused",
      refusal: clientCommandRefusal(
        "command-unavailable-here",
        `${WORKFLOW_START_DIRECTIVE_PREFILL.trimEnd()} starts a workflow in a session, and this composer is not addressed within one.`,
      ),
    };
  }
  const listed = await readWorkflowDefinitions(input.growth, sessionId);
  if (listed.status === "refused") {
    return { status: "refused", refusal: listed.refusal };
  }
  const match = matchWorkflowDefinition(listed.definitions, definitionName);
  if (match.status === "none") {
    return refusedArgument(
      `No workflow this session can start is named ${definitionName}. The plus menu lists the ones it can.`,
    );
  }
  if (match.status === "ambiguous") {
    return refusedArgument(
      `${String(match.count)} workflows this session can start are named ${definitionName}, so nothing was started. Start it from the plus menu, which names the scope each one comes from.`,
    );
  }
  const started = await settleGrowthRead(
    input.growth.workflowRunStart({
      // The entry's own pin, never a version this module chose: a start is against a
      // pinned version, and the enumeration is what says which version a name is at.
      workflowVersionId: match.definition.latestWorkflowVersionId,
      sessionId,
      ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    }),
  );
  // Carried whole. `workflow.start_denied` arrives here as the daemon's own refusal,
  // and the composer renders it beside the line exactly as it renders every other one.
  return started.status === "served"
    ? { status: "applied" }
    : { status: "refused", refusal: started };
}

/**
 * The directive-line handler this composer's executor prefers over `invoke`.
 *
 * Keyed by the ROOT id, which is the id the recogniser claims and the palette lists,
 * so the map cannot claim a name the console has never heard of.
 */
export function useWorkflowStartHandlers(input: WorkflowStartInput): DirectiveLineHandlers {
  const { growth, sessionId, channelId } = input;
  return useMemo(
    () =>
      new Map([
        [
          WORKFLOW_COMMAND_ROOT,
          (line: DirectiveLine) => startWorkflowFromLine(line, { growth, sessionId, channelId }),
        ],
      ]),
    [growth, sessionId, channelId],
  );
}

/** A local refusal about what was typed. Nothing was asked on any of these paths. */
function refusedArgument(detail: string): CommandOutcome {
  return { status: "refused", refusal: clientCommandRefusal("command-argument-invalid", detail) };
}

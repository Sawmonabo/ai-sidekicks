// Starting a workflow from the line, by the name a person can read off the picker.
//
// The plus menu's picker is the surface a person browses definitions in and it is
// another plan's to build. This is the accelerator beside it: somebody who already
// knows the definition's name types it, and the run starts without a menu, a list, or
// a second click. Both entry points reach the same two wires, so the accelerator is a
// shortcut through the picker's own act rather than a second way to start a run.
//
// THE NAME IS THE COMMAND ID, EXACTLY, AND THE ARGUMENT FOLLOWS IT.
// `client-command-recognizer.ts` matches a typed `/name` against the console's
// registered command ids and its header forbids a friendlier alias vocabulary resolved
// at the composer — so the line is `/workflow.start <definition name>` and never
// `/workflow start <name>`, which would be an alias only this surface knew. What
// follows the id is this command's own argument, read here and nowhere else.
//
// WHICH IS WHY THE COMMAND REGISTRY IS NOT THE PATH THAT RUNS IT. A console command's
// `run()` takes nothing: the registry is keyed for a palette, where there is no line
// and no argument. So this module hands the executor a DIRECTIVE-LINE HANDLER for its
// own id, and the executor prefers it over the registry's argument-free `invoke` —
// which leaves the palette entry a real act of its own rather than a dead twin: it
// puts the directive on the line and asks for the caret, so somebody who found the
// command in the palette lands in the composer with the syntax already typed.
//
// THE NAME IS RESOLVED AGAINST THE ENUMERATION AND NEVER GUESSED. `workflowRunStart`
// is keyed by `workflowVersionId`, which a person does not have and cannot type, so
// the accelerator reads the definitions this session can start and matches the typed
// name against them. Three answers, three different sentences: nothing matched, more
// than one matched, or exactly one did — and the pin it starts is that entry's own
// `latestWorkflowVersionId`, never a version this module chose.
//
// AND THE MATCH IS EXACT AND CASE-INSENSITIVE, WITH NO PREFIX ARM. A prefix match
// would start `deploy-production` for somebody who typed `deploy`, which is the one
// mistake an accelerator must not make: a run is not a search result, and the act is
// not undoable by typing more. Case is folded because a definition name is a person's
// label rather than a wire identifier, and refusing on capitalisation would be
// refusing a name they read correctly.
//
// EVERY DAEMON REFUSAL IS CARRIED VERBATIM. `workflow.start_denied` is the one this
// path exists to surface, and it reaches the composer as the port's own refusal with
// its own code and sentence. Nothing here re-words it, and nothing here decides in
// advance whether a start would be permitted — that is the daemon's answer, and a
// renderer that pre-empted it would be projecting an eligibility it does not own.

import { useMemo } from "react";

import {
  settleGrowthRead,
  type GrowthPort,
  type WorkflowDefinitionSummary,
} from "../../../console/bridge/index.js";
import { useConsoleCommandSeat, type ConsoleCommand } from "../../../console/palette/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import { requestComposerFocus } from "../../../console/seats/index.js";
import type { CommandOutcome, DirectiveLine } from "../router/command-executor.js";
import { clientCommandRefusal } from "./client-command-recognizer.js";
import type { DirectiveLineHandlers } from "./directive-line-handlers.js";

/** The console command id this accelerator is registered and recognised under. */
export const WORKFLOW_START_COMMAND_ID = "workflow.start";

/** What the palette entry types for somebody who found the command there. */
export const WORKFLOW_START_DIRECTIVE_PREFILL: string = `/${WORKFLOW_START_COMMAND_ID} `;

/**
 * The definition name a line names, or nothing where it named none.
 *
 * Read off the whole line rather than handed down by the router, because the router
 * splits a line into a name and the text it came from and stops there — everything
 * past the command id is this command's own grammar, and no other command shares it.
 */
export function readWorkflowStartName(line: DirectiveLine): string | undefined {
  const afterCommand = line.text.slice(`/${line.commandName}`.length).trim();
  return afterCommand.length === 0 ? undefined : afterCommand;
}

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
  const wanted = typedName.toLocaleLowerCase();
  const matches = definitions.filter(
    (definition) => definition.name.toLocaleLowerCase() === wanted,
  );
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

/** What the accelerator needs to start a run, all of it the composer's own. */
export interface WorkflowStartInput {
  readonly growth: GrowthPort;
  /** The session this composer is addressed within, or nothing where it has none. */
  readonly sessionId: string | undefined;
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
  const typedName = readWorkflowStartName(line);
  if (typedName === undefined) {
    return refusedArgument(
      `${WORKFLOW_START_COMMAND_ID} starts a workflow by name, and this line named none. Type the definition's name after the command.`,
    );
  }
  const { sessionId } = input;
  if (sessionId === undefined) {
    return {
      status: "refused",
      refusal: clientCommandRefusal(
        "command-unavailable-here",
        `${WORKFLOW_START_COMMAND_ID} starts a workflow in a session, and this composer is not addressed within one.`,
      ),
    };
  }
  const listed = await settleGrowthRead(input.growth.workflowDefinitionList({ sessionId }));
  if (listed.status !== "served") {
    return { status: "refused", refusal: listed };
  }
  const match = matchWorkflowDefinition(listed.value.definitions, typedName);
  if (match.status === "none") {
    return refusedArgument(
      `No workflow this session can start is named ${typedName}. The plus menu lists the ones it can.`,
    );
  }
  if (match.status === "ambiguous") {
    return refusedArgument(
      `${String(match.count)} workflows this session can start are named ${typedName}, so nothing was started. Start it from the plus menu, which names the scope each one comes from.`,
    );
  }
  const started = await settleGrowthRead(
    input.growth.workflowRunStart({
      // The entry's own pin, never a version this module chose: a start is against a
      // pinned version, and the enumeration is what says which version a name is at.
      workflowVersionId: match.definition.latestWorkflowVersionId,
      sessionId,
    }),
  );
  // Carried whole. `workflow.start_denied` arrives here as the daemon's own refusal,
  // and the composer renders it beside the line exactly as it renders every other one.
  return started.status === "served"
    ? { status: "applied" }
    : { status: "refused", refusal: started };
}

/** A local refusal about what was typed. Nothing was asked on any of these paths. */
function refusedArgument(detail: string): CommandOutcome {
  return { status: "refused", refusal: clientCommandRefusal("command-argument-invalid", detail) };
}

/** What the accelerator's two halves are wired to for one mounted composer. */
export interface WorkflowStartAcceleratorOptions extends WorkflowStartInput {
  readonly draftStore: DraftStore;
  /** The composer line the palette entry types into. This composer's own key. */
  readonly draftKey: string;
}

/**
 * Contribute the palette entry and build the directive-line handler.
 *
 * ONE COMMAND, TWO WAYS IN, AND NEITHER IS A COPY OF THE OTHER. The palette entry
 * cannot start a run — there is no line there and so no name — so what it does is put
 * the directive on the line and ask for the caret, which is the act a person who found
 * the command in a list actually wants. The handler is what runs when the line is
 * complete. Both are registered under one id, so the keyboard page, the discovery
 * popover, and the recogniser are all naming the same command.
 */
export function useWorkflowStartAccelerator(
  options: WorkflowStartAcceleratorOptions,
): DirectiveLineHandlers {
  const { draftStore, draftKey, growth, sessionId } = options;
  const commands = useMemo<readonly ConsoleCommand[]>(
    () => [
      {
        id: WORKFLOW_START_COMMAND_ID,
        title: "Start a workflow",
        group: "Workflow",
        when: "sessionActive",
        keywords: ["workflow", "start", "run"],
        run: () => {
          draftStore.write(draftKey, WORKFLOW_START_DIRECTIVE_PREFILL);
          requestComposerFocus();
        },
      },
    ],
    [draftStore, draftKey],
  );
  useConsoleCommandSeat(WORKFLOW_START_COMMAND_OWNER, commands);

  return useMemo(
    () =>
      new Map([
        [
          WORKFLOW_START_COMMAND_ID,
          (line: DirectiveLine) => startWorkflowFromLine(line, { growth, sessionId }),
        ],
      ]),
    [growth, sessionId],
  );
}

/** The owner this command is contributed under. One per family, one live at a time. */
const WORKFLOW_START_COMMAND_OWNER = "composer-workflow-start";

// The documented line parses, and a dotted id is nobody's command.
//
// The surface is fixed: one command root, `workflow`, one verb, `start`, and the line
// `/workflow start <name>`. The end-to-end case below is what makes that a claim about
// the SHIPPED path rather than about this module — the same recogniser the send bar
// hands the router, the real router, and the real executor over the real console
// registry — and its negative control registers the dotted id instead of the root, which
// leaves the documented line an unregistered name.

import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { SESSION_TARGET, sendCallsAnswering } from "../../draft-line/send-router.test-support.js";
import { ComposerSendRouter } from "../../draft-line/send-router.js";
import { createClientCommandExecutor } from "../client-command-executor.js";
import { recognizeClientCommand } from "../client-command-recognizer.js";
import { readComposerCommands } from "../composer-commands.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
} from "../composer-command-line-handlers.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-command.test-support.js";
import { WORKFLOW_COMMAND_ROOT, readWorkflowCommandLine } from "./workflow-command-grammar.js";
import { startWorkflowFromLine } from "./start-workflow-from-line.js";

/** A dotted id that names no root, registered only as a foil. */
const DOTTED_ID = "workflow.start";

const registeredIds: string[] = [];

/** Register one id into the real console registry, with an act that does nothing. */
function registerRoot(commandId: string): void {
  commandRegistry.register({
    id: commandId,
    title: "Start a workflow",
    group: "Workflow",
    run: () => undefined,
  });
  registeredIds.push(commandId);
}

/** The router the send bar builds, over whichever ids the registry holds. */
function routerOverRegistry(): ComposerSendRouter {
  return new ComposerSendRouter({
    calls: sendCallsAnswering(async () => undefined),
    recognizeClientCommand: (commandName) =>
      recognizeClientCommand(commandName, {
        registeredCommandIds: readComposerCommands(DEFAULT_ROUTE).registeredCommandIds,
      }).status === "recognized",
  });
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});

describe("the `/workflow` line", () => {
  it.each([
    ["a plain name", "/workflow start nightly-review", "nightly-review"],
    ["a name with spaces in it", "/workflow start nightly review", "nightly review"],
    ["surrounding whitespace", "/workflow   start   nightly  ", "nightly"],
  ])("reads %s", (_case, text, expected) => {
    expect(readWorkflowCommandLine(text)).toStrictEqual({
      status: "start",
      definitionName: expected,
    });
  });

  it("reads a verb with nothing after it as a start that named no definition", () => {
    expect(readWorkflowCommandLine("/workflow start")).toStrictEqual({
      status: "start",
      definitionName: undefined,
    });
  });

  it("reads a line that named only the root as a missing verb", () => {
    expect(readWorkflowCommandLine("/workflow")).toStrictEqual({ status: "verb-missing" });
    expect(readWorkflowCommandLine("/workflow   ")).toStrictEqual({ status: "verb-missing" });
  });

  it("names an unrecognised verb rather than reading it as a definition", () => {
    expect(readWorkflowCommandLine("/workflow stop nightly")).toStrictEqual({
      status: "verb-unknown",
      verb: "stop",
    });
  });

  it("reads nothing off a line that is not this command's", () => {
    expect(readWorkflowCommandLine("/frame.goToSettings")).toBeUndefined();
    expect(readWorkflowCommandLine("ship the parser fix")).toBeUndefined();
  });
});

describe("the documented line, end to end through the recogniser and the router", () => {
  it("intercepts `/workflow start <name>` and starts the named definition", async () => {
    registerRoot(WORKFLOW_COMMAND_ROOT);
    const calls = recordedWorkflowCalls();
    const resolution = routerOverRegistry().resolve("/workflow start nightly", SESSION_TARGET);

    expect(resolution).toStrictEqual({
      outcome: "client-command",
      commandName: WORKFLOW_COMMAND_ROOT,
    });
    if (resolution.outcome !== "client-command") {
      throw new Error("the documented line must be intercepted as a client command");
    }
    const handlers: ComposerCommandLineHandlers = new Map([
      [
        WORKFLOW_COMMAND_ROOT,
        async (line) =>
          await startWorkflowFromLine(line, {
            operations: fixtureWorkflowStartOperations({
              definitions: [{ name: "nightly" }],
              calls,
            }),
            sessionId: WORKFLOW_TEST_SESSION_ID,
          }),
      ],
    ]);
    const executor = createClientCommandExecutor({
      readSurface: () => readComposerCommands(DEFAULT_ROUTE),
      readDirectiveHandlers: () => handlers,
      lineReadingCommandIds: LINE_READING_COMMAND_IDS,
    });

    const outcome = await executor({
      commandName: resolution.commandName,
      text: "/workflow start nightly",
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started.map((request) => request.workflowVersionId)).toStrictEqual([
      "version-nightly",
    ]);
  });

  it("negative control: under a dotted id the documented line goes out as typed", () => {
    // `directive-syntax.ts` hands the recogniser the FIRST WORD, so with `workflow.start`
    // registered the documented line names `workflow` — an id the console does not hold —
    // and the line goes on as a new turn rather than reaching the workflow handler.
    registerRoot(DOTTED_ID);

    const resolution = routerOverRegistry().resolve("/workflow start nightly", SESSION_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });
});

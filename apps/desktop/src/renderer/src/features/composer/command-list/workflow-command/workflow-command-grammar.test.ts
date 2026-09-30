// The documented line `/workflow start <name>` parses, and a dotted id is nobody's command. The
// end-to-end case uses the real recognizer, router, executor and registry; its control registers
// the dotted id instead, leaving the documented line an unregistered name.

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

const DOTTED_ID = "workflow.start";

const registeredIds: string[] = [];

function registerRoot(commandId: string): void {
  commandRegistry.register({
    id: commandId,
    title: "Start a workflow",
    group: "Workflow",
    run: () => undefined,
  });
  registeredIds.push(commandId);
}

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

  it("names an unrecognized verb rather than reading it as a definition", () => {
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

describe("the documented line, end to end through the recognizer and the router", () => {
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
      readCommands: () => readComposerCommands(DEFAULT_ROUTE),
      readCommandLineHandlers: () => handlers,
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
    // The recognizer gets the first word, so with `workflow.start` registered the documented line
    // names `workflow`, which the console does not hold, and goes on as a new turn.
    registerRoot(DOTTED_ID);

    const resolution = routerOverRegistry().resolve("/workflow start nightly", SESSION_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });
});

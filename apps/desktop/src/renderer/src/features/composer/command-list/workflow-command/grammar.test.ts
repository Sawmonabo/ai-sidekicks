// The documented line `/workflow run <name>` parses to the whole name, an unrecognized verb is
// named rather than read as a definition, and the documented line reaches a start end to end
// through the real recognizer, router, executor and registry.

import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry } from "#renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { SESSION_TARGET, sendCallsAnswering } from "../../draft-line/send/router.test-support.js";
import { ComposerSendRouter } from "../../draft-line/send/router.js";
import { createConsoleCommandExecutor } from "../console-command/executor.js";
import { recognizeConsoleCommand } from "../console-command/recognizer.js";
import { readComposerCommands } from "../composer-commands.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
} from "../composer-command-line-handlers.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./start-from-line.test-support.js";
import { WORKFLOW_COMMAND_ROOT, readWorkflowCommandLine } from "./grammar.js";
import { startWorkflowFromLine } from "./start-from-line.js";

const registeredIds: string[] = [];

function registerRoot(commandId: string): void {
  commandRegistry.register({
    id: commandId,
    title: "Run a workflow",
    group: "Workflow",
    run: () => undefined,
  });
  registeredIds.push(commandId);
}

function routerOverRegistry(): ComposerSendRouter {
  return new ComposerSendRouter({
    calls: sendCallsAnswering(async () => undefined),
    recognizeConsoleCommand: (commandName) =>
      recognizeConsoleCommand(commandName, {
        runnableCommandIds: readComposerCommands(DEFAULT_ROUTE).runnableCommandIds,
      }),
  });
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});

describe("the `/workflow` line", () => {
  it.each([
    ["a plain name", "/workflow run nightly-review", "nightly-review"],
    ["a name with spaces in it", "/workflow run nightly review", "nightly review"],
    ["surrounding whitespace", "/workflow   run   nightly  ", "nightly"],
  ])("reads %s", (_case, text, expected) => {
    expect(readWorkflowCommandLine(text)).toStrictEqual({
      status: "run",
      definitionName: expected,
    });
  });

  it("names an unrecognized verb rather than reading it as a definition", () => {
    expect(readWorkflowCommandLine("/workflow stop nightly")).toStrictEqual({
      status: "verb-unknown",
      verb: "stop",
    });
  });
});

describe("the documented line, end to end through the recognizer and the router", () => {
  it("intercepts `/workflow run <name>` and starts the named definition", async () => {
    registerRoot(WORKFLOW_COMMAND_ROOT);
    const calls = recordedWorkflowCalls();
    const resolution = routerOverRegistry().resolve("/workflow run nightly", SESSION_TARGET);

    expect(resolution).toStrictEqual({
      outcome: "console-command",
      commandName: WORKFLOW_COMMAND_ROOT,
    });
    if (resolution.outcome !== "console-command") {
      throw new Error("the documented line must be intercepted as a console command");
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
    const executor = createConsoleCommandExecutor({
      readCommands: () => readComposerCommands(DEFAULT_ROUTE),
      readCommandLineHandlers: () => handlers,
      lineReadingCommandIds: LINE_READING_COMMAND_IDS,
    });

    const outcome = await executor({
      commandName: resolution.commandName,
      text: "/workflow run nightly",
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started.map((request) => request.workflowVersionId)).toStrictEqual([
      "version-nightly",
    ]);
  });
});

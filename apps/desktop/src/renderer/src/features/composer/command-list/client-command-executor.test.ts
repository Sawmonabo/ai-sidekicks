// A recognized command settles before the line is cleared: a failure is a refusal, and a command
// that reads its line gets the line. Driven through the real
// `commandRegistry` a person's `/name` reaches.

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { createClientCommandExecutor } from "./client-command-executor.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
  noComposerCommandLineHandlers,
} from "./composer-command-line-handlers.js";
import { readComposerCommands } from "./composer-commands.js";

const FAILING_COMMAND_ID = "composer-executor-test.failing";

const registeredIds: string[] = [];

function registerCommand(command: {
  readonly id: string;
  readonly when?: string;
  readonly run: () => void | Promise<void>;
}): void {
  commandRegistry.register({
    id: command.id,
    title: "Executor test command",
    group: "Test",
    ...(command.when === undefined ? {} : { when: command.when }),
    run: command.run,
  });
  registeredIds.push(command.id);
}

function executorOverConsoleRegistry(
  handlers: ComposerCommandLineHandlers = noComposerCommandLineHandlers(),
) {
  return createClientCommandExecutor({
    readCommands: () => readComposerCommands(DEFAULT_ROUTE),
    readCommandLineHandlers: () => handlers,
    lineReadingCommandIds: LINE_READING_COMMAND_IDS,
  });
}

/** One line as the router builds it. */
function commandLine(commandName: string) {
  return { commandName, text: `/${commandName}` };
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});

describe("createClientCommandExecutor", () => {
  it("refuses a command that rejects rather than reporting it applied", async () => {
    registerCommand({
      id: FAILING_COMMAND_ID,
      run: () => Promise.reject(new Error("the act did not complete")),
    });
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(commandLine(FAILING_COMMAND_ID));

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("a rejected command must not report applied");
    }
    expect(outcome.refusal.code).toBe("command-failed");
    expect(outcome.refusal.detail).toContain("the act did not complete");
  });
});

describe("a command that reads arguments off its own line", () => {
  it("is reached through its handler rather than through the registry's invoke", async () => {
    // The registry's `run()` takes nothing, so `invoke` would run it with the line dropped.
    const invoked = vi.fn();
    const handled = vi.fn(async () => ({ status: "applied" }) as const);
    registerCommand({ id: "test.withArguments", run: invoked });

    const outcome = await executorOverConsoleRegistry(new Map([["test.withArguments", handled]]))({
      commandName: "test.withArguments",
      text: "/test.withArguments a name",
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(handled).toHaveBeenCalledWith({
      commandName: "test.withArguments",
      text: "/test.withArguments a name",
    });
    expect(invoked).not.toHaveBeenCalled();
  });
});

describe("a directive handler that fails", () => {
  // The executor never throws to report a failure, and a directive handler is reached through
  // it; the send controller awaits under a `finally` with no `catch`, so an escaping rejection
  // would leave the line unexplained.
  it("settles a handler that returns a rejected promise as a refusal", async () => {
    registerCommand({ id: "test.rejectingHandler", run: vi.fn() });
    const executor = executorOverConsoleRegistry(
      new Map([["test.rejectingHandler", () => Promise.reject(new Error("the wire went away"))]]),
    );

    const outcome = await executor(commandLine("test.rejectingHandler"));

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("a failed handler must not report applied");
    }
    expect(outcome.refusal.code).toBe("command-failed");
    expect(outcome.refusal.detail).toContain("the wire went away");
  });
});

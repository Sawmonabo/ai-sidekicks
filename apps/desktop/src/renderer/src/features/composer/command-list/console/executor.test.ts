// A recognized command settles before the line is cleared: a failure is stated on the window's
// banner in the command's own name, and a command that reads its line gets the line. Driven
// through the real `commandRegistry` a person's `/name` reaches.

import { afterEach, describe, expect, it, vi } from "vitest";

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { RefusalError, refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { publishCommandRefusalSink } from "#renderer/registries/commands/refusal.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { createConsoleCommandExecutor } from "./executor.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
  noComposerCommandLineHandlers,
} from "../line-handlers.js";
import { readComposerCommands } from "../registry-view.js";

const FAILING_COMMAND_ID = "composer-executor-test.failing";

const registeredIds: string[] = [];

function registerCommand(command: {
  readonly id: string;
  readonly title?: string;
  readonly isTitleVerbPhrase?: false;
  readonly when?: string;
  readonly run: () => void | Promise<void>;
}): void {
  commandRegistry.register({
    id: command.id,
    title: command.title ?? "Run the executor test",
    group: "Test",
    ...(command.isTitleVerbPhrase === undefined ? {} : { isTitleVerbPhrase: false }),
    ...(command.when === undefined ? {} : { when: command.when }),
    run: command.run,
  });
  registeredIds.push(command.id);
}

/** The window's banner as a list of what it was handed, published until the case ends. */
function bannerSink(): Refusal[] {
  const stated: Refusal[] = [];
  withdrawals.push(publishCommandRefusalSink((refusal) => stated.push(refusal)));
  return stated;
}

const withdrawals: (() => void)[] = [];

function executorOverConsoleRegistry(
  handlers: ComposerCommandLineHandlers = noComposerCommandLineHandlers(),
) {
  return createConsoleCommandExecutor({
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
  for (const withdraw of withdrawals.splice(0)) {
    withdraw();
  }
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
  vi.restoreAllMocks();
});

describe("createConsoleCommandExecutor", () => {
  it("states a command that rejects in its own name, its cause captured, never applied", async () => {
    registerCommand({
      id: FAILING_COMMAND_ID,
      run: () => Promise.reject(new Error("the act did not complete")),
    });
    const banner = bannerSink();
    const recorded = vi.spyOn(windowDiagnosticCapture, "record");

    const outcome = await executorOverConsoleRegistry()(commandLine(FAILING_COMMAND_ID));

    // The line stays as typed and the composer draws nothing; the window's banner says it.
    expect(outcome).toStrictEqual({ status: "not-run" });
    expect(banner.map((refusal) => refusal.detail)).toStrictEqual([
      "Couldn't run the executor test",
    ]);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: `${FAILING_COMMAND_ID}: the act did not complete`,
      }),
    );
  });

  it("names a refused command and the refusal's words, or the act that failed", async () => {
    const cause = "The run already ended";
    registerCommand({
      id: "test.stopRun",
      title: "Stop run",
      run: () => {
        throw new RefusalError(refuse("runs", "run.notRunning", cause));
      },
    });
    registerCommand({
      id: "test.undo",
      title: "Undo",
      isTitleVerbPhrase: false,
      run: () => Promise.reject(refuse("daemon", "session.restoreFailed", cause)),
    });
    const banner = bannerSink();
    const recorded = vi.spyOn(windowDiagnosticCapture, "record");
    const executor = executorOverConsoleRegistry();

    await executor(commandLine("test.stopRun"));
    await executor(commandLine("test.undo"));

    expect(banner.map((refusal) => refusal.detail)).toStrictEqual([
      `Couldn't stop run · ${cause}`,
      `Undo failed · ${cause}`,
    ]);
    // A cause drawn in words is not captured as a defect.
    expect(recorded).not.toHaveBeenCalled();
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

describe("a command handler that fails", () => {
  // The executor never throws to report a failure, and a command handler is reached through
  // it; the send controller awaits under a `finally` with no `catch`, so an escaping rejection
  // would leave the line unexplained.
  it("states a handler that returns a rejected promise on the banner", async () => {
    registerCommand({ id: "test.rejectingHandler", run: vi.fn() });
    const banner = bannerSink();
    const executor = executorOverConsoleRegistry(
      new Map([["test.rejectingHandler", () => Promise.reject(new Error("the wire went away"))]]),
    );

    const outcome = await executor(commandLine("test.rejectingHandler"));

    expect(outcome).toStrictEqual({ status: "not-run" });
    expect(banner.map((refusal) => refusal.code)).toStrictEqual(["command-failed"]);
  });
});

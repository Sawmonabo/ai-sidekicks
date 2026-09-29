// That a recognized command actually PERFORMS its act, and that the composer waits.
//
// Driven through the real registry — `commandRegistry`, the one the palette and the
// chord table read — rather than a stand-in, so the claim is about the registry a
// person's `/name` really reaches. A local registry would prove the executor talks to
// a registry and nothing about which.
//
// The negative control is the one that matters: an executor that reported `applied`
// from `invoke`'s synchronous return would pass every clean case here and still clear
// a person's line on a command that had not finished.

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { createClientCommandExecutor } from "./client-command-executor.js";
import { clientCommandRefusal } from "./client-command-recognizer.js";
import {
  LINE_READING_COMMAND_IDS,
  type ComposerCommandLineHandlers,
  noComposerCommandLineHandlers,
} from "./composer-command-line-handlers.js";
import { readComposerCommands } from "./composer-commands.js";

const RAN_COMMAND_ID = "composer-executor-test.ran";
const FAILING_COMMAND_ID = "composer-executor-test.failing";
const HIDDEN_COMMAND_ID = "composer-executor-test.hidden";

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

/** One line as the router builds it: the name, and the trimmed text it came from. */
function commandLine(commandName: string) {
  return { commandName, text: `/${commandName}` };
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});

describe("createClientCommandExecutor", () => {
  it("runs a registered console command through the console's own command registry", async () => {
    let ranCount = 0;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: () => {
        ranCount += 1;
      },
    });
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(commandLine(RAN_COMMAND_ID));

    expect(outcome).toEqual({ status: "applied" });
    expect(ranCount).toBe(1);
    expect(commandRegistry.recentCommandIds()).toContain(RAN_COMMAND_ID);
  });

  it("waits for the command's own completion before reporting it applied", async () => {
    let settled = false;
    let release: (() => void) | undefined;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        settled = true;
      },
    });
    const executor = executorOverConsoleRegistry();

    const pending = executor(commandLine(RAN_COMMAND_ID));
    expect(settled).toBe(false);
    release?.();

    expect(await pending).toEqual({ status: "applied" });
    expect(settled).toBe(true);
  });

  it("negative control: a command that rejects refuses rather than reporting applied", async () => {
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

  it("names a hidden command as unavailable here rather than as unknown", async () => {
    let ranCount = 0;
    registerCommand({
      id: HIDDEN_COMMAND_ID,
      // A key the frame publishes, false on the sessions route this executor reads.
      when: "onWorkflows",
      run: () => {
        ranCount += 1;
      },
    });
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(commandLine(HIDDEN_COMMAND_ID));

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("a hidden command must not report applied");
    }
    expect(outcome.refusal.code).toBe("command-unavailable-here");
    expect(ranCount).toBe(0);
  });

  it("negative control: the hidden command is not offered for discovery either", () => {
    registerCommand({
      id: HIDDEN_COMMAND_ID,
      when: "onWorkflows",
      run: () => undefined,
    });
    const composerCommands = readComposerCommands(DEFAULT_ROUTE);

    expect(composerCommands.registeredCommandIds).toContain(HIDDEN_COMMAND_ID);
    expect(composerCommands.offeredCommands.map((command) => command.id)).not.toContain(
      HIDDEN_COMMAND_ID,
    );
  });

  it("refuses a name the console never registered and dispatches nothing", async () => {
    // `compact` is a real provider command name, which is exactly why it is the
    // interesting one: the console does not register it, so the composer does not run
    // it, and the popover is where a person reads that the provider's own entries are
    // offered for discovery and nothing else.
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(commandLine("compact"));

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("an unregistered name must never be executed from the composer");
    }
    expect(outcome.refusal.code).toBe("unknown-command");
  });

  it("reads the registry at run time, so a late registration is reachable", async () => {
    const executor = executorOverConsoleRegistry();
    const beforeRegistration = await executor(commandLine(RAN_COMMAND_ID));
    expect(beforeRegistration.status).toBe("refused");

    let ranCount = 0;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: () => {
        ranCount += 1;
      },
    });

    expect(await executor(commandLine(RAN_COMMAND_ID))).toEqual({
      status: "applied",
    });
    expect(ranCount).toBe(1);
  });
});

describe("a command that reads arguments off its own line", () => {
  it("is reached through its handler rather than through the registry's invoke", async () => {
    // The registry's `run()` takes nothing, so an argument-reading command performed
    // through `invoke` would run with the line thrown away.
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

  it("negative control: a command with no handler still goes through the registry", async () => {
    const invoked = vi.fn();
    registerCommand({ id: "test.withoutArguments", run: invoked });

    await executorOverConsoleRegistry(new Map([["test.other", vi.fn()]]))(
      commandLine("test.withoutArguments"),
    );

    expect(invoked).toHaveBeenCalledTimes(1);
  });

  it("does not widen recognition: a handler for an unregistered id is unreachable", async () => {
    // The recognizer answers first. A second registry that could claim a name the
    // console has never heard of is what `client-command-recognizer.ts` prevents.
    const handled = vi.fn();

    const outcome = await executorOverConsoleRegistry(new Map([["test.unregistered", handled]]))(
      commandLine("test.unregistered"),
    );

    expect(outcome.status).toBe("refused");
    expect(handled).not.toHaveBeenCalled();
  });
});

describe("a directive handler that fails", () => {
  // The executor's contract is that it "returns a settlement; never throws to report
  // one", and a directive handler is reached THROUGH it — so an escaping rejection
  // was that contract broken from the inside. What reached a person was an unhandled
  // rejection: the send controller's interception arm has a `finally` and no `catch`,
  // so no refusal rendered beside the line and the line was left unexplained.
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

  it("settles a handler that throws before it ever returns a promise", async () => {
    // A handler that throws synchronously and one that returns a rejected promise are
    // the same failure to the person who typed the line, and only calling it INSIDE
    // the boundary catches both.
    registerCommand({ id: "test.throwingHandler", run: vi.fn() });
    const executor = executorOverConsoleRegistry(
      new Map([
        [
          "test.throwingHandler",
          () => {
            throw new Error("the handler was built wrong");
          },
        ],
      ]),
    );

    const outcome = await executor(commandLine("test.throwingHandler"));

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.refusal.detail : "").toContain(
      "the handler was built wrong",
    );
  });

  it("negative control: a handler that settles normally is still not touched", async () => {
    // The guard settles failures and nothing else — a handler's own refusal reaches
    // the composer as the refusal it built, not as `command-failed`.
    registerCommand({ id: "test.refusingHandler", run: vi.fn() });
    const handlerRefusal = {
      status: "refused",
      refusal: clientCommandRefusal("command-argument-invalid", "that name matched nothing"),
    } as const;
    const executor = executorOverConsoleRegistry(
      new Map([["test.refusingHandler", async () => handlerRefusal]]),
    );

    expect(await executor(commandLine("test.refusingHandler"))).toStrictEqual(handlerRefusal);
  });
});

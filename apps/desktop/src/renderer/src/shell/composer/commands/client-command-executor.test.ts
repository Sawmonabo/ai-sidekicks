// That a recognised command actually PERFORMS its act, and that the composer waits.
//
// Driven through the real registry — `consoleCommands`, the one the palette and the
// chord table read — rather than a stand-in, so the claim is about the surface a
// person's `/name` really reaches. A local registry would prove the executor talks to
// a registry and nothing about which.
//
// The negative control is the one that matters: an executor that reported `applied`
// from `invoke`'s synchronous return would pass every clean case here and still clear
// a person's line on a command that had not finished.

import { afterEach, describe, expect, it } from "vitest";

import { consoleCommands } from "../../../console/palette/index.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { createClientCommandExecutor } from "./client-command-executor.js";
import { composerCommandSurface } from "./console-command-surface.js";

const RAN_COMMAND_ID = "composer-executor-test.ran";
const FAILING_COMMAND_ID = "composer-executor-test.failing";
const HIDDEN_COMMAND_ID = "composer-executor-test.hidden";

const registeredIds: string[] = [];

function registerCommand(command: {
  readonly id: string;
  readonly when?: string;
  readonly run: () => void | Promise<void>;
}): void {
  consoleCommands.register({
    id: command.id,
    title: "Executor test command",
    group: "Test",
    ...(command.when === undefined ? {} : { when: command.when }),
    run: command.run,
  });
  registeredIds.push(command.id);
}

function executorOverConsoleRegistry() {
  return createClientCommandExecutor({
    readSurface: () => composerCommandSurface(DEFAULT_ROUTE),
  });
}

/** One line as the router builds it: the name, and the trimmed text it came from. */
function directiveLine(commandName: string) {
  return { commandName, text: `/${commandName}` };
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    consoleCommands.unregister(commandId);
  }
});

describe("createClientCommandExecutor", () => {
  it("runs a registered console command through the console's own surface", async () => {
    let ranCount = 0;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: () => {
        ranCount += 1;
      },
    });
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(directiveLine(RAN_COMMAND_ID));

    expect(outcome).toEqual({ status: "applied" });
    expect(ranCount).toBe(1);
    expect(consoleCommands.recentCommandIds()).toContain(RAN_COMMAND_ID);
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

    const pending = executor(directiveLine(RAN_COMMAND_ID));
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

    const outcome = await executor(directiveLine(FAILING_COMMAND_ID));

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

    const outcome = await executor(directiveLine(HIDDEN_COMMAND_ID));

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
    const surface = composerCommandSurface(DEFAULT_ROUTE);

    expect(surface.registeredCommandIds).toContain(HIDDEN_COMMAND_ID);
    expect(surface.offeredCommands.map((command) => command.id)).not.toContain(HIDDEN_COMMAND_ID);
  });

  it("refuses a name the console never registered and dispatches nothing", async () => {
    // `compact` is a real provider command name, which is exactly why it is the
    // interesting one: the console does not register it, so the composer does not run
    // it, and the popover is where a person reads that the provider's own entries are
    // offered for discovery and nothing else.
    const executor = executorOverConsoleRegistry();

    const outcome = await executor(directiveLine("compact"));

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("an unregistered name must never be executed from the composer");
    }
    expect(outcome.refusal.code).toBe("unknown-command");
  });

  it("reads the registry at run time, so a late registration is reachable", async () => {
    const executor = executorOverConsoleRegistry();
    const beforeRegistration = await executor(directiveLine(RAN_COMMAND_ID));
    expect(beforeRegistration.status).toBe("refused");

    let ranCount = 0;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: () => {
        ranCount += 1;
      },
    });

    expect(await executor(directiveLine(RAN_COMMAND_ID))).toEqual({
      status: "applied",
    });
    expect(ranCount).toBe(1);
  });
});

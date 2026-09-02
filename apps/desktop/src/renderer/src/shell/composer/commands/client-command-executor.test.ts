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

import { consoleCommands } from "../../../console/frame/command-surface.js";
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

function executorOverProviderNames(providerCommandNames: readonly string[]) {
  return createClientCommandExecutor({
    readSurface: () => composerCommandSurface(DEFAULT_ROUTE),
    readProviderCommandNames: () => providerCommandNames,
  });
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
    const executor = executorOverProviderNames([]);

    const outcome = await executor({ commandName: RAN_COMMAND_ID, argumentText: "" });

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
    const executor = executorOverProviderNames([]);

    const pending = executor({ commandName: RAN_COMMAND_ID, argumentText: "" });
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
    const executor = executorOverProviderNames([]);

    const outcome = await executor({ commandName: FAILING_COMMAND_ID, argumentText: "" });

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
    const executor = executorOverProviderNames([]);

    const outcome = await executor({ commandName: HIDDEN_COMMAND_ID, argumentText: "" });

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

  it("refuses a provider command by rule and dispatches nothing", async () => {
    const executor = executorOverProviderNames(["compact"]);

    const outcome = await executor({ commandName: "compact", argumentText: "" });

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("a provider command must never be executed from the composer");
    }
    expect(outcome.refusal.code).toBe("provider-command-not-executable");
  });

  it("reads the registry at run time, so a late registration is reachable", async () => {
    const executor = executorOverProviderNames([]);
    const beforeRegistration = await executor({
      commandName: RAN_COMMAND_ID,
      argumentText: "",
    });
    expect(beforeRegistration.status).toBe("refused");

    let ranCount = 0;
    registerCommand({
      id: RAN_COMMAND_ID,
      run: () => {
        ranCount += 1;
      },
    });

    expect(await executor({ commandName: RAN_COMMAND_ID, argumentText: "" })).toEqual({
      status: "applied",
    });
    expect(ranCount).toBe(1);
  });
});

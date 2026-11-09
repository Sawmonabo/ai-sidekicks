// Ctrl+B moves the command the agent waits on to the background: the chord runs the composer's
// command, the command asks the mounted composer, and the ask sends the background request for
// the newest command the provider offers to move, naming the session and that command alone. The
// chord is bound only while a command can move; otherwise the press stays the message line's.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandId, RunningCommand } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import {
  moveCommandToBackground,
  publishCanMoveToBackground,
  readCanMoveToBackground,
  subscribeToBackgroundRequests,
} from "./background-requests.js";
import { registerComposerCommands } from "./contributions/commands.js";
import { registerComposerKeybindings } from "./contributions/keybindings.js";

const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f" as SessionId;

/** One running command, waited on, that the provider offers to move or not. */
function commandRunning(commandId: string, canMoveToBackground: boolean): RunningCommand {
  return {
    commandId: commandId as CommandId,
    runId: "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e" as RunId,
    name: "pnpm test",
    startedAt: "2026-11-09T10:00:00.000Z" as RunningCommand["startedAt"],
    waitingInForeground: true,
    canMoveToBackground,
    acceptsInput: false,
    waitingForInput: false,
    echoOff: false,
  };
}

const stopListening: (() => void)[] = [];
afterEach(() => {
  for (const stop of stopListening.splice(0)) {
    stop();
  }
  publishCanMoveToBackground(false);
});

/** Ctrl+B pressed in the message line, through a binding table over the composer's chords. */
function pressControlBInLine(send: (request: unknown) => void): KeyboardEvent {
  const commandRegistry = new CommandRegistry();
  const contributions = new CommandContributionRegistry(commandRegistry);
  registerComposerCommands(contributions);
  registerComposerKeybindings(contributions);
  const table = new KeybindingTable({
    registry: commandRegistry,
    readContext: () => ({
      sessionActive: true,
      commandCanMoveToBackground: readCanMoveToBackground(),
    }),
  });
  table.setBindings(contributions.keyBindings());
  const commands = [commandRunning("cmd-tests", true), commandRunning("cmd-build", false)];
  stopListening.push(
    subscribeToBackgroundRequests(() => {
      moveCommandToBackground(SESSION_ID, commands, send);
    }),
  );
  const line = document.createElement("textarea");
  document.body.append(line);
  const press = new KeyboardEvent("keydown", {
    key: "b",
    code: "KeyB",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const stopTable = table.install(line);
  line.dispatchEvent(press);
  stopTable();
  line.remove();
  return press;
}

describe("Ctrl+B — move to background", () => {
  it("sends the background request with the running command's id when the chord is pressed", () => {
    // Mutation: dropping the `canMoveToBackground` gate sends `cmd-build`, which the provider
    // does not offer to move; any member beyond the session and the command fails the equality.
    publishCanMoveToBackground(true);
    const send = vi.fn();

    const press = pressControlBInLine(send);

    expect(press.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ sessionId: SESSION_ID, commandId: "cmd-tests" });
  });

  it("leaves Ctrl+B to the line while no running command can move", () => {
    // Mutation: dropping `commandCanMoveToBackground` from the binding's `when` takes the press
    // from the line (the caret's Ctrl+B) even though nothing can move.
    const send = vi.fn();

    const press = pressControlBInLine(send);

    expect(press.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing where no running command can be moved", () => {
    const send = vi.fn();

    const moved = moveCommandToBackground(SESSION_ID, [commandRunning("cmd-build", false)], send);

    expect(moved).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

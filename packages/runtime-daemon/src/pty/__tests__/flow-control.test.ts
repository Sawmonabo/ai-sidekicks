// One shell's flow control through `session.setTerminalFlowControl`: the read pauses only while
// every watcher is behind, a watcher's end clears its state, and host calls apply in order with a
// failure reaching the act that caused it.

import { describe, expect, it } from "vitest";

import { TerminalIdSchema } from "@ai-sidekicks/contracts/pty";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { registerSessionSetTerminalFlowControl } from "../../ipc/handlers/session/set-terminal-flow-control.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { ShellFlowControl, type ShellFlowControlOptions } from "../flow-control.js";

const SESSION_ID = SessionIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e");
const TERMINAL_ID = TerminalIdSchema.parse("terminal-1");
const FIRST = 1;
const SECOND = 2;

function bindHandler(
  flowControl: ShellFlowControl,
): (transportId: number, paused: boolean) => Promise<unknown> {
  const registry = new MethodRegistryImpl();
  registerSessionSetTerminalFlowControl(registry, { findShellFlowControl: () => flowControl });
  return (transportId, paused) =>
    registry.dispatch(
      "session.setTerminalFlowControl",
      { sessionId: SESSION_ID, terminalId: TERMINAL_ID, paused },
      { transportId },
    );
}

describe("ShellFlowControl", () => {
  it("pauses the read only while every watcher is behind", async () => {
    const hostCalls: string[] = [];
    const flowControl = new ShellFlowControl({
      pause: async () => {
        hostCalls.push("pause");
      },
      resume: async () => {
        hostCalls.push("resume");
      },
    });
    const declare = bindHandler(flowControl);
    await flowControl.addWatcher(FIRST);
    await flowControl.addWatcher(SECOND);

    await expect(declare(FIRST, true)).resolves.toEqual({ accepted: true });
    expect(hostCalls).toEqual([]);
    await declare(SECOND, true);
    await declare(SECOND, true);
    expect(hostCalls).toEqual(["pause"]);
    await declare(SECOND, false);
    expect(hostCalls).toEqual(["pause", "resume"]);

    await declare(SECOND, true);
    await flowControl.removeWatcher(FIRST);
    // The connection that left no longer counts, even once it declares again.
    await declare(FIRST, false);
    expect(hostCalls).toEqual(["pause", "resume", "pause"]);
    await flowControl.removeWatcher(SECOND);
    expect(hostCalls).toEqual(["pause", "resume", "pause", "resume"]);
  });

  it("applies host calls in order; a failed one rejects its act and is retried next", async () => {
    const hostCalls: string[] = [];
    let finishPause: (() => void) | undefined;
    const options: ShellFlowControlOptions = {
      pause: () =>
        new Promise<void>((resolve) => {
          hostCalls.push("pause started");
          finishPause = () => {
            hostCalls.push("pause finished");
            resolve();
          };
        }),
      resume: async () => {
        hostCalls.push("resume");
        throw new Error("the shell is gone");
      },
    };
    const flowControl = new ShellFlowControl(options);
    const declare = bindHandler(flowControl);
    await flowControl.addWatcher(FIRST);

    const behind = declare(FIRST, true);
    const caughtUp = declare(FIRST, false);
    await expect.poll(() => hostCalls).toEqual(["pause started"]);
    finishPause?.();

    await expect(behind).resolves.toEqual({ accepted: true });
    await expect(caughtUp).rejects.toThrow("the shell is gone");
    expect(hostCalls).toEqual(["pause started", "pause finished", "resume"]);

    // The read is still paused, so the next declaration asks for the resume again.
    await expect(declare(FIRST, false)).rejects.toThrow("the shell is gone");
    expect(hostCalls).toEqual(["pause started", "pause finished", "resume", "resume"]);
  });
});

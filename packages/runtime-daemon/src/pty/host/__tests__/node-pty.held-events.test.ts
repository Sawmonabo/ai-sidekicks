// A terminal's output and exit that come before `spawn()` resolves wait until its caller has the
// session id, then arrive in order; output held past its bound pauses the terminal's read until
// it is delivered.

import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { makeFakeChild, makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { NodePtyHost } from "../node-pty.js";
import type { SpawnRequest } from "../protocol.js";
import { DARWIN_TERMINAL_OPERATING_SYSTEM } from "../../operating-system/darwin.js";

const SHELL_SPAWN: SpawnRequest = {
  kind: "spawn_request",
  command: "/bin/sh",
  args: [],
  env: [],
  cwd: "/tmp",
  rows: 24,
  cols: 80,
};

// `onCompleteSpawn` runs while the spawn records the child, before it resolves.
function hostWithChild(
  pid: number,
  onCompleteSpawn: (child: ReturnType<typeof makeFakeChild>) => void,
) {
  const fake = makeFakeChild(pid);
  const host = new NodePtyHost(
    {
      ...makeOrphanGuardDouble(),
      completeSpawn: () => {
        onCompleteSpawn(fake);
        return Promise.resolve();
      },
    },
    DARWIN_TERMINAL_OPERATING_SYSTEM,
    { ptySpawn: () => fake.child, platform: "darwin" },
  );
  const events: string[] = [];
  host.setOnData((sessionId, chunk) => {
    events.push(`data ${sessionId} ${String(chunk.byteLength)}`);
  });
  host.setOnExit((sessionId, exitCode) => {
    events.push(`exit ${sessionId} ${String(exitCode)}`);
  });
  return { host, fake, events };
}

describe("NodePtyHost events before spawn() resolves", () => {
  it("holds output and an exit until the caller has the id, then keeps their order", async () => {
    const { host, events } = hostWithChild(4400, ({ emitData, triggerExit }) => {
      emitData("prompt$ ");
      emitData(new Uint8Array(3));
      triggerExit(0);
    });

    const { session_id: sessionId } = await host.spawn(SHELL_SPAWN);
    expect(events).toEqual([]);

    await nextTurn();
    expect(events).toEqual([`data ${sessionId} 8`, `data ${sessionId} 3`, `exit ${sessionId} 0`]);
  });

  it("pauses the read while held output passes 64 KiB, and resumes once delivered", async () => {
    const { host, fake, events } = hostWithChild(4401, ({ emitData }) => {
      emitData(new Uint8Array(40 * 1024));
      emitData(new Uint8Array(25 * 1024));
    });

    const { session_id: sessionId } = await host.spawn(SHELL_SPAWN);
    expect(fake.child.pause).toHaveBeenCalledTimes(1);
    // Output arriving before the held output is delivered still waits behind it.
    fake.emitData(new Uint8Array(1));
    expect(events).toEqual([]);

    await nextTurn();
    expect(events).toEqual([
      `data ${sessionId} 40960`,
      `data ${sessionId} 25600`,
      `data ${sessionId} 1`,
    ]);
    expect(fake.child.resume).toHaveBeenCalledTimes(1);

    fake.emitData(new Uint8Array(2));
    expect(events.at(-1)).toBe(`data ${sessionId} 2`);
  });
});

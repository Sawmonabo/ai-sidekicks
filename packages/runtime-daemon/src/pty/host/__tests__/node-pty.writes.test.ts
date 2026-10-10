// node-pty's writes as this app patches them: a program that stopped reading costs the daemon a few
// retries a second rather than a busy loop, and every write's callback is called, with an error
// once the terminal is closed, so no writer waits forever.

import fs from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { type IPty, spawn } from "node-pty";
import { describe, expect, it, vi } from "vitest";

// Retries in one second while the terminal's buffer stays full. Measured at about 20 with the
// retry backing off; a retry on `setImmediate` makes 15,000 to 60,000.
const MAX_RETRIES_PER_SECOND = 200;

describe.skipIf(process.platform === "win32")("node-pty writes", () => {
  it("backs off while the program does not read, and fails the writes a close leaves", async () => {
    const child = spawn("/bin/sh", ["-c", "stty raw -echo; echo ready; sleep 30"], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
    });
    try {
      let output = "";
      child.onData((data) => {
        output += data;
      });
      await vi.waitFor(
        () => {
          expect(output).toContain("ready");
        },
        { timeout: 10_000, interval: 5 },
      );

      // Far more than the kernel's terminal buffer holds, so the write waits on a full buffer.
      const stalled = new Promise<Error | undefined>((resolve) => {
        child.write(Buffer.alloc(256 * 1024, 0x61), resolve);
      });
      await sleep(200);
      const attempts = vi.spyOn(fs, "write");
      await sleep(1_000);
      const retries = attempts.mock.calls.length;
      attempts.mockRestore();
      expect(retries).toBeGreaterThan(0);
      expect(retries).toBeLessThan(MAX_RETRIES_PER_SECOND);

      // `destroy`, which the typings leave out, closes the terminal at once, before the shell exits.
      (child as IPty & { destroy: () => void }).destroy();
      const late = new Promise<Error | undefined>((resolve) => {
        child.write("x", resolve);
      });
      await expect(stalled).resolves.toBeInstanceOf(Error);
      await expect(late).resolves.toBeInstanceOf(Error);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});

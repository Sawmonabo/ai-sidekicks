// A paused real `node-pty` session stops delivering a flooding program's output, which waits in
// the kernel instead of piling up in the daemon, and a resume delivers all of it in order.

import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { NodePtyHost } from "../node-pty.js";
import { selectTerminalOperatingSystem } from "../../operating-system/selector.js";

// Below a million, where the BSD `seq` on macOS switches to exponent notation.
const LINE_COUNT = 300_000;
// What may still arrive after the pause: at most a chunk node-pty had already read. Measured at 0
// bytes on macOS; with the pause ignored, the whole 2.2 MiB flood arrived in that second.
const MAX_BYTES_AFTER_PAUSE = 128 * 1024;

describe.skipIf(process.platform === "win32")("NodePtyHost flow control", () => {
  it("holds a flood back while paused, then delivers all of it in order", async () => {
    const host = new NodePtyHost(
      makeOrphanGuardDouble(),
      selectTerminalOperatingSystem(process.platform, process.env),
    );
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    let text = "";
    host.setOnData((_sessionId, chunk) => {
      receivedBytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    });

    try {
      const { session_id: sessionId } = await host.spawn({
        kind: "spawn_request",
        command: "/bin/sh",
        args: ["-c", `seq 1 ${LINE_COUNT}`],
        env: [["PATH", process.env["PATH"] ?? "/usr/bin:/bin"]],
        cwd: tmpdir(),
        rows: 24,
        cols: 80,
      });
      await vi.waitFor(
        () => {
          expect(receivedBytes).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 1 },
      );

      await host.pause(sessionId);
      const bytesAtPause = receivedBytes;
      await sleep(1_000);
      const bytesAfterPause = receivedBytes - bytesAtPause;
      expect(bytesAfterPause).toBeLessThan(MAX_BYTES_AFTER_PAUSE);

      await host.resume(sessionId);
      await vi.waitFor(
        () => {
          expect(text.slice(-16).replaceAll("\r", "").endsWith(`\n${LINE_COUNT}\n`)).toBe(true);
        },
        { timeout: 30_000, interval: 20 },
      );
      const lines = text.replaceAll("\r", "").trimEnd().split("\n");
      expect(lines).toHaveLength(LINE_COUNT);
      expect(lines.findIndex((line, index) => line !== String(index + 1))).toBe(-1);
    } finally {
      await host.shutdown({ perSessionTimeoutMs: 2_000, hostTimeoutMs: 2_000 });
    }
  }, 60_000);
});

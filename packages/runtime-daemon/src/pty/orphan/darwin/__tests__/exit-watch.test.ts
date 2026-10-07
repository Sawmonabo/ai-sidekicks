// The kernel's exit watch on macOS reports a real child's end, and closes at once while its wait
// is blocked, so the daemon's stop never hangs on it.

import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { DarwinProcessExitWatch } from "../exit-watch.js";
import { loadDarwinSystemLibrary } from "../system-library.js";

describe.skipIf(process.platform !== "darwin")("DarwinProcessExitWatch", () => {
  it("reports a child's exit, and closes promptly while still watching another", async () => {
    const watch = new DarwinProcessExitWatch(await loadDarwinSystemLibrary(), (error) => {
      throw error;
    });
    const brief = spawn("/bin/sleep", ["0.2"]);
    const lasting = spawn("/bin/sleep", ["30"]);
    try {
      const onBriefExit = vi.fn();
      watch.watch(brief.pid ?? 0, onBriefExit);
      watch.watch(lasting.pid ?? 0, () => {
        throw new Error("the lasting child was reported ended");
      });

      await vi.waitFor(
        () => {
          expect(onBriefExit).toHaveBeenCalledOnce();
        },
        { timeout: 5_000, interval: 20 },
      );

      const closeStartedAt = performance.now();
      await watch.close();
      expect(performance.now() - closeStartedAt).toBeLessThan(1_000);
    } finally {
      lasting.kill("SIGKILL");
    }
  });
});

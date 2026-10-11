import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { HOST_OPERATING_SYSTEM } from "../../../../tests/helpers/host-operating-system.js";

const MEBIBYTE = 1024 * 1024;
const TOUCHED_BYTES = 64 * MEBIBYTE;

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "this machine's peak memory read",
  () => {
    it("reads a live child's peak past what it touched, and nothing once it ends", async () => {
      const reader = HOST_OPERATING_SYSTEM.processPeak;
      // The child fills a buffer, so every page counts, says so, and stays until it is ended.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `globalThis.held = Buffer.alloc(${String(TOUCHED_BYTES)}, 1);` +
            'process.stdout.write("ready"); setInterval(() => {}, 60_000);',
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const processId = child.pid;
      if (processId === undefined) {
        throw new Error("The child did not start.");
      }
      await once(child.stdout, "data");

      const peakBytes = await reader.readPeakBytes(processId);
      expect(peakBytes).toBeGreaterThanOrEqual(TOUCHED_BYTES);

      child.kill("SIGKILL");
      await once(child, "exit");
      await expect(reader.readPeakBytes(processId)).resolves.toBeUndefined();
    });
  },
);

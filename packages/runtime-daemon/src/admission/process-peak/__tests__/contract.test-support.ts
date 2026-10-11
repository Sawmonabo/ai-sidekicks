// What every peak read must do, checked against a live child of this machine.

import { spawn } from "node:child_process";
import { once } from "node:events";

import { expect } from "vitest";

import type { ProcessPeakReader } from "../contract.js";

const MEBIBYTE = 1024 * 1024;
const TOUCHED_BYTES = 64 * MEBIBYTE;

/** Checks `reader` reads a live child's peak past what it touched, and none once it ends. */
export async function expectPeakOfLiveChild(reader: ProcessPeakReader): Promise<void> {
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
}

// On macOS the nonce search finds a real process by the nonce in its environment, and only the
// processes carrying a nonce it was asked for.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { SPAWN_NONCE_ENVIRONMENT_NAME } from "../../registry.js";
import { findDarwinProcessesCarryingNonces } from "../nonce-search.js";
import { loadDarwinSystemLibrary } from "../system-library.js";

function spawnCarrying(nonce: string): ChildProcess {
  return spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, [SPAWN_NONCE_ENVIRONMENT_NAME]: nonce },
    stdio: "ignore",
  });
}

describe.skipIf(process.platform !== "darwin")("findDarwinProcessesCarryingNonces", () => {
  it("finds the process carrying a sought nonce and no other", async () => {
    const library = await loadDarwinSystemLibrary();
    const userId = process.getuid?.() ?? -1;
    const sought = randomBytes(16).toString("hex");
    const other = randomBytes(16).toString("hex");
    const carrier = spawnCarrying(sought);
    const bystander = spawnCarrying(other);
    try {
      // Each environment is the child's own only once it has started its program.
      await vi.waitFor(
        () => {
          expect(
            findDarwinProcessesCarryingNonces(library, userId, new Set([sought, other])),
          ).toEqual(
            new Map([
              [carrier.pid, sought],
              [bystander.pid, other],
            ]),
          );
        },
        { timeout: 5_000, interval: 20 },
      );

      expect(
        findDarwinProcessesCarryingNonces(
          library,
          userId,
          new Set([sought, randomBytes(16).toString("hex")]),
        ),
      ).toEqual(new Map([[carrier.pid, sought]]));
    } finally {
      carrier.kill("SIGKILL");
      bystander.kill("SIGKILL");
    }
  });
});

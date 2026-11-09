// Ending a service that ignores SIGTERM signals it once the drain bound passes and kills it 2
// seconds later, whether main started it or found it by its identity. Every process a test
// started is killed when the test settles.

import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";

import { TemporaryDirectoryTrail } from "#test/helpers/temporary-directory.js";

import { selectMainOperatingSystem } from "../../../operating-system/selection.js";
import {
  attachToServiceProcess,
  NODE_PROCESS_IDENTITY_SYSTEM,
  type ServiceProcess,
} from "./process.js";
import { startServiceDetached } from "./start.js";

/** A reader of the processes of the system the test runs on. */
const readProcessIdentity = selectMainOperatingSystem(process.platform).createProcessIdentityReader(
  NODE_PROCESS_IDENTITY_SYSTEM,
);

const trail = new TemporaryDirectoryTrail();
let started: ServiceProcess[];

beforeEach(() => {
  started = [];
});

afterEach(() => {
  for (const service of started) {
    if (!service.hasExited()) {
      process.kill(service.processId, "SIGKILL");
    }
  }
  trail.removeAll();
});

it.each([
  ["started", (service: ServiceProcess): Promise<ServiceProcess> => Promise.resolve(service)],
  [
    "found by its identity",
    async (service: ServiceProcess): Promise<ServiceProcess> => {
      const identity = await readProcessIdentity(service.processId);
      return attachToServiceProcess(identity!, readProcessIdentity);
    },
  ],
])(
  "ends a service it %s that ignores SIGTERM after the drain bound, with SIGKILL 2 seconds later",
  async (_way, handleOf) => {
    const readyPath = path.join(trail.create("aisk-"), "ready");
    // A process that refuses the terminate signal, and says so once it is listening for it.
    const service = await startServiceDetached(
      {
        command: process.execPath,
        args: [
          "-e",
          `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, ""); setInterval(() => {}, 1000);`,
        ],
      },
      process.env,
    );
    started.push(service);
    await vi.waitFor(() => {
      expect(existsSync(readyPath)).toBe(true);
    });

    const ending = await handleOf(service);
    const endedAt = Date.now();
    void ending.end({ cause: "stopAsked", askedAt: performance.now() });
    await ending.whenExited();

    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(DAEMON_STOP_DRAIN_BOUND_MS + 2_000);
    expect(ending.hasExited()).toBe(true);
  },
  15_000,
);

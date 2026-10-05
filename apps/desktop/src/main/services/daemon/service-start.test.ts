// The supervisor over a real background service: none answers, so it starts the daemon detached
// through the start module, completes the handshake, reads the process the daemon reports as the
// one the system shows main for its child, and notices a SIGKILL the moment the socket closes
// rather than when the link falls silent. The daemon runs from source in a home and run folder of
// the test's own, and every process it started is killed when the test settles. Ending a service
// that ignores SIGTERM signals it once the drain bound passes and kills it 2 seconds later,
// whether main started it or found it by its identity.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { DAEMON_STATUS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/status";

import type { MainProcessState } from "@shared/daemon-status-topic.js";
import { PACKAGE_ROOT } from "@test/helpers/fixture-bundle.js";
import { TemporaryDirectoryTrail } from "@test/helpers/temporary-directory.js";

import { DaemonLink } from "./daemon-link.js";
import { connectMainToDaemon, DaemonSupervisor } from "./daemon-supervisor.js";
import { LINK_QUIET_MS } from "./link-lifetime.js";
import {
  attachToServiceProcess,
  createSystemProcessIdentityReader,
  type ServiceProcess,
} from "./service-process.js";
import { startServiceDetached } from "./service-start.js";

const DAEMON_SOURCE = path.resolve(PACKAGE_ROOT, "../../packages/runtime-daemon/src");
const SOURCE_LOADER = pathToFileURL(
  path.join(DAEMON_SOURCE, "__tests__", "typescript-source-loader.mjs"),
).href;
// The daemon's start runs the login shell under its own 5 s deadline before it binds its socket.
const LINK_WITHIN_MS = 20_000;

const trail = new TemporaryDirectoryTrail();
let started: ServiceProcess[];
let supervisor: DaemonSupervisor | undefined;

beforeEach(() => {
  started = [];
  supervisor = undefined;
});

afterEach(async () => {
  await supervisor?.dispose();
  for (const service of started) {
    if (!service.hasExited()) {
      process.kill(service.processId, "SIGKILL");
    }
  }
  vi.unstubAllEnvs();
  trail.removeAll();
});

it(
  "starts the service detached when none answers, and notices a SIGKILL on the socket's close",
  async () => {
    // A short root: the socket path under it is bounded at 104 bytes on macOS.
    const root = trail.create("aisk-");
    const homeDirectory = path.join(root, "home");
    const runtimeDirectory = path.join(root, "run");
    mkdirSync(homeDirectory);
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    // Main's own connect resolves the run folder from this, as the app's does.
    vi.stubEnv("XDG_RUNTIME_DIR", runtimeDirectory);

    const link = new DaemonLink();
    const logged: unknown[] = [];
    const activeSupervisor = new DaemonSupervisor({
      link,
      connect: connectMainToDaemon,
      startService: async () => {
        const service = await startServiceDetached(
          {
            command: process.execPath,
            args: [
              "--conditions=@ai-sidekicks/source",
              "--import",
              `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(SOURCE_LOADER)})`,
              path.join(DAEMON_SOURCE, "main.ts"),
            ],
          },
          { ...process.env, HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory },
        );
        started.push(service);
        return service;
      },
      attachServiceProcess: attachToServiceProcess,
      log: { write: (entry) => logged.push(entry) },
      now: () => new Date(),
    });
    supervisor = activeSupervisor;

    const linked = stateReached(link, (state) => state.connection.kind === "connected");
    activeSupervisor.start();
    const linkedState = await linked;

    expect(linkedState.startedByApp, JSON.stringify(logged)).toBe(true);
    expect(linkedState.negotiation?.compatible).toBe(true);
    expect(started).toHaveLength(1);
    const service = started[0]!;
    // Detached: the service leads a process group of its own, which the app's exit leaves alone.
    expect(() => process.kill(-service.processId, 0)).not.toThrow();
    // The process the daemon reports is the one the system shows main for the child it started.
    const statusRead = DAEMON_STATUS_METHOD_DESCRIPTORS["daemon.status.read"];
    const { processIdentity } = await link.client!.call(
      statusRead.method,
      {},
      statusRead.requestSchema,
      statusRead.responseSchema,
    );
    expect(processIdentity).toStrictEqual(
      await createSystemProcessIdentityReader()(service.processId),
    );

    const killedAt = Date.now();
    // Disposed as the loss lands, so the supervisor does not bring the service back.
    const lost = stateReached(link, (state) => {
      if (state.connection.kind !== "transient_disconnect") {
        return false;
      }
      void activeSupervisor.dispose();
      return true;
    });
    process.kill(service.processId, "SIGKILL");
    await lost;

    expect(Date.now() - killedAt).toBeLessThan(LINK_QUIET_MS);
    expect(link.client).toBeUndefined();
  },
  LINK_WITHIN_MS + 5_000,
);

/** Resolves with the first published state `isReached` accepts; rejects when the link degrades. */
function stateReached(
  link: DaemonLink,
  isReached: (state: MainProcessState) => boolean,
): Promise<MainProcessState> {
  return new Promise<MainProcessState>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`The link did not reach the state within ${String(LINK_WITHIN_MS)} ms`));
    }, LINK_WITHIN_MS);
    const unsubscribe = link.subscribe((state) => {
      if (isReached(state)) {
        clearTimeout(timer);
        queueMicrotask(() => {
          unsubscribe();
        });
        resolve(state);
      } else if (state.connection.kind === "degraded") {
        clearTimeout(timer);
        queueMicrotask(() => {
          unsubscribe();
        });
        reject(new Error(`The link degraded: ${String(state.connection.lastError)}`));
      }
    });
  });
}

it.each([
  ["started", (service: ServiceProcess): Promise<ServiceProcess> => Promise.resolve(service)],
  [
    "found by its identity",
    async (service: ServiceProcess): Promise<ServiceProcess> => {
      const identity = await createSystemProcessIdentityReader()(service.processId);
      return attachToServiceProcess(identity!);
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

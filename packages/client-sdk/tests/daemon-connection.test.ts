// The built addon against the daemon's own program: a connect, a call, a subscribe, and a call
// whose params break their method's contract. The daemon runs on a home of the test's own, so its
// data and run folders are the test's and never the person's.

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { DAEMON_READY_LINE } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { expect, it } from "vitest";

import { connect, type DaemonClient, type StreamEvent } from "../index.js";

/** The workspace's development build of the daemon's program. */
const DAEMON_PROGRAM = fileURLToPath(
  new URL("../../../target/debug/sidekicks-daemon", import.meta.url),
);

/** The longest the daemon may take to start, as the daemon's own tests allow it. */
const DAEMON_START_BOUND_MS = 60_000;

/**
 * Starts the daemon's program with `home` as its home and resolves once it says it is ready.
 * Rejects with what it wrote when it exits first.
 */
async function startDaemon(home: string): Promise<ChildProcess> {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // Linux puts the run folder under the runtime folder when one is set, outside the test's home.
  delete environment["XDG_RUNTIME_DIR"];
  const daemon = spawn(DAEMON_PROGRAM, [], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const written: string[] = [];
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: daemon.stderr! }).on("line", (line) => {
      written.push(line);
      if (line.includes(DAEMON_READY_LINE)) {
        resolve();
      }
    });
    daemon.once("error", reject);
    daemon.once("exit", (code, signal) => {
      reject(new Error(`The daemon ended (${String(code ?? signal)}):\n${written.join("\n")}`));
    });
  });
  return daemon;
}

/** Connects to the daemon on `home` through the addon, presenting the token file's token. */
async function connectOn(home: string): Promise<DaemonClient> {
  const ownHome = process.env["HOME"];
  const ownRuntimeFolder = process.env["XDG_RUNTIME_DIR"];
  process.env["HOME"] = home;
  delete process.env["XDG_RUNTIME_DIR"];
  try {
    const connected = await connect(true, () => {});
    expect(connected.error).toBeUndefined();
    return connected.client!;
  } finally {
    process.env["HOME"] = ownHome;
    if (ownRuntimeFolder !== undefined) {
      process.env["XDG_RUNTIME_DIR"] = ownRuntimeFolder;
    }
  }
}

// On Windows the run folder is the account's local application data folder, which no home the test
// chooses moves, so the test would reach the person's own daemon.
it.skipIf(process.platform === "win32")(
  "calls, subscribes and refuses params that break their contract in the wire's error shape",
  { timeout: DAEMON_START_BOUND_MS * 2 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "client-sdk-"));
    let daemon: ChildProcess | undefined;
    let client: DaemonClient | undefined;
    try {
      daemon = await startDaemon(home);
      client = await connectOn(home);

      const status = await client.call(1, "daemon.status.read", "{}", []);
      expect(status.error).toBeUndefined();
      expect(JSON.parse(status.reply!.json)).toMatchObject({
        processIdentity: { processId: daemon.pid },
      });

      const events: StreamEvent[] = [];
      const { promise: firstValue, resolve: takeFirstValue } = Promise.withResolvers<void>();
      const { promise: streamEnd, resolve: takeStreamEnd } = Promise.withResolvers<void>();
      const subscribed = await client.subscribe("daemon.retention.subscribe", "{}", [], (event) => {
        events.push(event);
        if (event.isEnd) {
          takeStreamEnd();
        } else {
          takeFirstValue();
        }
      });
      expect(subscribed.error).toBeUndefined();
      await firstValue;
      expect(JSON.parse(events[0]!.value!.json)).toStrictEqual({
        keepDiagnosticLogsDays: expect.any(Number),
        keepSessionsDays: expect.any(Number),
      });
      client.cancelStream(subscribed.streamId!);
      await streamEnd;
      expect(events.at(-1)).toMatchObject({ isEnd: true });
      expect(events.at(-1)?.error).toBeUndefined();

      const refused = await client.call(2, "daemon.status.read", "[]", []);
      expect(refused.reply).toBeUndefined();
      expect(refused.error).toStrictEqual({
        code: -32602,
        message: "The params of daemon.status.read break its contract",
        data: {
          type: "request.paramsInvalid",
          category: "invalidArgument",
          fields: { issues: [{ path: [], message: 'breaks the schema\'s "type" rule' }] },
        },
      });
    } finally {
      await client?.close();
      if (daemon !== undefined && daemon.exitCode === null) {
        const exited = once(daemon, "exit");
        daemon.kill("SIGTERM");
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);

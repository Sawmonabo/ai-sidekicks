// The daemon's start and stop in this process: a stop closes the socket before it drains the
// terminals, and still closes the database when a step before it fails; a start refuses a data
// folder another daemon holds, a socket another daemon answers on, a run folder other accounts can
// reach, and, before the bind, a socket path longer than the platform binds, while a path at that
// limit binds and answers a hello; a data folder other accounts could read becomes the person's
// alone; of two starts racing for one socket, the loser is refused and the token file holds the
// winner's token; a start that fails at the bind stops the session services it built and closes
// the search thread and the database, and one whose session services fail to load fails with what
// the load threw, never leaving it unhandled, and frees the data folder. A start releases the
// execution root of each run its recovery settles. A start that fails while its login shell runs
// ends the shell and fails at once.

import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import {
  DAEMON_STOP_TERMINAL_DRAIN_MS,
  DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
} from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  resolveDaemonRunFolder,
  type DaemonRunFolder,
} from "@ai-sidekicks/contracts/daemon/run-folder";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { RunIdSchema } from "@ai-sidekicks/contracts/run/id";

import { SecureDefaultsValidationError } from "../../bootstrap/secure-defaults.js";
import {
  closeDatabaseConnections,
  openDatabaseConnections,
} from "../../database/connection/lifecycle.js";
import { EventLogService } from "../../events/log-service.js";
import { SessionEventAppender } from "../../events/session/appender.js";
import { connect } from "../../ipc/__fixtures__/local-socket-client.js";
import { readSocketPathLimit } from "../../ipc/socket-path-limit.js";
import { seedSessionRow } from "../../session/directory/__fixtures__/directory-rows.js";
import { RunEngine } from "../../session/run/engine.js";
import { insertQueuedRunStatement } from "../../session/run/projection.js";
import {
  FIXTURE_SESSION_ID,
  insertExecutionContextCheckout,
} from "../../workflow/runs/__fixtures__/rows.js";
import { DaemonAlreadyRunningError } from "../already-running-error.js";
import { captureLoginShellEnvironment } from "../login-shell-environment.js";
import { DATABASE_FILE_NAME, DaemonProcess, type DaemonProcessOptions } from "../process.js";
import {
  DRAIN_NOTHING,
  EMPTY_DRAIN,
  homeDirectory,
  isSocketAnswering,
  runFolder,
  scratch,
  STARTED_AT,
  started,
  startDaemon,
  startSearchThread,
  useDaemonFolders,
  useSearchThreads,
  writeAheadLogPath,
} from "./process.test-support.js";

// A bind failure queued here fails the next server's listen the way the operating system would,
// with an `error` event on the listening server.
const bindFailures = vi.hoisted((): NodeJS.ErrnoException[] => []);
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const bindFailure = bindFailures.shift();
      if (bindFailure !== undefined) {
        server.listen = (() => {
          process.nextTick(() => server.emit("error", bindFailure));
          return server;
        }) as typeof server.listen;
      }
      return server;
    },
  };
});

// The session services this file's daemons have built and not yet stopped. A failure set here is
// what the session services' module throws when it next loads, which registering this mock again
// brings about.
const runningSessionServices = vi.hoisted(() => new Set<() => Promise<void>>());
const sessionMethodsLoad = vi.hoisted((): { failure: Promise<Error> | undefined } => ({
  failure: undefined,
}));
const mockSessionMethods = vi.hoisted(
  () => async (importOriginal: () => Promise<typeof import("../session-methods.js")>) => {
    if (sessionMethodsLoad.failure !== undefined) {
      throw await sessionMethodsLoad.failure;
    }
    const actual = await importOriginal();
    return {
      ...actual,
      registerSessionMethods: (...args: Parameters<typeof actual.registerSessionMethods>) => {
        const services = actual.registerSessionMethods(...args);
        const stop = async (): Promise<void> => {
          await services.stop();
          runningSessionServices.delete(stop);
        };
        runningSessionServices.add(stop);
        return { ...services, stop };
      },
    };
  },
);
vi.mock("../session-methods.js", mockSessionMethods);

// Makes the session services' module throw what `failure` resolves to when it next loads, until
// the returned function, or the end of the test, restores it.
function failSessionMethodsLoad(failure: Promise<Error>): () => void {
  const restore = (): void => {
    sessionMethodsLoad.failure = undefined;
    vi.doMock("../session-methods.js", mockSessionMethods);
  };
  sessionMethodsLoad.failure = failure;
  vi.doMock("../session-methods.js", mockSessionMethods);
  onTestFinished(restore);
  return restore;
}

useDaemonFolders();

describe("DaemonProcess.stop", () => {
  it("closes the socket, then drains every terminal, then closes the database", async () => {
    const drains: { options: unknown; wasSocketAnswering: boolean }[] = [];
    const daemon = await startDaemon({
      shutdown: async (options) => {
        drains.push({
          options,
          wasSocketAnswering: await isSocketAnswering(runFolder.socketPath),
        });
        return EMPTY_DRAIN;
      },
    });
    await access(writeAheadLogPath());

    await daemon.stop();

    expect(drains).toStrictEqual([
      {
        options: {
          perSessionTimeoutMs: DAEMON_STOP_TERMINAL_DRAIN_MS,
          hostTimeoutMs: DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
        },
        wasSocketAnswering: false,
      },
    ]);
    // The last connection's close checkpoints the log into the database and removes it.
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still closes the database when the terminal drain fails, and throws that failure", async () => {
    const drainFailure = new Error("the terminal host did not end");
    const daemon = await startDaemon({ shutdown: () => Promise.reject(drainFailure) });

    await expect(daemon.stop()).rejects.toBe(drainFailure);
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("DaemonProcess.start", () => {
  it("refuses a data folder another daemon holds, before it binds a socket of its own", async () => {
    await startDaemon(DRAIN_NOTHING);
    const otherRuntimeDirectory = path.join(scratch, "other-run");
    await mkdir(otherRuntimeDirectory, { mode: 0o700 });
    const otherRunFolder = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory: otherRuntimeDirectory,
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });

    const failure = await startDaemon(DRAIN_NOTHING, { runFolder: otherRunFolder }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(failure).toMatchObject({
      message: `Another daemon already holds the data folder ${path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME)}`,
    });
    await expect(lstat(otherRunFolder.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
  });

  it("refuses a socket another daemon answers on, and leaves that daemon serving", async () => {
    await startDaemon(DRAIN_NOTHING);
    const otherHomeDirectory = path.join(scratch, "other-home");
    await mkdir(otherHomeDirectory);

    await expect(
      startDaemon(DRAIN_NOTHING, { homeDirectory: otherHomeDirectory }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
  });

  it("refuses a run folder other accounts can reach", async () => {
    await mkdir(runFolder.folderPath, { mode: 0o700 });
    await chmod(runFolder.folderPath, 0o755);

    await expect(startDaemon(DRAIN_NOTHING)).rejects.toThrow("it must be 700");
  });

  it("stops the session services and closes the search thread and the database when the bind fails", async () => {
    const threads = useSearchThreads(startSearchThread);
    const runningBefore = runningSessionServices.size;
    bindFailures.push(Object.assign(new Error("address already in use"), { code: "EADDRINUSE" }));

    await expect(startDaemon(DRAIN_NOTHING)).rejects.toThrow(DaemonAlreadyRunningError);

    expect(runningSessionServices.size).toBe(runningBefore);
    await expect(threads[0]!.searchSessions({ query: "retry" })).rejects.toThrow(/closed/u);
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
    // The data folder is free again, so the next start takes it.
    await startDaemon(DRAIN_NOTHING);
  });

  it("fails with what the session services' load threw, never left unhandled, and closes the database and frees the data folder", async () => {
    // A rejection nothing handled would end the daemon before its start could clean up.
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", recordUnhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", recordUnhandled);
    });
    const loadFailure = new Error("A session service's module failed to load");
    const restoreSessionMethodsLoad = failSessionMethodsLoad(Promise.resolve(loadFailure));

    const failure = await startDaemon(DRAIN_NOTHING).catch((error: unknown) => error);
    restoreSessionMethodsLoad();

    // The test runner wraps what a mocked module throws, keeping it as the cause.
    expect(failure).toMatchObject({ cause: loadFailure });
    expect(unhandled).toStrictEqual([]);
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
    await startDaemon(DRAIN_NOTHING);
  });

  it("makes a data folder other accounts could read readable by the person alone", async () => {
    // The data folder holds the database, the settings and the service log.
    const dataFolder = path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME);
    await mkdir(dataFolder);
    await chmod(dataFolder, 0o755);

    await startDaemon(DRAIN_NOTHING);
    expect((await lstat(dataFolder)).mode & 0o777).toBe(0o700);
  });

  it("releases the execution root of each run its recovery settles", async () => {
    // A run left running by the last daemon, bound to a checkout its context still holds.
    const dataFolder = path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME);
    await mkdir(dataFolder, { mode: 0o700 });
    const databasePath = path.join(dataFolder, DATABASE_FILE_NAME);
    const database = await openDatabaseConnections({ databasePath, writeServiceLog: () => {} });
    const sessionEvents = new EventLogService({ ...database, writeServiceLog: () => {} });
    await seedSessionRow(database.writer, FIXTURE_SESSION_ID);
    const runId = RunIdSchema.parse(randomUUID());
    const queued = {
      sessionId: FIXTURE_SESSION_ID,
      runId,
      runVersion: 0,
      newState: "queued" as const,
    };
    await new SessionEventAppender(
      { sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    ).append("run.queued", queued, { transactionalPrelude: [insertQueuedRunStatement(queued)] });
    const lastEngine = new RunEngine({ reader: database.reader, sessionEvents });
    await lastEngine.transition({ runId, newState: "starting" });
    await lastEngine.transition({ runId, newState: "running" });
    const checkout = await insertExecutionContextCheckout(database.writer);
    await database.writer.write([
      {
        sql: `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
            execution_root, checkout_root, git_common_dir, branch_context_id, created_at)
          VALUES (?, ?, ?, 'bound-root', ?, ?, ?, ?, ?)`,
        bindings: [
          runId,
          FIXTURE_SESSION_ID,
          checkout.workspaceId,
          checkout.executionRoot,
          checkout.checkoutRoot,
          checkout.gitCommonDir,
          checkout.branchContextId,
          STARTED_AT,
        ],
      },
    ]);
    await closeDatabaseConnections(database);

    await startDaemon(DRAIN_NOTHING);

    const reader = new Database(databasePath, { readonly: true });
    onTestFinished(() => {
      reader.close();
    });
    expect(
      reader.prepare("SELECT released_at FROM run_execution_contexts WHERE run_id = ?").get(runId),
    ).toStrictEqual({ released_at: expect.any(String) });
  });
});

// A login shell that writes its process id, then sleeps past any wait a test has, captured the way
// a daemon captures one; `running` resolves with its process id once it runs.
async function useSleepingLoginShell(): Promise<{
  capture: DaemonProcessOptions["captureProviderBaseEnvironment"];
  running: Promise<number>;
  logged: string[];
  shellPath: string;
}> {
  const shellPath = path.join(scratch, "sleeping-shell");
  const processIdPath = path.join(scratch, "sleeping-shell.pid");
  await writeFile(shellPath, `#!/bin/sh\necho $$ > '${processIdPath}'\nexec sleep 60\n`, {
    mode: 0o700,
  });
  const running = vi.waitFor(
    async () => {
      const text = await readFile(processIdPath, "utf8");
      expect(text).toMatch(/^\d+\n$/u);
      return Number(text);
    },
    { timeout: 4_000 },
  );
  const logged: string[] = [];
  const capture = (signal: AbortSignal): ReturnType<typeof captureLoginShellEnvironment> =>
    captureLoginShellEnvironment({
      platform: process.platform,
      shell: shellPath,
      homeDirectory,
      userName: os.userInfo().username,
      readUserTempDirectory: () => Promise.resolve(os.tmpdir()),
      readWindowsDriveMounts: () => Promise.resolve([]),
      deadlineMs: 60_000,
      serviceEnvironment: process.env,
      writeServiceLog: (line) => logged.push(line),
      signal,
    });
  return { capture, running, logged, shellPath };
}

// The shell said why it was ended, and neither it nor anything it started is left running.
async function expectShellEnded(shell: Awaited<ReturnType<typeof useSleepingLoginShell>>) {
  expect(shell.logged).toContain(
    `The login shell (${shell.shellPath}) was ended, since the start failed.`,
  );
  const processId = await shell.running;
  await vi.waitFor(() => {
    expect(() => process.kill(processId, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
}

// Its login shell would sleep a minute, three times each test's bound, so a start that waited for
// the shell could never fail in time. The bound is wide because a loaded machine can take 3 s.
describe.skipIf(process.platform === "win32")(
  "a start that fails while its login shell runs",
  { timeout: 20_000 },
  () => {
    it("ends the shell and fails at once when the orphan sweep fails", async () => {
      const shell = await useSleepingLoginShell();
      const sweepFailure = new Error("The orphan registry could not be read");

      const failure = await startDaemon(DRAIN_NOTHING, {}, (options) =>
        DaemonProcess.start({
          ...options,
          captureProviderBaseEnvironment: shell.capture,
          openOrphanGuard: async () => {
            await shell.running;
            throw sweepFailure;
          },
        }),
      ).catch((error: unknown) => error);

      expect(failure).toBe(sweepFailure);
      await expectShellEnded(shell);
    });

    it("ends the shell and fails at once when the session services fail to load", async () => {
      const shell = await useSleepingLoginShell();
      const loadFailure = new Error("A session service's module failed to load");
      failSessionMethodsLoad(shell.running.then(() => loadFailure));

      const failure = await startDaemon(DRAIN_NOTHING, {}, (options) =>
        DaemonProcess.start({ ...options, captureProviderBaseEnvironment: shell.capture }),
      ).catch((error: unknown) => error);

      // The test runner wraps what a mocked module throws, keeping it as the cause.
      expect(failure).toMatchObject({ cause: loadFailure });
      await expectShellEnded(shell);
    });
  },
);

describe("the socket path's length", () => {
  // A run folder whose socket path is exactly `socketPathBytes` long.
  async function makeRunFolderWithSocketPathOf(socketPathBytes: number): Promise<DaemonRunFolder> {
    const shortest = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory: path.join(scratch, "r"),
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });
    const padding = socketPathBytes - Buffer.byteLength(shortest.socketPath, "utf8");
    const runtimeDirectory = path.join(scratch, "r".repeat(1 + padding));
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const sized = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory,
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });
    expect(Buffer.byteLength(sized.socketPath, "utf8")).toBe(socketPathBytes);
    return sized;
  }

  it.skipIf(process.platform === "win32")(
    "binds a path at the platform's own limit and answers a hello there",
    async () => {
      const atLimit = await makeRunFolderWithSocketPathOf(await readSocketPathLimit());
      await startDaemon(DRAIN_NOTHING, { runFolder: atLimit });

      const client = await connect(atLimit.socketPath);
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken: await readFile(atLimit.tokenPath, "utf8"),
        },
      });
      expect(await client.replies(1)).toMatchObject([{ id: 1, result: { compatible: true } }]);
      await client.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a path one byte over the limit before the bind, naming the limit and the length",
    async () => {
      const limit = await readSocketPathLimit();
      const overLimit = await makeRunFolderWithSocketPathOf(limit + 1);

      const failure = await startDaemon(DRAIN_NOTHING, { runFolder: overLimit }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(SecureDefaultsValidationError);
      expect(failure).toMatchObject({
        code: "invalid_local_ipc_path",
        message: expect.stringContaining(
          `is ${String(limit + 1)} bytes and the limit is ${String(limit)}`,
        ),
      });
      await expect(lstat(overLimit.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      // The platform's own bind refuses that path too, so the limit is the platform's.
      await expect(
        new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once("error", reject);
          server.listen(overLimit.socketPath, () => {
            server.close(resolve);
          });
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    },
  );
});

describe("the socket path's limit under a long TMPDIR", () => {
  it.skipIf(process.platform === "win32")(
    "measures the same limit, and a daemon starts, when TMPDIR alone is longer than the limit",
    async () => {
      const limit = await readSocketPathLimit();
      const temporaryDirectory = process.env["TMPDIR"];
      process.env["TMPDIR"] = path.join(scratch, "t".repeat(limit));
      try {
        // A fresh module graph, so neither the measurement nor the daemon reuses one taken earlier.
        vi.resetModules();
        const freshLimit = await import("../../ipc/socket-path-limit.js");
        expect(await freshLimit.readSocketPathLimit()).toBe(limit);
        const fresh = await import("../process.js");
        await startDaemon(DRAIN_NOTHING, {}, (options) => fresh.DaemonProcess.start(options));
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
      } finally {
        if (temporaryDirectory === undefined) {
          delete process.env["TMPDIR"];
        } else {
          process.env["TMPDIR"] = temporaryDirectory;
        }
      }
    },
  );
});

describe("two starts racing for the socket", () => {
  // Ten starts, each loading the database writer's and the search thread's workers from TypeScript
  // source, take up to about 7 s in CI's coverage run, so the bound is about twice that.
  it("leave the token file holding the token of the daemon that owns the socket", async () => {
    // Two data folders, so the data-folder lock lets both through and the bind decides.
    const homes = [path.join(scratch, "home-a"), path.join(scratch, "home-b")];
    for (const home of homes) {
      await mkdir(home);
    }
    // Each round starts over the previous round's token file, as a restart does.
    for (let round = 0; round < 5; round += 1) {
      const outcomes = await Promise.allSettled(
        homes.map((home) => startDaemon(DRAIN_NOTHING, { homeDirectory: home })),
      );
      const winners = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      expect(winners).toHaveLength(1);
      // The loser meets the winner at the run folder's check or at the bind; either is a refusal.
      expect(
        outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
      ).toStrictEqual([expect.any(DaemonAlreadyRunningError)]);

      const client = await connect(runFolder.socketPath);
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken: await readFile(runFolder.tokenPath, "utf8"),
        },
      });
      expect(await client.replies(1)).toMatchObject([{ id: 1, result: { compatible: true } }]);
      await client.close();

      await winners[0]!.stop();
      started.splice(started.indexOf(winners[0]!), 1);
    }
  }, 15_000);
});

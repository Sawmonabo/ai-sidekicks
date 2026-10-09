// The Codex services behind the driver: one process per credential home, the command line it
// starts with, the hook trust written before any conversation, a crashed service restarted with
// every conversation it held resumed, and the daemon's stop ending only the services it started.

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import {
  codexHomeFor,
  createHarness,
  createdSession,
  DEFAULT_CODEX_HOME,
  deliveriesOf,
  EXECUTABLE_PATH,
  launchedHookCommands,
  SECOND_ACCOUNT_ID,
  SECOND_CODEX_HOME,
  SECOND_SESSION_ID,
  SESSION_ID,
  THREAD_ID,
} from "../__fixtures__/app-server-doubles.js";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

const THIRD_SESSION_ID = "55555555-5555-4555-8555-555555555555" as SessionId;
const OWN_ACCOUNT_ID = "account-own";
const OWN_CODEX_HOME = "/homes/own";

describe("Codex services", () => {
  let scratch = "";
  let hookSocketPath = "";

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "codex-hooks-"));
    hookSocketPath = path.join(scratch, "hooks.sock");
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("serves one account's conversations on one process, and each account on its own", async () => {
    const harness = createHarness();

    await createdSession(harness);
    await createdSession(harness, { sessionId: SECOND_SESSION_ID });
    // A process per conversation would multiply memory and sign-in state by the session count.
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(1);
    expect(harness.server.framesForMethod("thread/start", DEFAULT_CODEX_HOME)).toHaveLength(2);

    await createdSession(harness, {
      sessionId: THIRD_SESSION_ID,
      providerAccountId: SECOND_ACCOUNT_ID,
    });
    // One shared process across accounts would bill one account's work to the other.
    expect(harness.server.launchCountFor(SECOND_CODEX_HOME)).toBe(1);
    expect(harness.server.framesForMethod("thread/start", SECOND_CODEX_HOME)).toHaveLength(1);
    expect(harness.server.runningProcessCount()).toBe(2);
  });

  it("starts each managed service with the listener and the shared switches", async () => {
    const harness = createHarness({ hookSocketPath });

    await createdSession(harness);

    const launch = harness.server.launches[0];
    // One command per event, each naming its event, so Codex lists and trusts both.
    const [preToolUse, postToolUse] = launchedHookCommands(harness.server);
    expect(preToolUse?.endsWith(`'${hookSocketPath}' 'PreToolUse'`)).toBe(true);
    expect(postToolUse?.endsWith(`'${hookSocketPath}' 'PostToolUse'`)).toBe(true);
    expect(launch?.command).toBe(EXECUTABLE_PATH);
    expect(launch?.args).toEqual([
      "app-server",
      "--listen",
      "unix://",
      "-c",
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",` +
        `command=${JSON.stringify(preToolUse)},` +
        `timeout=9223372036854775}]}]`,
      "-c",
      `hooks.PostToolUse=[{matcher="*",hooks=[{type="command",` +
        `command=${JSON.stringify(postToolUse)},` +
        `timeout=9223372036854775}]}]`,
      "-c",
      "features.code_mode.default_exec_yield_time_ms=9223372036854775000",
      "-c",
      "features.browser_use=false",
      "-c",
      "thread_unload_delay_secs=5",
      "-c",
      'model_auto_compact_token_limit_scope="total"',
    ]);
    // The account's own home, never the person's `~/.codex`.
    expect(launch?.environment).toContainEqual(["CODEX_HOME", DEFAULT_CODEX_HOME]);
  });

  it("trusts the daemon's hooks before the first conversation starts", async () => {
    const harness = createHarness({ hookSocketPath });

    await createdSession(harness);

    // An untrusted hook never runs, so a conversation started first would run with no pause.
    const trustIndex = harness.server.indexOfMethod("config/value/write");
    expect(trustIndex).toBeGreaterThan(-1);
    expect(trustIndex).toBeLessThan(harness.server.indexOfMethod("thread/start"));
    expect(harness.server.paramsFor("config/value/write")[0]).toEqual({
      keyPath: "hooks.state",
      value: { "hook-0": { trusted_hash: "hash-0" }, "hook-1": { trusted_hash: "hash-1" } },
      mergeStrategy: "upsert",
    });
  });

  it("restarts a service that crashed and resumes every conversation it held", async () => {
    const harness = createHarness();
    await createdSession(harness);
    await createdSession(harness, { sessionId: SECOND_SESSION_ID });

    harness.server.emitExit(DEFAULT_CODEX_HOME);
    await drainMicrotasks();
    // The first crash in the window restarts at once.
    expect(harness.scheduler.fireDelay(0)).toBe(1);
    await drainMicrotasks();

    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(2);
    expect(harness.server.paramsFor("thread/resume").map((params) => params["threadId"])).toEqual([
      THREAD_ID,
      "thread-2",
    ]);
    expect(harness.relaunched.map((relaunch) => relaunch.result.status)).toEqual([
      "resumed",
      "resumed",
    ]);
    // One line naming the account and every conversation, not one per conversation.
    const restarted = harness.driverDiagnostics.recentRecordsOfKind("provider_restarted");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.details).toMatchObject({
      codexHome: DEFAULT_CODEX_HOME,
      cause: "crash",
      conversations: `${THREAD_ID},thread-2`,
    });
  });

  it("stops restarting once the crash window filled, and tells each session", async () => {
    const harness = createHarness();
    await createdSession(harness);
    await createdSession(harness, { sessionId: SECOND_SESSION_ID });
    for (const restartAfterMs of [0, 1_000, 2_000, 4_000]) {
      harness.server.emitExit(DEFAULT_CODEX_HOME);
      await drainMicrotasks();
      expect(harness.scheduler.fireDelay(restartAfterMs)).toBe(1);
      await drainMicrotasks();
    }
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(5);

    harness.server.emitExit(DEFAULT_CODEX_HOME);
    await drainMicrotasks();
    harness.scheduler.fireAll();
    await drainMicrotasks();

    // A service that keeps dying is not started again until the person asks.
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(5);
    expect(
      deliveriesOf(harness, "session_notice")
        .filter((delivery) => delivery.notice.kind === "provider_crash_loop")
        .map((delivery) => delivery.notice.sessionId),
    ).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
    await expect(createdSession(harness, { sessionId: THIRD_SESSION_ID })).rejects.toThrow(
      "was not restarted",
    );
  });

  it("stops only the services it started when the daemon stops, and restarts none", async () => {
    const harness = createHarness({
      hookSocketPath,
      homes: {
        codexHomeFor: async (providerAccountId) =>
          providerAccountId === OWN_ACCOUNT_ID
            ? { codexHome: OWN_CODEX_HOME, providerAccountId, isManaged: false }
            : codexHomeFor(providerAccountId),
      },
    });
    harness.server.runOwnService(OWN_CODEX_HOME);
    await createdSession(harness);
    await createdSession(harness, {
      sessionId: SECOND_SESSION_ID,
      providerAccountId: OWN_ACCOUNT_ID,
    });

    await harness.driver.shutdown();
    await harness.driver.shutdown();
    await drainMicrotasks();

    // A service left running outlives the daemon; the person's own, stopped, ends their work.
    expect(harness.server.isServiceRunning(DEFAULT_CODEX_HOME)).toBe(false);
    expect(harness.server.isServiceRunning(OWN_CODEX_HOME)).toBe(true);
    // A deliberate stop: no crash restart, no turn ended as a crash, no failure reported.
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(1);
    expect(harness.endedTurns).toStrictEqual([]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "service-start-failed"),
    ).toStrictEqual([]);
    expect(harness.driverDiagnostics.recentRecordsOfKind("provider_crash_loop")).toStrictEqual([]);
    // The hook socket is gone, and nothing starts a service again.
    await expect(access(hookSocketPath)).rejects.toThrow();
    await expect(createdSession(harness, { sessionId: THIRD_SESSION_ID })).rejects.toThrow(
      "shut down with the daemon",
    );
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(1);
  });
});

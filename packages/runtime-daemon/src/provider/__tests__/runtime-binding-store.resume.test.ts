// What a resume is rebuilt from: the version recorded with a binding is the build that answered,
// read back out of the database, and the resume request re-supplies every spawn-bound leg from the
// row, since a resume is a fresh process spawn and a leg it shed would run unsandboxed; a binding
// with no resumable provider session refuses locally and classifiably.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import { HOST_OPERATING_SYSTEM } from "../../../tests/helpers/host-operating-system.js";
import { captureThrow } from "../../__fixtures__/capture-failure.js";
import type { CallbackToolResult } from "../driver/contract.js";
import {
  composeResumeSessionParams,
  RuntimeBindingNotResumableError,
  type RuntimeBindingSpawnConfig,
  withSpawnedVersionCarriers,
} from "../runtime-binding-store.js";
import {
  readSpawnedProviderVersion,
  resolveProviderExecutable,
  toBindingVersionCarriers,
  type ProviderVersionHandshakeRequest,
} from "../spawned-version.js";
import {
  CONTRACT_VERSION,
  DRIVER_NAME,
  EXECUTION_POSTURE,
  FULL_SPAWN_CONFIG,
  readRawSpawnConfig,
  RUN_ID,
  useBindingDatabase,
} from "./runtime-binding-store.test-support.js";

const database = useBindingDatabase();

describe("RuntimeBindingStore — spawned-version carriers", () => {
  // `spawned-version.test.ts` proves the reading is taken from the dereferenced build.
  // This proves that value is what a later reader gets back out of the database, through
  // `create()`'s report validation, the CLI-version DDL CHECK and the `spawn_config` parser, none
  // of which the in-memory projection helpers exercise: the version recorded and the version run
  // are one reading.
  const LAUNCHER_PATH: string = "/opt/homebrew/bin/claude";
  const DEREFERENCED_BUILD_PATH: string = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";

  // Keyed by resolved path. The launcher answers a different build's version, so a resolver
  // that failed to dereference would record the wrong one; every assertion also witnesses which
  // process was asked.
  const REPORTED_VERSION_BY_PATH: ReadonlyMap<string, string> = new Map([
    [LAUNCHER_PATH, "2.1.198"],
    [DEREFERENCED_BUILD_PATH, "2.1.245"],
  ]);

  async function claudeHandshake(request: ProviderVersionHandshakeRequest): Promise<unknown> {
    const reportedVersion: string | undefined = REPORTED_VERSION_BY_PATH.get(
      request.executable.resolvedExecutablePath,
    );
    if (reportedVersion === undefined) {
      throw new Error(`no fixture build installed at ${request.executable.resolvedExecutablePath}`);
    }
    return { version: reportedVersion, buildTime: "2026-08-20T00:00:00Z" };
  }

  // Injected rather than filesystem-backed: drift is "realpath answers a different path than
  // the candidate", which runs on every platform (the real-symlink fixture in
  // `spawned-version.test.ts` is posix-only).
  const DRIFTING_RESOLVER = {
    operatingSystem: HOST_OPERATING_SYSTEM.provider,
    isExecutableFile: async (): Promise<boolean> => true,
    realpath: async (candidate: string): Promise<string> =>
      candidate === LAUNCHER_PATH ? DEREFERENCED_BUILD_PATH : candidate,
  };

  it("records the BUILD's version and path under launcher drift", async () => {
    const reading = await readSpawnedProviderVersion({
      driverName: "claude",
      resolveCommand: async (spawnEnvironment) =>
        await resolveProviderExecutable(
          "claude",
          LAUNCHER_PATH,
          spawnEnvironment,
          DRIFTING_RESOLVER,
        ),
      handshake: claudeHandshake,
      environmentNameMatch: "case-sensitive",
      baseEnv: [],
    });

    const store = database.makeStore();
    const created = await store.create(
      withSpawnedVersionCarriers(
        {
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: CONTRACT_VERSION,
          spawnConfig: {},
        },
        toBindingVersionCarriers(reading),
      ),
    );

    // Read back out of the database: the persisted row is the claim, not `create()`'s return.
    const found = store.findById(created.id);
    expect(found?.cliVersion).toStrictEqual({ rawVersion: "2.1.245", parsedVersion: "2.1.245" });
    expect(found?.spawnConfig.resolvedExecutablePath).toBe(DEREFERENCED_BUILD_PATH);
    // The launcher's build appears nowhere in the row, neither in the version pair nor in the
    // spawn-bound record.
    expect(JSON.stringify(found)).not.toContain("2.1.198");
  });
});

describe("composeResumeSessionParams", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
  const SESSION_MODEL = "claude-sonnet-4-5";
  const SESSION_LARGER_WINDOW = 1_000_000;
  const NO_FUNCTION_LEGS = {
    onCallbackToolCall: undefined,
    onMcpServerStatus: undefined,
  };

  it("re-realizes every spawn-bound leg from the durable row at the session's level, never the recorded executable", async () => {
    const store = database.makeStore();
    const binding = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });

    const params = composeResumeSessionParams(
      SESSION_ID,
      binding,
      SESSION_MODEL,
      SESSION_LARGER_WINDOW,
      "build",
      { ...EXECUTION_POSTURE, mode: "reviewed" },
      NO_FUNCTION_LEGS,
    );

    // Strict, so the recorded executable path cannot ride along: every start resolves it again. The
    // session's posture outranks the one the binding recorded at its start.
    expect(params).toStrictEqual({
      sessionId: SESSION_ID,
      resumeHandle: "opaque-handle-abc",
      model: SESSION_MODEL,
      largerWindow: SESSION_LARGER_WINDOW,
      mode: "build",
      executionPosture: { ...EXECUTION_POSTURE, mode: "reviewed" },
      callbackTools: FULL_SPAWN_CONFIG.callbackTools,
      subagentPolicy: FULL_SPAWN_CONFIG.subagentPolicy,
      toolServers: FULL_SPAWN_CONFIG.toolServers,
      outputSchema: FULL_SPAWN_CONFIG.outputSchema,
      providerAccountId: FULL_SPAWN_CONFIG.providerAccountId,
      outputSpeed: "on",
      onCallbackToolCall: undefined,
      onMcpServerStatus: undefined,
    });
  });

  it("stores a NO-IDENTIFIER create without any account key, byte for byte", async () => {
    // With no identifier the stored bytes carry no account member at all, so nothing downstream
    // can read an unbound account as bound-but-empty.
    const store = database.makeStore();
    const unboundSpawnConfig: RuntimeBindingSpawnConfig = {
      executionPosture: EXECUTION_POSTURE,
    };
    const binding = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: unboundSpawnConfig,
      resumeHandle: "opaque-handle-abc",
    });

    expect(readRawSpawnConfig(database.connection(), binding.id)).toBe(
      JSON.stringify(unboundSpawnConfig),
    );
    expect(readRawSpawnConfig(database.connection(), binding.id)).not.toContain(
      "providerAccountId",
    );
    expect(binding.spawnConfig.providerAccountId).toBeUndefined();
    expect(
      composeResumeSessionParams(
        SESSION_ID,
        binding,
        SESSION_MODEL,
        SESSION_LARGER_WINDOW,
        "build",
        EXECUTION_POSTURE,
        NO_FUNCTION_LEGS,
      ).providerAccountId,
    ).toBeUndefined();
  });

  it("binds the injected function legs, which no row can carry", async () => {
    const store = database.makeStore();
    const binding = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });
    const onCallbackToolCall = async (): Promise<CallbackToolResult> =>
      await Promise.resolve({ status: "completed" });

    const params = composeResumeSessionParams(
      SESSION_ID,
      binding,
      SESSION_MODEL,
      SESSION_LARGER_WINDOW,
      "build",
      EXECUTION_POSTURE,
      { onCallbackToolCall, onMcpServerStatus: undefined },
    );

    expect(params.onCallbackToolCall).toBe(onCallbackToolCall);
  });

  it("refuses a binding with no resume handle, typed for the recovery dispatcher", async () => {
    // The dispatcher must relaunch fresh rather than retry, and cannot decide that from a
    // message string.
    const store = database.makeStore();
    const binding = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    const thrown = captureThrow(() => {
      composeResumeSessionParams(
        SESSION_ID,
        binding,
        SESSION_MODEL,
        SESSION_LARGER_WINDOW,
        "build",
        EXECUTION_POSTURE,
        NO_FUNCTION_LEGS,
      );
    });

    expect(thrown).toBeInstanceOf(RuntimeBindingNotResumableError);
    expect((thrown as RuntimeBindingNotResumableError).runId).toBe(RUN_ID);
    expect((thrown as RuntimeBindingNotResumableError).bindingId).toBe(binding.id);
  });
});

// The runtime binding store over real SQLite: the row recovery resumes from round-trips, the
// provider's contract version and resume handle are bounded before they land, the batch lookup
// returns superseded rows too, a corrupt spawn-bound record fails loud instead of resuming
// unsandboxed, so does a stored driver name that names no provider, the version pair holds its
// CHECK and records the build that answered, and the resume request is rebuilt from the row.

import { DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/methods";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureThrow } from "../../__fixtures__/capture-failure.js";
import { openDatabase } from "../../session/migration-runner.js";
import { makeAdvancingClock } from "../__fixtures__/advancing-clock.js";
import { ProviderOutputValidationError, RESUME_HANDLE_MAX_LEN } from "../output-validation.js";
import {
  composeResumeSessionParams,
  RuntimeBindingNotResumableError,
  RuntimeBindingStore,
  type RuntimeBindingSpawnConfig,
  withSpawnedVersionCarriers,
} from "../runtime-binding-store.js";
import {
  readSpawnedProviderVersion,
  toBindingVersionCarriers,
  type ProviderVersionHandshakeRequest,
} from "../spawned-provider-version.js";
import type { CallbackToolResult, DriverCliVersionReport } from "../driver/provider-driver.js";

const RUN_ID: string = "run-01J0ND0000NN5J5J5J5J5J5J";
const OTHER_RUN_ID: string = "run-01J0ND0000NN5K5K5K5K5K5K";
const DRIVER_NAME: ProviderName = "claude";
const CONTRACT_VERSION: string = "1.2.3";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

function makeIdSource(): () => string {
  let counter: number = 0;
  return () => `binding-${(counter++).toString()}`;
}

function makeStore(now: () => string = makeAdvancingClock()): RuntimeBindingStore {
  return new RuntimeBindingStore(db, { now, newId: makeIdSource() });
}

// A fully-populated spawn-bound record: every member of the closed key set, shaped as real
// contract values.
const EXECUTION_POSTURE: ExecutionPosture = {
  writableRoots: ["/workspace/repo"],
  mode: "sandboxed",
  credentialPolicyRef: "policy://default",
};

const FULL_SPAWN_CONFIG: RuntimeBindingSpawnConfig = {
  executionPosture: EXECUTION_POSTURE,
  callbackTools: [
    { name: "ask_human", description: "Ask the person", inputSchema: { type: "object" } },
  ],
  subagentPolicy: { enabled: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  providerAccountId: "acct-01J0ND0000NN5J5J5J5J5J5J",
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  outputSpeed: "on",
};

const CLI_VERSION: DriverCliVersionReport = {
  rawVersion: "2.1.245 (Claude Code)",
  parsedVersion: "2.1.245",
};

// Direct-SQL insert that bypasses the write seam: the only way to stage a corrupt
// `spawn_config` or `driver_name`, or a CLI-version parse with no printed version.
function insertRawBinding(overrides: {
  id?: string;
  driverName?: string;
  spawnConfig?: string;
  cliVersionRaw?: string | null;
  cliVersionSemver?: string | null;
}): string {
  const id: string = overrides.id ?? "raw-binding-0";
  db.prepare(
    `INSERT INTO runtime_bindings
       (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, ` +
      `resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
     VALUES
       (@id, @run_id, @driver_name, @contract_version, @cli_version_raw, @cli_version_semver, ` +
      `NULL, @spawn_config, '{}', @created_at, @created_at)`,
  ).run({
    id,
    run_id: RUN_ID,
    driver_name: overrides.driverName ?? DRIVER_NAME,
    contract_version: CONTRACT_VERSION,
    cli_version_raw: overrides.cliVersionRaw ?? null,
    cli_version_semver: overrides.cliVersionSemver ?? null,
    spawn_config: overrides.spawnConfig ?? "{}",
    created_at: "2026-06-02T12:00:00.000Z",
  });
  return id;
}

// Corrupts a landed row's `spawn_config`. Both write seams parse before committing, so this is
// the only way to get a durable, unreadable record.
function corruptSpawnConfigOutOfBand(id: string, rawSpawnConfig: string): void {
  const info = db
    .prepare(`UPDATE runtime_bindings SET spawn_config = ? WHERE id = ?`)
    .run(rawSpawnConfig, id);
  if (info.changes !== 1) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
}

// Raw column reads: the store's accessors parse, so what actually landed needs a read that
// bypasses them.
function readRawSpawnConfig(id: string): string {
  const row = db.prepare(`SELECT spawn_config FROM runtime_bindings WHERE id = ?`).get(id) as
    | { spawn_config: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
  return row.spawn_config;
}

function readRawCliVersion(id: string): {
  cli_version_raw: string | null;
  cli_version_semver: string | null;
} {
  const row = db
    .prepare(`SELECT cli_version_raw, cli_version_semver FROM runtime_bindings WHERE id = ?`)
    .get(id) as { cli_version_raw: string | null; cli_version_semver: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
  return row;
}

// Reads the mutable columns raw: the store's accessors refuse a corrupt row, so they cannot
// show what a refused transaction left behind.
function readRawMutableColumns(id: string): {
  contract_version: string;
  resume_handle: string | null;
  runtime_metadata: string;
  updated_at: string;
} {
  const row = db
    .prepare(
      `SELECT contract_version, resume_handle, runtime_metadata, updated_at
         FROM runtime_bindings WHERE id = ?`,
    )
    .get(id) as
    | {
        contract_version: string;
        resume_handle: string | null;
        runtime_metadata: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
  return row;
}

function countBindings(): number {
  const row = db.prepare(`SELECT count(*) AS total FROM runtime_bindings`).get() as {
    total: number;
  };
  return row.total;
}

describe("RuntimeBindingStore — CRUD round-trips", () => {
  it("create → findById round-trips every column", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: "opaque-handle-abc",
      runtimeMetadata: { sessionRef: "s-1", nested: { count: 3 } },
    });

    expect(created.id).toBe("binding-0");
    expect(created.runId).toBe(RUN_ID);
    expect(created.driverName).toBe(DRIVER_NAME);
    expect(created.contractVersion).toBe(CONTRACT_VERSION);
    expect(created.resumeHandle).toBe("opaque-handle-abc");
    expect(created.runtimeMetadata).toEqual({ sessionRef: "s-1", nested: { count: 3 } });
    expect(created.createdAt).toBe(created.updatedAt);

    const found = store.findById(created.id);
    expect(found).toEqual(created);
  });

  it("findByRun returns ALL bindings for a run (1:many)", () => {
    const store = makeStore();
    const first = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
    });
    const second = store.create({
      runId: RUN_ID,
      driverName: "codex",
      contractVersion: "2.0.0",
      spawnConfig: {},
    });
    // A binding on a DIFFERENT run must not appear.
    store.create({
      runId: OTHER_RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    const forRun = store.findByRun(RUN_ID);
    expect(forRun).toHaveLength(2);
    expect(forRun.map((binding) => binding.id)).toEqual([first.id, second.id]);
  });

  it("update mutates the patched fields, bumps updatedAt, preserves createdAt", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      runtimeMetadata: { a: 1 },
    });

    const updated = store.update(created.id, {
      contractVersion: "1.1.0",
      runtimeMetadata: { a: 2, b: 3 },
    });

    expect(updated).toBeDefined();
    expect(updated?.contractVersion).toBe("1.1.0");
    expect(updated?.runtimeMetadata).toEqual({ a: 2, b: 3 });
    expect(updated?.id).toBe(created.id);
    expect(updated?.runId).toBe(created.runId);
    expect(updated?.driverName).toBe(created.driverName);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
    expect(updated?.updatedAt).not.toBe(updated?.createdAt);

    expect(store.findById(created.id)).toEqual(updated);
  });

  it("update can clear resumeHandle to null (COALESCE-binding would silently no-op)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "present-handle",
    });

    const cleared = store.update(created.id, { resumeHandle: null });
    expect(cleared?.resumeHandle).toBeNull();
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("update leaves absent patch keys untouched", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "keep-me",
      runtimeMetadata: { keep: true },
    });

    const updated = store.update(created.id, { contractVersion: "1.0.1" });
    expect(updated?.contractVersion).toBe("1.0.1");
    expect(updated?.resumeHandle).toBe("keep-me");
    expect(updated?.runtimeMetadata).toEqual({ keep: true });
  });
});

describe("RuntimeBindingStore — contract_version is canonical semver and length-bounded", () => {
  it("rejects a contract_version one character over its cap", () => {
    const overVersion: string = "1.0.0-" + "a".repeat(DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN - 6 + 1);
    expect(overVersion.length).toBe(DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN + 1);

    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: overVersion,
        spawnConfig: {},
      }),
    ).toThrow(ProviderOutputValidationError);
  });

  const rejectedVersions: string[] = [
    "1.0",
    "1",
    "01.2.3",
    "v1.2.3",
    " 1.2.3 ",
    "1.2.3+build.5",
    "",
  ];

  for (const version of rejectedVersions) {
    it(`rejects non-canonical / loose / malformed ${JSON.stringify(version)}`, () => {
      const store = makeStore();
      const thrown = captureThrow(() => {
        store.create({
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: version,
          spawnConfig: {},
        });
      });
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      const validationError = thrown as ProviderOutputValidationError;
      expect(validationError.fields?.["field"]).toBe("contract_version");
    });
  }
});

describe("RuntimeBindingStore — resume_handle", () => {
  it("rejects a RESUME_HANDLE_MAX_LEN+1-length resume_handle", () => {
    const overHandle: string = "h".repeat(RESUME_HANDLE_MAX_LEN + 1);
    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        spawnConfig: {},
        resumeHandle: overHandle,
      }),
    ).toThrow(ProviderOutputValidationError);
  });

  it("rejects a whitespace-only resume_handle (the /\\S/ hardening beyond the DB CHECK)", () => {
    const store = makeStore();
    const thrown = captureThrow(() => {
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        spawnConfig: {},
        resumeHandle: "   ",
      });
    });
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("resume_handle");
  });

  it("rejects a NUL-containing resume_handle", () => {
    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        spawnConfig: {},
        resumeHandle: "before\0after",
      }),
    ).toThrow(ProviderOutputValidationError);
  });
});

describe("RuntimeBindingStore — findResumableBindings", () => {
  it("returns only bindings with a non-null resume_handle", () => {
    const store = makeStore();
    const withHandle = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: "resumable-1",
    });
    // No handle: must not appear.
    store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    const otherWithHandle = store.create({
      runId: OTHER_RUN_ID,
      driverName: "codex",
      contractVersion: "2.0.0",
      spawnConfig: {},
      resumeHandle: "resumable-2",
    });

    const resumable = store.findResumableBindings();
    expect(resumable.map((binding) => binding.id).sort()).toEqual(
      [withHandle.id, otherWithHandle.id].sort(),
    );
    expect(resumable.every((binding) => binding.resumeHandle !== null)).toBe(true);
  });
});

describe("RuntimeBindingStore — update revalidation", () => {
  it("rejects an update to a non-canonical contract_version and leaves the row unchanged", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "h",
    });

    expect(() => store.update(created.id, { contractVersion: "1.0" })).toThrow(
      ProviderOutputValidationError,
    );

    // Validation runs before the transaction, so the row is untouched.
    const after = store.findById(created.id);
    expect(after?.contractVersion).toBe("1.0.0");
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it("rejects an update to an invalid resume_handle and leaves the row unchanged", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "original",
    });

    expect(() => store.update(created.id, { resumeHandle: "   " })).toThrow(
      ProviderOutputValidationError,
    );

    const after = store.findById(created.id);
    expect(after?.resumeHandle).toBe("original");
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it(
    "REFUSES an update onto a row whose stored " +
      "spawn_config is unreadable, and commits NOTHING",
    () => {
      // Committing a patch onto an unreadable record would make it newer, still unreadable, and
      // stamped with an `updated_at` implying this daemon wrote it, hiding the corruption from
      // the recovery read. So the parse runs inside the transaction before the UPDATE, and its
      // throw rolls everything back.
      const store = makeStore();
      const created = store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: "1.0.0",
        resumeHandle: "handle-before",
        spawnConfig: FULL_SPAWN_CONFIG,
        runtimeMetadata: { attempt: 1 },
      });
      corruptSpawnConfigOutOfBand(created.id, "{not json at all");

      const thrown = captureThrow(() => {
        store.update(created.id, { contractVersion: "1.0.1", resumeHandle: "handle-after" });
      });

      // A plain internal-invariant Error naming the row: corrupt daemon-written storage, not
      // provider input.
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
      expect((thrown as Error).message).toContain(created.id);
      expect((thrown as Error).message).toContain("spawn_config");

      // Read raw: the store's accessors refuse this row and could not tell "rolled back" from
      // "unreadable".
      const raw = readRawMutableColumns(created.id);
      expect(raw.contract_version).toBe("1.0.0");
      expect(raw.resume_handle).toBe("handle-before");
      expect(raw.runtime_metadata).toBe(JSON.stringify({ attempt: 1 }));
      // `updated_at` is the sharpest witness: an UPDATE that reached the DB would have moved it
      // from the advancing clock even if the other columns matched.
      expect(raw.updated_at).toBe(created.updatedAt);
      expect(readRawSpawnConfig(created.id)).toBe("{not json at all");
    },
  );
});

describe("RuntimeBindingStore — findByRuns (batch lookup)", () => {
  it("agrees with findByRun for a single run id", () => {
    const store = makeStore();
    store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    store.create({
      runId: OTHER_RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    expect(store.findByRuns([RUN_ID])).toEqual(store.findByRun(RUN_ID));
  });

  it("returns SUPERSEDED pre-relaunch bindings alongside the current one", () => {
    // A relaunch mints a new binding row and retains the old one as history. The store has no
    // liveness column, so both come back and the caller owns the liveness intersection.
    const store = makeStore();
    const beforeRelaunch = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "handle-before-relaunch",
      spawnConfig: { resolvedExecutablePath: "/opt/homebrew/bin/claude" },
    });
    const afterRelaunch = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "handle-after-relaunch",
      spawnConfig: { resolvedExecutablePath: "/opt/homebrew/bin/claude" },
    });

    const found = store.findByRuns([RUN_ID]);
    expect(found.map((binding) => binding.id)).toEqual([beforeRelaunch.id, afterRelaunch.id]);
  });
});

describe("RuntimeBindingStore — spawn_config", () => {
  it("round-trips the FULL spawn-bound record on create and on read", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    // `toStrictEqual`, so a member the parser silently dropped to `undefined` cannot pass.
    expect(created.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
    expect(store.findById(created.id)?.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
    // The batch reader parses it identically (one `#rowToDomain` serves every read path).
    expect(store.findByRuns([RUN_ID])[0]?.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
  });

  const malformed: { label: string; raw: string }[] = [
    { label: "unparseable JSON", raw: "{not json at all" },
    { label: "JSON null", raw: "null" },
    { label: "an unknown member", raw: '{"executionPostures":{"mode":"yolo"}}' },
    { label: "a string where an object belongs", raw: '{"executionPosture":"yolo"}' },
    { label: "an object where an array belongs", raw: '{"callbackTools":{}}' },
    { label: "a number where a string belongs", raw: '{"resolvedExecutablePath":42}' },
    { label: "a null-valued known member", raw: '{"providerAccountId":null}' },
  ];

  for (const { label, raw } of malformed) {
    it(`FAILS LOUD on ${label} in the stored column`, () => {
      // Loud failure is a security property: the resume assembly rebuilds
      // `ResumeSessionParams` from this record, and a silently empty posture would resume
      // unsandboxed.
      const store = makeStore();
      const rawId = insertRawBinding({ id: "corrupt-row-1", spawnConfig: raw });

      const thrown = captureThrow(() => {
        store.findById(rawId);
      });

      expect(thrown).toBeInstanceOf(Error);
      // A plain internal-invariant Error, not the provider-output type: this is daemon-written
      // local state, so a malformation is corrupt storage.
      expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
      // The row is named, so the person can find the corrupt record.
      expect((thrown as Error).message).toContain(rawId);
      expect((thrown as Error).message).toContain("spawn_config");
    });
  }
});

describe("RuntimeBindingStore — driver_name", () => {
  it("FAILS LOUD on a stored driver_name that names no provider", () => {
    // The write seam is typed, so only out-of-band corruption lands here; a cast would hand
    // recovery a name no driver answers to.
    const store = makeStore();
    const rawId = insertRawBinding({ id: "corrupt-driver-1", driverName: "gemini" });

    const thrown = captureThrow(() => {
      store.findById(rawId);
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).toContain(rawId);
    expect((thrown as Error).message).toContain("driver_name");
  });
});

describe("RuntimeBindingStore — cliVersion pair", () => {
  it("round-trips the pair and stores BOTH columns", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      cliVersion: CLI_VERSION,
      spawnConfig: {},
    });

    expect(created.cliVersion).toStrictEqual(CLI_VERSION);
    expect(store.findById(created.id)?.cliVersion).toStrictEqual(CLI_VERSION);
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: CLI_VERSION.rawVersion,
      cli_version_semver: CLI_VERSION.parsedVersion,
    });
  });

  it("keeps an unparsed printed version; refuses a parse with no printed version", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      cliVersion: { rawVersion: "Claude Code (unknown build)" },
      spawnConfig: {},
    });
    expect(store.findById(created.id)?.cliVersion).toStrictEqual({
      rawVersion: "Claude Code (unknown build)",
    });
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: "Claude Code (unknown build)",
      cli_version_semver: null,
    });

    // The seam cannot express a parse without its printed version, so only SQL can stage one.
    expect(() =>
      insertRawBinding({ id: "parse-only", cliVersionRaw: null, cliVersionSemver: "2.1.245" }),
    ).toThrow(/CHECK constraint failed/);
    expect(countBindings()).toBe(1);
  });

  it("the two-column CHECK survives an UPDATE that names neither column", () => {
    // SQLite re-evaluates every CHECK on a row for every write to it, so the update path must
    // carry the pair through untouched.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      cliVersion: CLI_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    const updated = store.update(created.id, { contractVersion: "1.0.1" });

    expect(updated?.contractVersion).toBe("1.0.1");
    // Spawn-scoped provenance is immutable and survives the patch.
    expect(updated?.cliVersion).toStrictEqual(CLI_VERSION);
    expect(updated?.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
    expect(store.findById(created.id)?.cliVersion).toStrictEqual(CLI_VERSION);
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: CLI_VERSION.rawVersion,
      cli_version_semver: CLI_VERSION.parsedVersion,
    });
  });
});

// Resume is a fresh process spawn, so each spawn-bound leg must be re-supplied from the row or
// the relaunch sheds it; a posture-less resume would run unsandboxed. A binding with no
// resumable provider session refuses locally and classifiably instead of pushing an empty
// handle at the provider.

describe("RuntimeBindingStore — spawned-version carriers", () => {
  // `spawned-provider-version.test.ts` proves the reading is taken from the dereferenced build.
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
      request.resolvedExecutablePath,
    );
    if (reportedVersion === undefined) {
      throw new Error(`no fixture build installed at ${request.resolvedExecutablePath}`);
    }
    return { version: reportedVersion, buildTime: "2026-08-20T00:00:00Z" };
  }

  // Injected rather than filesystem-backed: drift is "realpath answers a different path than
  // the candidate", which runs on every platform (the real-symlink fixture in
  // `spawned-provider-version.test.ts` is posix-only).
  const DRIFTING_RESOLVER = {
    isExecutableFile: async (): Promise<boolean> => true,
    realpath: async (candidate: string): Promise<string> =>
      candidate === LAUNCHER_PATH ? DEREFERENCED_BUILD_PATH : candidate,
  };

  it("records the BUILD's version and path under launcher drift", async () => {
    const reading = await readSpawnedProviderVersion({
      driverName: "claude",
      requestedCommand: LAUNCHER_PATH,
      handshake: claudeHandshake,
      baseEnv: [],
      resolver: DRIFTING_RESOLVER,
    });

    const store = makeStore();
    const created = store.create(
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
  const NO_FUNCTION_LEGS = {
    onCallbackToolCall: undefined,
    onMcpServerStatus: undefined,
  };

  it("re-realizes every spawn-bound leg from the durable row", () => {
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });

    const params = composeResumeSessionParams(SESSION_ID, binding, SESSION_MODEL, NO_FUNCTION_LEGS);

    expect(params).toStrictEqual({
      sessionId: SESSION_ID,
      resumeHandle: "opaque-handle-abc",
      model: SESSION_MODEL,
      executionPosture: EXECUTION_POSTURE,
      callbackTools: FULL_SPAWN_CONFIG.callbackTools,
      subagentPolicy: FULL_SPAWN_CONFIG.subagentPolicy,
      outputSchema: FULL_SPAWN_CONFIG.outputSchema,
      providerAccountId: FULL_SPAWN_CONFIG.providerAccountId,
      outputSpeed: "on",
      onCallbackToolCall: undefined,
      onMcpServerStatus: undefined,
    });
  });

  it("stores a NO-IDENTIFIER create without any account key, byte for byte", () => {
    // With no identifier the stored bytes carry no account member at all, so nothing downstream
    // can read an unbound account as bound-but-empty.
    const store = makeStore();
    const unboundSpawnConfig: RuntimeBindingSpawnConfig = {
      executionPosture: EXECUTION_POSTURE,
    };
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: unboundSpawnConfig,
      resumeHandle: "opaque-handle-abc",
    });

    expect(readRawSpawnConfig(binding.id)).toBe(JSON.stringify(unboundSpawnConfig));
    expect(readRawSpawnConfig(binding.id)).not.toContain("providerAccountId");
    expect(binding.spawnConfig.providerAccountId).toBeUndefined();
    expect(
      composeResumeSessionParams(SESSION_ID, binding, SESSION_MODEL, NO_FUNCTION_LEGS)
        .providerAccountId,
    ).toBeUndefined();
  });

  it("binds the injected function legs, which no row can carry", () => {
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });
    const onCallbackToolCall = async (): Promise<CallbackToolResult> =>
      await Promise.resolve({ status: "completed" });

    const params = composeResumeSessionParams(SESSION_ID, binding, SESSION_MODEL, {
      onCallbackToolCall,
      onMcpServerStatus: undefined,
    });

    expect(params.onCallbackToolCall).toBe(onCallbackToolCall);
  });

  it("refuses a binding with no resume handle, typed for the recovery dispatcher", () => {
    // The dispatcher must relaunch fresh rather than retry, and cannot decide that from a
    // message string.
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    const thrown = captureThrow(() => {
      composeResumeSessionParams(SESSION_ID, binding, SESSION_MODEL, NO_FUNCTION_LEGS);
    });

    expect(thrown).toBeInstanceOf(RuntimeBindingNotResumableError);
    expect((thrown as RuntimeBindingNotResumableError).runId).toBe(RUN_ID);
    expect((thrown as RuntimeBindingNotResumableError).bindingId).toBe(binding.id);
  });
});

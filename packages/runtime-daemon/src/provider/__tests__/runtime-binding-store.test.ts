/**
 * Tests for `RuntimeBindingStore` over a real in-memory SQLite handle, so both the Zod
 * write-seam checks and the DDL CHECK constraints fire end to end. Each test opens a fresh
 * database.
 *
 * - Boundary fixtures derive from the exported length constants and go through a real INSERT,
 *   so a constant raised above its SQL CHECK literal fails here.
 * - `spawn_config` is written at every create and read back through a closed-key-set parser.
 *   A malformed record fails loudly, on the read paths and on `update()`, because a silently
 *   empty posture would relaunch unsandboxed.
 * - `cli_version_raw` / `cli_version_semver` are a pair: the DDL CHECK requires both or
 *   neither, an invalid report is refused as a typed error before any row lands, and a
 *   half-present row staged out of band reads back as `null`.
 * - The reading taken from the dereferenced build reaches the stored row under launcher drift.
 * - `findByRuns` is synchronous, order-deterministic and duplicate-tolerant, and returns
 *   superseded history unfiltered; the caller owns the liveness intersection.
 */

import type {
  CallbackToolResult,
  DriverCliVersionReport,
  ExecutionPosture,
  SessionId,
} from "@ai-sidekicks/contracts";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import {
  assertValidCliVersionReport,
  CLI_VERSION_RAW_MAX_LEN,
  CLI_VERSION_SEMVER_MAX_LEN,
  CONTRACT_VERSION_MAX_LEN,
  ProviderOutputValidationError,
  RESUME_HANDLE_MAX_LEN,
} from "../provider-output-validation.js";
import {
  composeResumeSessionParams,
  RuntimeBindingNotResumableError,
  RuntimeBindingStore,
  type RuntimeBindingSpawnConfig,
  withSpawnedVersionCarriers,
} from "../runtime-binding-store.js";
import {
  type ProviderVersionHandshakeRequest,
  readSpawnedProviderVersion,
  toBindingVersionCarriers,
} from "../version-gate.js";

const RUN_ID: string = "run-01J0ND0000NN5J5J5J5J5J5J";
const OTHER_RUN_ID: string = "run-01J0ND0000NN5K5K5K5K5K5K";
const DRIVER_NAME: string = "claude";
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

// An advancing clock: each call returns a distinct timestamp, so "createdAt preserved while
// updatedAt bumped" cannot pass vacuously.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

function makeIdSource(): () => string {
  let counter: number = 0;
  return () => `binding-${(counter++).toString()}`;
}

function makeStore(now: () => string = makeAdvancingClock()): RuntimeBindingStore {
  return new RuntimeBindingStore(db, { now, newId: makeIdSource() });
}

// A constant clock gives every row one `created_at`, so the `findByRuns` ordering tests
// exercise the `run_id` and `id` sort keys.
function makeConstantClock(): () => string {
  return () => "2026-06-02T12:00:00.000Z";
}

// A fully-populated spawn-bound record: every member of the closed key set, shaped as real
// contract values.
const EXECUTION_POSTURE: ExecutionPosture = {
  networkAccess: "none",
  writableRoots: ["/workspace/repo"],
  mode: "trusted",
};

const FULL_SPAWN_CONFIG: RuntimeBindingSpawnConfig = {
  executionPosture: EXECUTION_POSTURE,
  callbackTools: [
    { name: "ask_human", description: "Ask the operator", inputSchema: { type: "object" } },
  ],
  subagentPolicy: { enabled: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  admittedCostCapUsdMicros: 25_000_000,
  providerAccountId: "acct-01J0ND0000NN5J5J5J5J5J5J",
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  outputSpeed: "on",
};

const CLI_VERSION: DriverCliVersionReport = { raw: "2.1.245 (Claude Code)", semver: "2.1.245" };

// Direct-SQL insert that bypasses the write seam: the only way to stage a corrupt
// `spawn_config` or a half-present CLI-version pair.
function insertRawBinding(overrides: {
  id?: string;
  runId?: string;
  spawnConfig?: string;
  cliVersionRaw?: string | null;
  cliVersionSemver?: string | null;
}): string {
  const id: string = overrides.id ?? "raw-binding-0";
  db.prepare(
    `INSERT INTO runtime_bindings
       (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
     VALUES
       (@id, @run_id, @driver_name, @contract_version, @cli_version_raw, @cli_version_semver, NULL, @spawn_config, '{}', @created_at, @created_at)`,
  ).run({
    id,
    run_id: overrides.runId ?? RUN_ID,
    driver_name: DRIVER_NAME,
    contract_version: CONTRACT_VERSION,
    cli_version_raw: overrides.cliVersionRaw ?? null,
    cli_version_semver: overrides.cliVersionSemver ?? null,
    spawn_config: overrides.spawnConfig ?? "{}",
    created_at: "2026-06-02T12:00:00.000Z",
  });
  return id;
}

// Stages a half-present CLI-version pair, which the DDL CHECK makes unreachable through
// ordinary writes. `ignore_check_constraints` is connection-scoped and turned back off in the
// same call, so no other statement runs unchecked.
function insertHalfPairBindingOutOfBand(overrides: {
  id?: string;
  runId?: string;
  cliVersionRaw?: string | null;
  cliVersionSemver?: string | null;
}): string {
  db.pragma("ignore_check_constraints = ON");
  try {
    return insertRawBinding(overrides);
  } finally {
    db.pragma("ignore_check_constraints = OFF");
  }
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
      `SELECT contract_version, resume_handle, runtime_metadata, updated_at FROM runtime_bindings WHERE id = ?`,
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

  it("findByRun returns [] when the run has no bindings", () => {
    const store = makeStore();
    expect(store.findByRun("run-with-nothing")).toEqual([]);
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

  it("delete returns true then the row is gone; absent delete returns false", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    expect(store.delete(created.id)).toBe(true);
    expect(store.findById(created.id)).toBeUndefined();
    expect(store.delete(created.id)).toBe(false);
  });

  it("findById / update of an absent id behave (undefined)", () => {
    const store = makeStore();
    expect(store.findById("nope")).toBeUndefined();
    expect(store.update("nope", { contractVersion: "1.0.0" })).toBeUndefined();
  });
});

// Both sides of each limit are pinned so a `<=` to `<` off-by-one cannot survive.
describe("RuntimeBindingStore — length boundary (const-derived, end-to-end)", () => {
  it("accepts a CONTRACT_VERSION_MAX_LEN-length canonical semver and round-trips it", () => {
    // `"1.0.0-"` is 6 characters; the rest pads the prerelease identifier to the maximum.
    const maxVersion: string = "1.0.0-" + "a".repeat(CONTRACT_VERSION_MAX_LEN - 6);
    expect(maxVersion.length).toBe(CONTRACT_VERSION_MAX_LEN);

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: maxVersion,
      spawnConfig: {},
    });
    expect(store.findById(created.id)?.contractVersion).toBe(maxVersion);
  });

  it("rejects a CONTRACT_VERSION_MAX_LEN+1-length contract_version", () => {
    const overVersion: string = "1.0.0-" + "a".repeat(CONTRACT_VERSION_MAX_LEN - 6 + 1);
    expect(overVersion.length).toBe(CONTRACT_VERSION_MAX_LEN + 1);

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

  it("accepts a RESUME_HANDLE_MAX_LEN-length resume_handle and round-trips it", () => {
    const maxHandle: string = "h".repeat(RESUME_HANDLE_MAX_LEN);
    expect(maxHandle.length).toBe(RESUME_HANDLE_MAX_LEN);

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: maxHandle,
    });
    expect(store.findById(created.id)?.resumeHandle).toBe(maxHandle);
  });

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
});

describe("RuntimeBindingStore — contract_version canonical-semver identity", () => {
  const accept: string[] = ["1.2.3", "1.0.0", "2.1.0-rc.1", "1.0.0-alpha.1"];
  const reject: string[] = ["1.0", "1", "01.2.3", "v1.2.3", " 1.2.3 ", "1.2.3+build.5", ""];

  for (const version of accept) {
    it(`accepts canonical semver ${JSON.stringify(version)}`, () => {
      const store = makeStore();
      const created = store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: version,
        spawnConfig: {},
      });
      expect(store.findById(created.id)?.contractVersion).toBe(version);
    });
  }

  for (const version of reject) {
    it(`rejects non-canonical / loose / malformed ${JSON.stringify(version)}`, () => {
      const store = makeStore();
      let thrown: unknown;
      try {
        store.create({
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: version,
          spawnConfig: {},
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      const validationError = thrown as ProviderOutputValidationError;
      expect(validationError.fields?.["field"]).toBe("contract_version");
    });
  }
});

describe("RuntimeBindingStore — resume_handle nullability + hardening", () => {
  it("omitted resumeHandle persists NULL and round-trips as null", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    expect(created.resumeHandle).toBeNull();
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("explicit null resumeHandle persists NULL", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: null,
    });
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("rejects a whitespace-only resume_handle (the /\\S/ hardening beyond the DB CHECK)", () => {
    const store = makeStore();
    let thrown: unknown;
    try {
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        spawnConfig: {},
        resumeHandle: "   ",
      });
    } catch (error) {
      thrown = error;
    }
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

describe("RuntimeBindingStore — runtime_metadata", () => {
  it("round-trips a non-trivial nested object", () => {
    const metadata = {
      provider: "anthropic",
      session: { id: "s-7", tokens: 1024 },
      flags: ["a", "b"],
      nested: { deep: { value: true } },
    };
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      runtimeMetadata: metadata,
    });
    expect(store.findById(created.id)?.runtimeMetadata).toEqual(metadata);
  });

  it("defaults omitted runtime_metadata to {}", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    expect(created.runtimeMetadata).toEqual({});
    expect(store.findById(created.id)?.runtimeMetadata).toEqual({});
  });

  // create() returns the JSON-round-tripped metadata so it agrees with findById() and update().
  // `{ b: undefined }` is the discriminator: JSON drops the key.
  it("create() returns runtime_metadata round-tripped, matching findById() (DB-as-source-of-truth)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      // `b: undefined` is dropped by JSON.stringify, so the persisted form is `{ a: 1 }`.
      runtimeMetadata: { a: 1, b: undefined },
    });

    const found = store.findById(created.id);
    expect(found).toBeDefined();
    // `toStrictEqual`, not `toEqual`: `toEqual` ignores undefined-valued keys and would pass
    // even if create() returned the unrounded object.
    expect(created.runtimeMetadata).toStrictEqual(found?.runtimeMetadata);
    expect(created.runtimeMetadata).toStrictEqual({ a: 1 });
    expect("b" in created.runtimeMetadata).toBe(false);
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

  it("returns [] when no binding carries a resume_handle", () => {
    const store = makeStore();
    store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    expect(store.findResumableBindings()).toEqual([]);
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

  it("REFUSES an update onto a row whose stored spawn_config is unreadable, and commits NOTHING", () => {
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

    let thrown: unknown;
    try {
      store.update(created.id, { contractVersion: "1.0.1", resumeHandle: "handle-after" });
    } catch (error) {
      thrown = error;
    }

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
  });

  it("validates the patch BEFORE the existence check: absent id + invalid patch THROWS", () => {
    // The patch-shape asserts run before the existence lookup, so an invalid patch against an
    // absent id throws (a caller bug) instead of returning `undefined`. An absent id with a
    // valid patch returns `undefined` (pinned in the CRUD block).
    const store = makeStore();
    expect(() => store.update("absent-id", { contractVersion: "1.0" })).toThrow(
      ProviderOutputValidationError,
    );
  });
});

describe("RuntimeBindingStore — findByRuns (batch lookup)", () => {
  it("empty input short-circuits to [] WITHOUT executing the statement", () => {
    const store = makeStore();
    // Close the handle first: any statement against a closed connection throws, so the passing
    // assertion proves no query ran.
    db.close();

    expect(store.findByRuns([])).toEqual([]);

    // Negative control: the same call with a non-empty list does execute, and throws on the
    // closed handle. Without it, a `findByRuns` that never queried would also pass.
    expect(() => store.findByRuns([RUN_ID])).toThrow();
  });

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

  it("dedupes repeated run ids (IN is set membership, not a join)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    const found = store.findByRuns([RUN_ID, RUN_ID, RUN_ID]);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(created);
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

  it("orders by run_id, then created_at, then id — independent of input order", () => {
    // A constant clock gives every row the same `created_at`, and the two runs are interleaved
    // at creation, so only the `run_id, id` sort keys can explain the result. The argument list
    // is passed in the opposite run order.
    const store = makeStore(makeConstantClock());
    const otherFirst = store.create({
      runId: OTHER_RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    const runFirst = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    const otherSecond = store.create({
      runId: OTHER_RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    const runSecond = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    // RUN_ID sorts before OTHER_RUN_ID (…5J5J… < …5K5K…).
    expect(store.findByRuns([OTHER_RUN_ID, RUN_ID]).map((binding) => binding.id)).toEqual([
      runFirst.id,
      runSecond.id,
      otherFirst.id,
      otherSecond.id,
    ]);
  });

  it("contributes nothing for an unknown run id", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    const found = store.findByRuns(["run-that-was-never-bound", RUN_ID]);
    expect(found.map((binding) => binding.id)).toEqual([created.id]);
    expect(store.findByRuns(["run-that-was-never-bound"])).toEqual([]);
  });

  it("accepts an arity far beyond SQLITE_MAX_VARIABLE_NUMBER (the json_each design claim)", () => {
    // The run-id list travels as one `json_each` parameter rather than N `?` placeholders.
    // SQLite's default parameter ceiling is 32766, so this list could not be bound as
    // placeholders.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    const manyRunIds: string[] = [];
    for (let index = 0; index < 40000; index += 1) {
      manyRunIds.push(`run-absent-${index.toString()}`);
    }
    manyRunIds.push(RUN_ID);

    expect(store.findByRuns(manyRunIds).map((binding) => binding.id)).toEqual([created.id]);
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

  it("NEGATIVE CONTROL: a create carrying an executionPosture never leaves the raw column at '{}'", () => {
    // A spawn that realizes a spawn-bound surface but persists nothing would leave the column
    // at its default `'{}'`, and recovery would relaunch without a posture, unsandboxed. Read
    // with a raw SELECT, because the accessor parses `'{}'` into a valid empty record.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { executionPosture: EXECUTION_POSTURE },
    });

    const rawColumn = readRawSpawnConfig(created.id);
    expect(rawColumn).not.toBe("{}");
    expect(JSON.parse(rawColumn)).toStrictEqual({ executionPosture: EXECUTION_POSTURE });
    expect(store.findById(created.id)?.spawnConfig.executionPosture).toStrictEqual(
      EXECUTION_POSTURE,
    );
  });

  it("an EXPLICIT empty record is written as '{}' and reads back as all-absent", () => {
    // A genuinely empty live record and a default row are indistinguishable by value; pinned
    // as a known property.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    expect(readRawSpawnConfig(created.id)).toBe("{}");
    expect(created.spawnConfig).toStrictEqual({});
    expect(store.findById(created.id)?.spawnConfig).toStrictEqual({});
  });

  it("an untyped caller OMITTING spawnConfig is refused loudly — never a silent '{}' write", () => {
    // TypeScript callers cannot omit `spawnConfig`; this pins the runtime arm. A `?? {}` floor
    // would write the ambiguous empty record, and a posture-less resume relaunches unsandboxed,
    // so the store refuses with an internal-invariant Error and no row lands.
    const store = makeStore();
    const inputWithoutSpawnConfig = {
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
    } as unknown as Parameters<typeof store.create>[0];

    let thrown: unknown;
    try {
      store.create(inputWithoutSpawnConfig);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).toContain("spawnConfig is required at every binding write");
    expect(countBindings()).toBe(0);
  });

  it("a pre-B10 row carrying the '{}' column DEFAULT reads as an all-absent record", () => {
    const store = makeStore();
    const rawId = insertRawBinding({ spawnConfig: "{}" });
    expect(store.findById(rawId)?.spawnConfig).toStrictEqual({});
  });

  it("create() returns the ROUND-TRIPPED record, matching findById() (DB-as-source-of-truth)", () => {
    // Same discriminator as the runtime_metadata case: a member JSON drops must be absent from
    // both accessors.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { admittedCostCapUsdMicros: 1_000_000, providerAccountId: undefined },
    });

    expect(created.spawnConfig).toStrictEqual({ admittedCostCapUsdMicros: 1_000_000 });
    expect("providerAccountId" in created.spawnConfig).toBe(false);
    expect(created.spawnConfig).toStrictEqual(store.findById(created.id)?.spawnConfig);
  });

  const malformed: { label: string; raw: string }[] = [
    { label: "unparseable JSON", raw: "{not json at all" },
    { label: "a JSON array", raw: "[1,2,3]" },
    { label: "JSON null", raw: "null" },
    { label: "a JSON string", raw: '"executionPosture"' },
    { label: "an unknown member", raw: '{"executionPostures":{"mode":"trusted"}}' },
    { label: "a string where an object belongs", raw: '{"executionPosture":"trusted"}' },
    { label: "an object where an array belongs", raw: '{"callbackTools":{}}' },
    { label: "a string where a number belongs", raw: '{"admittedCostCapUsdMicros":"25000000"}' },
    {
      label: "a fractional amount where whole micro-dollars belong",
      raw: '{"admittedCostCapUsdMicros":2500.5}',
    },
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

      let thrown: unknown;
      try {
        store.findById(rawId);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // A plain internal-invariant Error, not the provider-output type: this is daemon-written
      // local state, so a malformation is corrupt storage.
      expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
      // The row is named, so the operator can find the corrupt record.
      expect((thrown as Error).message).toContain(rawId);
      expect((thrown as Error).message).toContain("spawn_config");
    });
  }

  it("refuses an unreadable record at CREATE and lands no row", () => {
    // Reachable only from an untyped caller (the input type enforces the closed key set), but
    // the write path parses the serialized record before the INSERT, so an unreadable record
    // never lands durably to fail later in recovery.
    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        spawnConfig: { executionPostures: {} } as unknown as RuntimeBindingSpawnConfig,
      }),
    ).toThrow(/unknown member/);
    expect(countBindings()).toBe(0);
  });

  it("surfaces the malformation through EVERY read path, not just findById", () => {
    const store = makeStore();
    insertRawBinding({ id: "corrupt-row-2", spawnConfig: "{not json at all" });

    expect(() => store.findByRun(RUN_ID)).toThrow(/corrupt-row-2/);
    expect(() => store.findByRuns([RUN_ID])).toThrow(/corrupt-row-2/);
  });
});

describe("RuntimeBindingStore — cliVersion pair", () => {
  it("rejects a bounded-but-unparseable semver and a non-canonical form at the seam", () => {
    // A bounded garbage semver stored now would poison floor comparison far from the row that
    // produced it. The seam applies the module's one semver predicate (`semver.valid(v) === v`,
    // the floor gate's), so the layers cannot disagree.
    const store = makeStore();
    for (const unparseableSemver of ["not-a-version", "v1.2.3", " 1.2.3", "1.2"]) {
      let thrown: unknown;
      try {
        store.create({
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: CONTRACT_VERSION,
          cliVersion: { raw: CLI_VERSION.raw, semver: unparseableSemver },
          spawnConfig: {},
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe(
        "cli_version_semver",
      );
    }
    expect(countBindings()).toBe(0);
  });

  it("a THROWING accessor on the report surfaces as the typed leak-safe refusal", () => {
    // A throwing accessor must not escape as the caller object's own exception text.
    const store = makeStore();
    const reportWithThrowingAccessor = {
      get raw(): string {
        throw new Error("PROVIDER-CONTROLLED-SECRET-TEXT");
      },
      semver: CLI_VERSION.semver,
    } as unknown as DriverCliVersionReport;

    let thrown: unknown;
    try {
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        cliVersion: reportWithThrowingAccessor,
        spawnConfig: {},
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).not.toContain("PROVIDER-CONTROLLED-SECRET-TEXT");
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("cliVersion");
    expect(countBindings()).toBe(0);
  });

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
      cli_version_raw: CLI_VERSION.raw,
      cli_version_semver: CLI_VERSION.semver,
    });
  });

  it("an omitted report persists NEITHER column and reads back as null", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });

    expect(created.cliVersion).toBeNull();
    expect(store.findById(created.id)?.cliVersion).toBeNull();
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: null,
      cli_version_semver: null,
    });
  });

  it("the DDL CHECK rejects a HALF-PRESENT pair written directly via SQL", () => {
    // The seam makes a half-pair unrepresentable (one optional member carries both values), so
    // this is the only way to test the column-layer guarantee. Both directions, because the
    // CHECK is an equality of two IS NULL tests.
    expect(() =>
      insertRawBinding({ id: "half-1", cliVersionRaw: CLI_VERSION.raw, cliVersionSemver: null }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertRawBinding({ id: "half-2", cliVersionRaw: null, cliVersionSemver: CLI_VERSION.semver }),
    ).toThrow(/CHECK constraint failed/);
    expect(countBindings()).toBe(0);
  });

  it("validates and persists ONE snapshot of the report — a getter cannot swap the value after validation", () => {
    // TOCTOU: the report is provider-shaped input, so its members may be getters or a Proxy.
    // The seam reads each member once into a plain object before validating, then validates,
    // binds and returns that same object. A second read at bind time would persist a value no
    // validator saw.
    let rawReads: number = 0;
    const mutatingReport: DriverCliVersionReport = {
      get raw(): string {
        rawReads += 1;
        return rawReads === 1 ? CLI_VERSION.raw : "swapped-after-validation";
      },
      get semver(): string {
        return CLI_VERSION.semver;
      },
    };

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      cliVersion: mutatingReport,
      spawnConfig: {},
    });

    // Exactly one read of the provider's member.
    expect(rawReads).toBe(1);
    // The snapshot reaches the row, the return value and the re-read.
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: CLI_VERSION.raw,
      cli_version_semver: CLI_VERSION.semver,
    });
    expect(created.cliVersion).toStrictEqual(CLI_VERSION);
    expect(store.findById(created.id)?.cliVersion).toStrictEqual(CLI_VERSION);
  });

  it("reads a HALF-PRESENT stored pair as null — never a fabricated member", () => {
    // Only reachable by out-of-band corruption, which is why the fold reads the both-or-neither
    // guarantee instead of assuming it. Defaulting the absent sibling to `""` would manufacture
    // a report the provider never gave; an empty `semver` is exactly what the floor gate cannot
    // compare. Both directions, because a fold keyed on one column alone passes one by accident.
    const store = makeStore();
    const rawOnlyId = insertHalfPairBindingOutOfBand({
      id: "half-pair-raw-only",
      cliVersionRaw: CLI_VERSION.raw,
      cliVersionSemver: null,
    });
    const semverOnlyId = insertHalfPairBindingOutOfBand({
      id: "half-pair-semver-only",
      runId: OTHER_RUN_ID,
      cliVersionRaw: null,
      cliVersionSemver: CLI_VERSION.semver,
    });

    // The staging really landed half-present rows; a silently failed pragma would make the
    // assertions vacuous.
    expect(readRawCliVersion(rawOnlyId)).toEqual({
      cli_version_raw: CLI_VERSION.raw,
      cli_version_semver: null,
    });
    expect(readRawCliVersion(semverOnlyId)).toEqual({
      cli_version_raw: null,
      cli_version_semver: CLI_VERSION.semver,
    });

    expect(store.findById(rawOnlyId)?.cliVersion).toBeNull();
    expect(store.findById(semverOnlyId)?.cliVersion).toBeNull();
    // Through every read path, since all share one `#rowToDomain`.
    expect(store.findByRun(RUN_ID)[0]?.cliVersion).toBeNull();
    expect(store.findByRuns([RUN_ID, OTHER_RUN_ID]).map((binding) => binding.cliVersion)).toEqual([
      null,
      null,
    ]);
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
      cli_version_raw: CLI_VERSION.raw,
      cli_version_semver: CLI_VERSION.semver,
    });
  });

  it("accepts const-length raw/semver values end-to-end (const↔Zod↔SQL-CHECK coherence)", () => {
    const maxRaw: string = "v".repeat(CLI_VERSION_RAW_MAX_LEN);
    const maxSemver: string = "1.0.0-" + "a".repeat(CLI_VERSION_SEMVER_MAX_LEN - 6);
    expect(maxRaw.length).toBe(CLI_VERSION_RAW_MAX_LEN);
    expect(maxSemver.length).toBe(CLI_VERSION_SEMVER_MAX_LEN);

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      cliVersion: { raw: maxRaw, semver: maxSemver },
      spawnConfig: {},
    });

    expect(store.findById(created.id)?.cliVersion).toStrictEqual({
      raw: maxRaw,
      semver: maxSemver,
    });
  });

  const rejected: { label: string; report: DriverCliVersionReport; field: string }[] = [
    { label: "an empty raw", report: { raw: "", semver: "2.1.245" }, field: "cli_version_raw" },
    {
      label: "a whitespace-only raw",
      report: { raw: "   ", semver: "2.1.245" },
      field: "cli_version_raw",
    },
    {
      label: "an oversize raw",
      report: { raw: "v".repeat(CLI_VERSION_RAW_MAX_LEN + 1), semver: "2.1.245" },
      field: "cli_version_raw",
    },
    {
      label: "a NUL-containing raw",
      report: { raw: "2.1\0.245", semver: "2.1.245" },
      field: "cli_version_raw",
    },
    {
      label: "an empty semver",
      report: { raw: "2.1.245 (Claude Code)", semver: "" },
      field: "cli_version_semver",
    },
    {
      label: "an oversize semver",
      report: {
        raw: "2.1.245 (Claude Code)",
        semver: "1.0.0-" + "a".repeat(CLI_VERSION_SEMVER_MAX_LEN - 6 + 1),
      },
      field: "cli_version_semver",
    },
    {
      label: "a NUL-containing semver",
      report: { raw: "2.1.245 (Claude Code)", semver: "2.1\0.245" },
      field: "cli_version_semver",
    },
  ];

  for (const { label, report, field } of rejected) {
    it(`refuses ${label} at the write seam BEFORE any row lands`, () => {
      const store = makeStore();

      let thrown: unknown;
      try {
        store.create({
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: CONTRACT_VERSION,
          cliVersion: report,
          spawnConfig: {},
        });
      } catch (error) {
        thrown = error;
      }

      // A typed, leak-safe refusal, never a raw SqliteError from the DDL CHECK.
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      const validationError = thrown as ProviderOutputValidationError;
      expect(validationError.fields?.["field"]).toBe(field);
      // The daemon-controlled driver name is carried; the provider-supplied values are not. The
      // message is a fixed sentence and the detail names the field and constraint only.
      expect(validationError.fields?.["driverName"]).toBe(DRIVER_NAME);
      expect(validationError.message).toBe("Invalid provider cli_version report.");
      const errorSurface: string = `${validationError.message} ${JSON.stringify(validationError.fields)}`;
      // Empty-string fixtures are skipped: every string contains "", so the check would prove
      // nothing.
      if (report.raw !== "") {
        expect(errorSurface).not.toContain(report.raw);
      }
      if (report.semver !== "") {
        expect(errorSurface).not.toContain(report.semver);
      }

      // Validation runs before the INSERT, so no row landed.
      expect(countBindings()).toBe(0);
    });
  }

  it("refuses a structurally malformed report object (runtime type erasure)", () => {
    // Reachable only from an untyped caller: the static type is erased at runtime, so a
    // malformed driver can ship `null`. `null` is passed directly because the guard's parameter
    // is `unknown`, making a malformed report a runtime judgment.
    let thrown: unknown;
    try {
      assertValidCliVersionReport(DRIVER_NAME, null);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("cliVersion");
  });
});

describe("RuntimeBindingStore — spawned-version carriers", () => {
  // `version-gate.test.ts` proves the reading is taken from the dereferenced build. This proves
  // that value is what a later reader gets back out of the database, through `create()`'s
  // report validation, the both-or-neither DDL CHECK and the `spawn_config` parser, none of
  // which the in-memory projection helpers exercise: the version compared, the version
  // recorded and the version run are one reading.
  const LAUNCHER_PATH: string = "/opt/homebrew/bin/claude";
  const DEREFERENCED_BUILD_PATH: string = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";

  // Keyed by resolved path. The launcher answers a build below the version floor, so a
  // resolver that failed to dereference would make the read refuse; every assertion also
  // witnesses which process was asked.
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
  // `version-gate.test.ts` is posix-only).
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
      baseEnvironment: {},
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
    expect(found?.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
    expect(found?.spawnConfig.resolvedExecutablePath).toBe(DEREFERENCED_BUILD_PATH);
    // The launcher's build appears nowhere in the row, neither in the version pair nor in the
    // spawn-bound record.
    expect(JSON.stringify(found)).not.toContain("2.1.198");
  });

  it("persists a Codex reading whose raw IS its semver (the extracted-token shape)", async () => {
    // A Codex version is extracted from the composite `userAgent`, so its `raw` and `semver` are
    // the same string, a combination no other test covers at the write seam and DDL CHECK.
    const codexBuildPath: string = "/opt/homebrew/Cellar/codex/0.149.1/bin/codex";
    const reading = await readSpawnedProviderVersion({
      driverName: "codex",
      requestedCommand: codexBuildPath,
      handshake: async () => ({
        userAgent:
          "ai-sidekicks-daemon/0.149.1 (macos 26.0.0; arm64) tmux (ai-sidekicks-daemon; 0.1.0)",
      }),
      baseEnvironment: {},
      resolver: {
        isExecutableFile: async (): Promise<boolean> => true,
        realpath: async (candidate: string): Promise<string> => candidate,
      },
    });

    const store = makeStore();
    const created = store.create(
      withSpawnedVersionCarriers(
        {
          runId: RUN_ID,
          driverName: "codex",
          contractVersion: CONTRACT_VERSION,
          // Declares the same executable the reading resolved (the agreement arm of the carrier
          // merge).
          spawnConfig: { ...FULL_SPAWN_CONFIG, resolvedExecutablePath: codexBuildPath },
          resumeHandle: "thread-abc",
        },
        toBindingVersionCarriers(reading),
      ),
    );

    const found = store.findById(created.id);
    expect(found?.cliVersion).toStrictEqual({ raw: "0.149.1", semver: "0.149.1" });
    // The merge replaces `resolvedExecutablePath` and touches nothing else.
    expect(found?.spawnConfig).toStrictEqual({
      ...FULL_SPAWN_CONFIG,
      resolvedExecutablePath: codexBuildPath,
    });
    expect(found?.resumeHandle).toBe("thread-abc");
  });
});

// Resume is a fresh process spawn, so each spawn-bound leg must be re-supplied from the row or
// the relaunch sheds it; a posture-less resume would run unsandboxed. A binding with no
// resumable provider session refuses locally and classifiably instead of pushing an empty
// handle at the provider.

describe("composeResumeSessionParams (R4)", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
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

    const params = composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS);

    expect(params).toStrictEqual({
      sessionId: SESSION_ID,
      resumeHandle: "opaque-handle-abc",
      executionPosture: EXECUTION_POSTURE,
      callbackTools: FULL_SPAWN_CONFIG.callbackTools,
      subagentPolicy: FULL_SPAWN_CONFIG.subagentPolicy,
      outputSchema: FULL_SPAWN_CONFIG.outputSchema,
      admittedCostCapUsdMicros: 25_000_000,
      providerAccountId: FULL_SPAWN_CONFIG.providerAccountId,
      outputSpeed: "on",
      onCallbackToolCall: undefined,
      onMcpServerStatus: undefined,
    });
  });

  it("carries no `relaunch-input` member onto the resume params", () => {
    // A spread from `spawnConfig` would carry members the params shape does not declare, such
    // as the resolved executable path, which the relaunch path owns. `providerAccountId` is on
    // the params because the driver is handed it.
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });

    const params = composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS);

    expect(Object.keys(params)).not.toContain("resolvedExecutablePath");
    expect(Object.keys(params)).toContain("providerAccountId");
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

    const params = composeResumeSessionParams(SESSION_ID, binding, {
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

    let thrown: unknown;
    try {
      composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeBindingNotResumableError);
    expect((thrown as RuntimeBindingNotResumableError).runId).toBe(RUN_ID);
    expect((thrown as RuntimeBindingNotResumableError).bindingId).toBe(binding.id);
  });

  it("re-realizes a leg a row that stored NOTHING leaves absent, rather than inventing one", () => {
    // An empty `spawn_config` yields absent legs, which the driver treats as "not declared",
    // never as a default posture.
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: "opaque-handle-abc",
    });

    const params = composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS);

    expect(params.executionPosture).toBeUndefined();
    expect(params.outputSchema).toBeUndefined();
    expect(params.admittedCostCapUsdMicros).toBeUndefined();
    expect(params.outputSpeed).toBeUndefined();
  });

  it("re-realizes the accelerated-output leg, which a resume would otherwise shed", () => {
    // The accelerated-output level is realized at spawn and is a parameter the driver takes,
    // unlike the paying account and resolved binary, which spawn resolution consumes before the
    // driver is called. A resume that dropped it would relaunch at the provider's default speed
    // while everything above still showed the accepted choice.
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { outputSpeed: "on" },
      resumeHandle: "opaque-handle-abc",
    });

    const params = composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS);

    expect(params.outputSpeed).toBe("on");
  });

  it("stores the REQUESTED level and never a provider observation", () => {
    // `cooldown` is a state the Claude surface reports, never one a user may request; it lives
    // on the binding-held `ProviderOutputSpeedState`, which is discarded with the session. If it
    // reached this column, a restart would ask the provider for a level it does not accept.
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { outputSpeed: "off" },
      resumeHandle: "opaque-handle-abc",
    });

    expect(binding.spawnConfig).toStrictEqual({ outputSpeed: "off" });
    expect(Object.keys(binding.spawnConfig)).not.toContain("declared");
  });
});

describe("provider-account identity at spawn and resume", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;
  const NO_FUNCTION_LEGS = {
    onCallbackToolCall: undefined,
    onMcpServerStatus: undefined,
  };
  const ADMITTED_ACCOUNT_ID = "acct-01J0ND0000NN5J5J5J5J5J5J";
  const LATER_DEFAULT_ACCOUNT_ID = "acct-01K7XXXXXXXXXXXXXXXXXXXXXX";

  it("leaves a NO-IDENTIFIER create byte-identical to the pre-amendment column", () => {
    // With no key, the unchanged path is unchanged down to the stored bytes, so nothing
    // downstream can read an unbound account as bound-but-empty.
    const store = makeStore();
    const preAmendmentSpawnConfig: RuntimeBindingSpawnConfig = {
      executionPosture: EXECUTION_POSTURE,
      admittedCostCapUsdMicros: 25_000_000,
    };
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: preAmendmentSpawnConfig,
      resumeHandle: "opaque-handle-abc",
    });

    expect(readRawSpawnConfig(binding.id)).toBe(JSON.stringify(preAmendmentSpawnConfig));
    expect(readRawSpawnConfig(binding.id)).not.toContain("providerAccountId");
    expect(binding.spawnConfig.providerAccountId).toBeUndefined();
    expect(
      composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS).providerAccountId,
    ).toBeUndefined();
  });

  it("ROUND-TRIPS the identity through the durable row and back onto the resume params", () => {
    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { ...FULL_SPAWN_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
      resumeHandle: "opaque-handle-abc",
    });

    expect(JSON.parse(readRawSpawnConfig(binding.id))).toMatchObject({
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });
    // Read through the store's typed accessor, not by re-parsing the column at the call site,
    // which would be a second reader of the closed key set.
    const reread = store.findById(binding.id);
    expect(reread?.spawnConfig.providerAccountId).toBe(ADMITTED_ACCOUNT_ID);
    expect(
      composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS).providerAccountId,
    ).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REBINDS to the ADMITTED account after the provider default changed mid-session", () => {
    // A resume that re-resolved "whichever account is default now" would move a live run's
    // spend to an account it was never admitted against. The durable row is the source, so the
    // default may move freely.
    const store = makeStore();
    let nodeResolvedDefaultAccountId = ADMITTED_ACCOUNT_ID;
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { ...FULL_SPAWN_CONFIG, providerAccountId: nodeResolvedDefaultAccountId },
      resumeHandle: "opaque-handle-abc",
    });

    // The operator changes the node's default while the run is live.
    nodeResolvedDefaultAccountId = LATER_DEFAULT_ACCOUNT_ID;

    // Recovery does not hold the admitting request; it holds the row.
    const resumed = store.findById(binding.id);
    expect(resumed).toBeDefined();
    const params = composeResumeSessionParams(SESSION_ID, resumed!, NO_FUNCTION_LEGS);

    expect(params.providerAccountId).toBe(ADMITTED_ACCOUNT_ID);
    expect(params.providerAccountId).not.toBe(nodeResolvedDefaultAccountId);
  });

  it("records the SERVER-RESOLVED value, never the client's request for one", () => {
    // A client-supplied identifier is an input to resolution. The stored value, which a
    // relaunch re-realizes, is the one the daemon resolved, so a client cannot pin a run to an
    // account by asking.
    const clientRequestedAccountId = "acct-client-asked-for-this";
    const resolveProviderAccountId = (requested: string): string => {
      expect(requested).toBe(clientRequestedAccountId);
      return ADMITTED_ACCOUNT_ID;
    };

    const store = makeStore();
    const binding = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {
        ...FULL_SPAWN_CONFIG,
        providerAccountId: resolveProviderAccountId(clientRequestedAccountId),
      },
      resumeHandle: "opaque-handle-abc",
    });

    expect(readRawSpawnConfig(binding.id)).not.toContain(clientRequestedAccountId);
    expect(binding.spawnConfig.providerAccountId).toBe(ADMITTED_ACCOUNT_ID);
    expect(
      composeResumeSessionParams(SESSION_ID, binding, NO_FUNCTION_LEGS).providerAccountId,
    ).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("refuses a non-string identity at the closed-key-set parse seam", () => {
    // The member check is `typeof value === "string"`, so a corrupted row surfaces as an
    // unreadable `spawn_config` instead of reaching a spawn as a structure a driver might
    // interpret.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
      resumeHandle: "opaque-handle-abc",
    });
    corruptSpawnConfigOutOfBand(
      created.id,
      JSON.stringify({ providerAccountId: { accountId: ADMITTED_ACCOUNT_ID } }),
    );

    expect(() => store.findById(created.id)).toThrow(/spawn_config/);
  });
});

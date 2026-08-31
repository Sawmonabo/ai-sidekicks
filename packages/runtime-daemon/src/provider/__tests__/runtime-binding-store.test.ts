// RuntimeBindingStore — Plan-005 Phase 2 (T2.2).
//
// Exercises CRUD + the provider-output write-seam validation over a REAL Local
// SQLite handle via `openDatabase(":memory:")` — so BOTH the Zod write-seam
// layer AND the DB CHECK constraints from `0003-runtime-bindings.ts` fire
// end-to-end. A fresh private in-memory DB is opened per test (the full
// migration chain runs each time; the WAL pragma is a silent no-op on
// `:memory:`), so there is no tmp-file/unlink lifecycle to manage.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * `Spec-005 §Required Behavior` (resume_handle is a provider-owned opaque handle, bounded at
//     the write seam): nullability round-trips; length-edge accept/reject;
//     whitespace-only + NUL rejection (the /\S/ + NUL hardening beyond the DB
//     CHECK).
//   * I-005-1 (driver authority remains local, daemon-resident binding store):
//     the store operates entirely over the local handle — every assertion below
//     reads/writes the local DB, with no provider round-trip.
//   * const↔Zod↔SQL-CHECK coherence: boundary fixtures are derived FROM the
//     exported consts and INSERTed through `create()` (a real INSERT), so a
//     const bumped above the SQL CHECK literal would pass Zod but fail the DB
//     CHECK — making this test fail. The coherence is enforced, not commented.
//   * T2.6 `spawn_config` (the CP-005-1 recovery seam): the daemon-owned
//     spawn-bound record is written at EVERY create and read back through the
//     closed-key-set parser, so the resume assembly can rebuild
//     `ResumeSessionParams`' data legs from the row rather than from a client
//     request recovery does not have. A malformed record FAILS LOUD — a
//     silently-empty posture would relaunch UNSANDBOXED — on the read paths AND
//     on `update()`, whose in-transaction parse refuses to commit a patch onto a
//     record this store cannot read back.
//   * T2.6 `cli_version_raw` / `cli_version_semver` (`Spec-005 §State And Data
//     Implications`): the binding record stores the handshake report as a PAIR;
//     the both-or-neither DDL CHECK is exercised directly, an invalid report is
//     refused at the write seam as a TYPED error before any row lands, and a
//     half-present row staged out-of-band reads back as `null` rather than as a
//     fabricated member.
//   * T3.23 spawned-version carriers (`Spec-005 §Required Behavior`,
//     invariant I-005-10): the reading taken from the dereferenced build
//     reaches the ROW — asserted by reading back out of the database under
//     launcher drift, which the projection helpers alone cannot show.
//   * T2.6 `findByRuns` (the Plan-016 T2.10 ack-barrier input): batch lookup is
//     synchronous, order-deterministic, duplicate-tolerant, and returns
//     superseded history unfiltered — the caller owns the liveness intersection.
//
// Refs: Plan-005 §Phase 2 / T2.2 + T2.6, `Spec-005 §Required Behavior`,
// `Spec-005 §State And Data Implications`, invariant I-005-1.

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

// ----------------------------------------------------------------------------
// Fixtures + per-test lifecycle
// ----------------------------------------------------------------------------

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

// An ADVANCING clock: each call returns a distinct timestamp, so a "createdAt
// preserved while updatedAt bumped" assertion is non-vacuous (a constant clock
// could not distinguish the two timestamps).
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

// A collision-free deterministic id source.
function makeIdSource(): () => string {
  let counter: number = 0;
  return () => `binding-${(counter++).toString()}`;
}

function makeStore(now: () => string = makeAdvancingClock()): RuntimeBindingStore {
  return new RuntimeBindingStore(db, { now, newId: makeIdSource() });
}

// A CONSTANT clock — every row shares one `created_at`, which is what makes the
// `findByRuns` ordering assertions test the `run_id` and `id` sort keys rather
// than incidentally passing on a monotonic timestamp.
function makeConstantClock(): () => string {
  return () => "2026-06-02T12:00:00.000Z";
}

// A fully-populated spawn-bound record: every member of the closed key set,
// including the two minted-now/valued-later strings. Shaped as real contract
// values (a `trusted` posture, a disabled subagent policy) rather than
// placeholders, so the round-trip is over the shape the resume assembly will
// actually rebuild.
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
  admittedCostCapCents: 2500,
  providerAccountId: "acct-01J0ND0000NN5J5J5J5J5J5J",
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  outputSpeed: "on",
};

const CLI_VERSION: DriverCliVersionReport = { raw: "2.1.245 (Claude Code)", semver: "2.1.245" };

// Direct-SQL row insert, bypassing the store's write seam entirely. This is the
// ONLY way to stage the two states the seam makes unrepresentable — a corrupt
// `spawn_config` value and a half-present CLI-version pair — so the read path
// and the DB CHECK can be tested for what they do when the seam is not there.
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

// Stage a HALF-PRESENT CLI-version pair — a row the DDL CHECK makes unreachable
// through EVERY ordinary write path (the CHECK test below pins exactly that), so
// the read fold's both-columns requirement can only be exercised from here.
// `PRAGMA ignore_check_constraints` is connection-scoped and is turned back OFF
// in the same call, so no other statement in the test ever runs unchecked — the
// pragma stages corrupt storage, it does not relax the suite.
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

// Corrupt a LANDED row's `spawn_config` behind the store's back. Both write
// seams parse before they commit, so this is the only way to produce the state
// the update path must refuse: a record already durable and already unreadable.
function corruptSpawnConfigOutOfBand(id: string, rawSpawnConfig: string): void {
  const info = db
    .prepare(`UPDATE runtime_bindings SET spawn_config = ? WHERE id = ?`)
    .run(rawSpawnConfig, id);
  if (info.changes !== 1) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
}

// Raw column reads — the store's own accessors parse, so proving what actually
// landed in the column needs a read that does not go through them.
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

// The mutable columns `update()` writes, read raw — required for the corrupt-row
// case, where the store's own accessors refuse the row and so cannot report what
// (if anything) the refused transaction left behind.
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

// ----------------------------------------------------------------------------
// CRUD round-trips
// ----------------------------------------------------------------------------

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
    // Immutable columns unchanged.
    expect(updated?.id).toBe(created.id);
    expect(updated?.runId).toBe(created.runId);
    expect(updated?.driverName).toBe(created.driverName);
    expect(updated?.createdAt).toBe(created.createdAt);
    // updatedAt bumped past createdAt (advancing clock).
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
    expect(updated?.updatedAt).not.toBe(updated?.createdAt);

    // The mutation is durable.
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

// ----------------------------------------------------------------------------
// Accept-edge pinning (symmetric — pin BOTH sides so a <=→< off-by-one cannot
// survive). Boundary fixtures are derived FROM the consts and round-trip through
// a real INSERT, enforcing const↔Zod↔SQL-CHECK coherence.
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — length boundary (const-derived, end-to-end)", () => {
  it("accepts a CONTRACT_VERSION_MAX_LEN-length canonical semver and round-trips it", () => {
    // A valid prerelease semver of exactly CONTRACT_VERSION_MAX_LEN chars:
    // "1.0.0-" (6) + (MAX - 6) prerelease-identifier chars.
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

// ----------------------------------------------------------------------------
// Semver canonical-identity contract (pin the accept/reject sets exactly).
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// resume_handle nullability + hardening.
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// runtime_metadata round-trip.
// ----------------------------------------------------------------------------

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

  // FIX 5: create() must return the JSON-ROUND-TRIPPED metadata so it agrees with
  // findById() / update() (which reconstruct via JSON.parse). A value JSON
  // normalizes away — here `{ b: undefined }` — is the discriminator: pre-fix
  // create() returns the original object (key `b` PRESENT, value undefined),
  // findById() returns the round-tripped form (key `b` ABSENT), so they disagree.
  it("create() returns runtime_metadata round-tripped, matching findById() (DB-as-source-of-truth)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      // `b: undefined` is dropped by JSON.stringify, so the persisted/round-tripped
      // form is `{ a: 1 }`. Pre-fix create() returned `{ a: 1, b: undefined }`.
      runtimeMetadata: { a: 1, b: undefined },
    });

    const found = store.findById(created.id);
    expect(found).toBeDefined();
    // `toStrictEqual` (NOT `toEqual`) — `toEqual` IGNORES undefined-valued keys, so
    // it would pass even pre-fix; `toStrictEqual` distinguishes a present
    // undefined-valued key from an absent one, which is what makes this fail-before.
    expect(created.runtimeMetadata).toStrictEqual(found?.runtimeMetadata);
    // And the round-tripped form is exactly `{ a: 1 }` (key `b` absent).
    expect(created.runtimeMetadata).toStrictEqual({ a: 1 });
    expect("b" in created.runtimeMetadata).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// findResumableBindings (Plan-015 recovery seam — functional now).
// ----------------------------------------------------------------------------

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
    // No handle → must NOT appear.
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

// ----------------------------------------------------------------------------
// update revalidation (a rejected patch leaves the row unchanged).
// ----------------------------------------------------------------------------

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

    // Validation runs BEFORE the transaction, so the row is untouched.
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
    // The read-side twin of the create seam's pre-INSERT parse. Committing a
    // patch onto an unreadable record would make it newer, still unreadable, and
    // now stamped with an `updated_at` implying this daemon wrote it — hiding
    // the corruption from the recovery read that eventually trips over it. The
    // parse therefore runs INSIDE the transaction, before the UPDATE, and its
    // throw rolls the whole thing back.
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

    // A plain internal-invariant Error naming the row — corrupt DAEMON-WRITTEN
    // storage, not provider input to reject at a trust boundary.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).toContain(created.id);
    expect((thrown as Error).message).toContain("spawn_config");

    // Nothing committed — read RAW, because the store's own accessors refuse
    // this row and so could not distinguish "rolled back" from "unreadable".
    const raw = readRawMutableColumns(created.id);
    expect(raw.contract_version).toBe("1.0.0");
    expect(raw.resume_handle).toBe("handle-before");
    expect(raw.runtime_metadata).toBe(JSON.stringify({ attempt: 1 }));
    // `updated_at` is the sharpest witness: the merge computed a fresh stamp
    // from the advancing clock, so an UPDATE that reached the DB would have
    // moved it even where the other three columns happened to match.
    expect(raw.updated_at).toBe(created.updatedAt);
    expect(readRawSpawnConfig(created.id)).toBe("{not json at all");
  });

  it("validates the patch BEFORE the existence check: absent id + invalid patch THROWS", () => {
    // Precedence contract: the patch-shape asserts are an unconditional
    // precondition on the argument and run before the existence lookup. So an
    // invalid patch against a non-existent id THROWS (the patch is malformed
    // regardless of whether the target row exists — fail fast on the real caller
    // bug) rather than silently returning `undefined`. Contrast: an absent id
    // with a VALID patch returns `undefined` (pinned in the CRUD block).
    const store = makeStore();
    expect(() => store.update("absent-id", { contractVersion: "1.0" })).toThrow(
      ProviderOutputValidationError,
    );
  });
});

// ----------------------------------------------------------------------------
// findByRuns — the T2.6 batch lookup (Plan-016 T2.10's local ack-barrier input).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — findByRuns (batch lookup)", () => {
  it("empty input short-circuits to [] WITHOUT executing the statement", () => {
    const store = makeStore();
    // Close the handle FIRST. Any statement execution against a closed
    // connection throws, so a passing assertion below is positive proof that no
    // query ran — not merely that the result happened to be empty.
    db.close();

    expect(store.findByRuns([])).toEqual([]);

    // Negative control ON THE CONTROL: the same call with a NON-empty list DOES
    // execute, and therefore throws on the closed handle. Without this, a
    // `findByRuns` that never queried at all would also pass the assertion
    // above, and the test would prove nothing about the short-circuit.
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
    // A relaunch mints a NEW binding row and the pre-relaunch row is retained as
    // history. The store owns no liveness column by design, so BOTH rows come
    // back and the CALLER owns the liveness intersection — that unfiltered
    // return is the contract, not a leak.
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
    // A CONSTANT clock gives every row the same `created_at`, and the two runs
    // are interleaved at creation time, so neither insertion order nor timestamp
    // can explain the result: only the `run_id, id` sort keys can. The argument
    // list is deliberately passed in the OPPOSITE run order.
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
    // The whole reason the run-id list travels as ONE json_each parameter rather
    // than N generated `?` placeholders. SQLite's default parameter ceiling is
    // 32766, so this list would be un-bindable as placeholders; through
    // `json_each` it is a single argument and the ceiling does not apply.
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

// ----------------------------------------------------------------------------
// spawn_config — the CP-005-1 recovery seam (T2.6).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — spawn_config", () => {
  it("round-trips the FULL spawn-bound record on create and on read", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    // `toStrictEqual` (not `toEqual`) so a member silently dropped to
    // `undefined` by the parser cannot pass.
    expect(created.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
    expect(store.findById(created.id)?.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
    // And the batch reader parses it identically (one `#rowToDomain` for all
    // four read paths).
    expect(store.findByRuns([RUN_ID])[0]?.spawnConfig).toStrictEqual(FULL_SPAWN_CONFIG);
  });

  it("NEGATIVE CONTROL: a create carrying an executionPosture never leaves the raw column at '{}'", () => {
    // The defect this pins is the one the T2.6 row calls out by name: a spawn
    // that realizes a spawn-bound surface but persists nothing, leaving the
    // column at its migration DEFAULT. Recovery would then rebuild a
    // posture-less resume — an UNSANDBOXED relaunch — while every accessor above
    // reported a successful create. Read through a RAW SELECT, because the
    // store's own accessor parses `'{}'` into a perfectly valid empty record and
    // could not tell the two apart.
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
    // The documented pre-B10 ambiguity: a genuinely-empty LIVE record and a
    // pre-migration DEFAULT row are indistinguishable by value. Pinned here so
    // the ambiguity is a known property rather than a surprise — Phase-3 spawn
    // writers always record `resolvedExecutablePath`, which is what resolves it
    // in practice.
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
    // The type system already makes omission unrepresentable for TS callers;
    // this pins the runtime arm. A `?? {}` floor here would be the one
    // live-write path into the pre-B10 ambiguity class pinned above, and its
    // recovery-side failure mode is a posture-less resume relaunching
    // unsandboxed — so the store refuses (internal-invariant Error, not a
    // provider refusal) and no row lands.
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
    // Same discriminator as the runtime_metadata case above: a member JSON
    // normalizes away must be absent from BOTH accessors, or `create()` and
    // `findById()` disagree about what was stored.
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: { admittedCostCapCents: 100, providerAccountId: undefined },
    });

    expect(created.spawnConfig).toStrictEqual({ admittedCostCapCents: 100 });
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
    { label: "a string where a number belongs", raw: '{"admittedCostCapCents":"2500"}' },
    { label: "a number where a string belongs", raw: '{"resolvedExecutablePath":42}' },
    { label: "a null-valued known member", raw: '{"providerAccountId":null}' },
  ];

  for (const { label, raw } of malformed) {
    it(`FAILS LOUD on ${label} in the stored column`, () => {
      // Loud failure is a SECURITY property, not tidiness: the CP-005-1 consumer
      // rebuilds ResumeSessionParams from this record, and a silently-empty
      // posture would resume UNSANDBOXED. The only safe reading of a record we
      // cannot read is a refusal.
      const store = makeStore();
      const rawId = insertRawBinding({ id: "corrupt-row-1", spawnConfig: raw });

      let thrown: unknown;
      try {
        store.findById(rawId);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // A plain internal-invariant Error — NOT the provider-output type. This
      // value is DAEMON-WRITTEN local state, so a malformation is corrupt
      // storage, not misbehaving provider input to reject at a trust boundary.
      expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
      // The row is named, so the operator can find the corrupt record.
      expect((thrown as Error).message).toContain(rawId);
      expect((thrown as Error).message).toContain("spawn_config");
    });
  }

  it("refuses an unreadable record at CREATE and lands no row", () => {
    // Reachable only from an untyped caller (the closed key set is enforced by
    // the input type), but the write path parses the serialized record BEFORE
    // the INSERT anyway — the same "a rejected input never opens a write"
    // discipline the provider-output seam follows. Without it, a record this
    // store cannot read back would land durably and only fail on the read that
    // recovery performs, which is the worst possible moment to find out.
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

// ----------------------------------------------------------------------------
// cli_version_raw / cli_version_semver — the handshake version pair (T2.6).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — cliVersion pair", () => {
  it("rejects a bounded-but-unparseable semver and a non-canonical form at the seam", () => {
    // Codex PR #372 round 1: a bounded garbage semver stored now poisons the
    // T3.23 floor comparison at a call site far from the row that produced it.
    // The seam applies the module's one semver predicate (`semver.valid(v) === v`,
    // the same one the floor gate uses), so the two layers cannot disagree.
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
    // The property reads are inside the getter/Proxy threat model: a throwing
    // accessor must never escape as the caller object's own exception text.
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
    // The seam makes a half-pair unrepresentable (one optional member carries
    // both values), so this is the only way to test the column-layer guarantee
    // the type-level one mirrors. Both directions, because the CHECK is an
    // equality between two IS NULL tests and a one-sided version would pass one.
    expect(() =>
      insertRawBinding({ id: "half-1", cliVersionRaw: CLI_VERSION.raw, cliVersionSemver: null }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertRawBinding({ id: "half-2", cliVersionRaw: null, cliVersionSemver: CLI_VERSION.semver }),
    ).toThrow(/CHECK constraint failed/);
    expect(countBindings()).toBe(0);
  });

  it("validates and persists ONE snapshot of the report — a getter cannot swap the value after validation", () => {
    // TOCTOU. The report is PROVIDER-shaped input, so nothing stops its members
    // being getters (or a Proxy). The seam therefore reads each member exactly
    // once, into a plain object, BEFORE validating — and validates, binds, and
    // returns that same object. A second read at bind time would let this
    // fixture persist its SECOND value, which no validator ever saw: the DDL
    // CHECK's length+NUL bounds would be all that stood between a hostile
    // driver and a stored lie about which build answered the handshake.
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

    // The mechanism: exactly ONE read of the provider's member.
    expect(rawReads).toBe(1);
    // …and its consequences, at all three surfaces the snapshot feeds.
    expect(readRawCliVersion(created.id)).toEqual({
      cli_version_raw: CLI_VERSION.raw,
      cli_version_semver: CLI_VERSION.semver,
    });
    expect(created.cliVersion).toStrictEqual(CLI_VERSION);
    expect(store.findById(created.id)?.cliVersion).toStrictEqual(CLI_VERSION);
  });

  it("reads a HALF-PRESENT stored pair as null — never a fabricated member", () => {
    // Only reachable by out-of-band corruption (the CHECK test above pins that),
    // which is exactly why the fold READS the both-or-neither guarantee instead
    // of assuming it. Defaulting the absent sibling to `""` would manufacture a
    // report the provider never gave — and an empty `semver` is precisely the
    // value the floor gate cannot compare, so the fabrication would travel as a
    // real reading rather than as an absent one. Both directions, because a fold
    // keyed on one column alone passes one of them by accident.
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

    // The staging really did land half-present rows (a pragma that silently
    // failed would make the assertions below vacuous).
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
    // …through every read path, since all four share one `#rowToDomain`.
    expect(store.findByRun(RUN_ID)[0]?.cliVersion).toBeNull();
    expect(store.findByRuns([RUN_ID, OTHER_RUN_ID]).map((binding) => binding.cliVersion)).toEqual([
      null,
      null,
    ]);
  });

  it("the two-column CHECK survives an UPDATE that names neither column", () => {
    // SQLite re-evaluates every CHECK on the row for EVERY write to it, not only
    // for writes that name the constrained column — the hazard migration 0011's
    // own comment calls out. The update path must therefore carry the pair
    // through untouched rather than dropping half of it.
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

      // A TYPED, leak-safe refusal — never a raw SqliteError from the DDL CHECK.
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      const validationError = thrown as ProviderOutputValidationError;
      expect(validationError.fields?.["field"]).toBe(field);
      // The daemon-controlled driver name is carried (which driver misbehaved);
      // the provider-supplied VALUES are not. The message is a fixed sentence
      // and the structured detail names the field + constraint only, so neither
      // half of the error surface can carry the offending value.
      expect(validationError.fields?.["driverName"]).toBe(DRIVER_NAME);
      expect(validationError.message).toBe("Invalid provider cli_version report.");
      const errorSurface: string = `${validationError.message} ${JSON.stringify(validationError.fields)}`;
      // The empty-string fixtures are skipped: every string contains "", so the
      // assertion would be vacuously false rather than meaningful.
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
    // Reachable only from an untyped caller — which is exactly the case the
    // guard exists for: the static type is erased at runtime, so a malformed
    // driver can ship `null` where the report belongs. `null` is passed
    // DIRECTLY (no cast through `unknown`): the guard's parameter IS `unknown`,
    // deliberately, so that a malformed report is a runtime judgement rather
    // than a static assumption. Asserted here rather than in a validator-local
    // module because this package has no dedicated `provider-output-validation`
    // test file.
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

// ----------------------------------------------------------------------------
// T3.23 — the spawned-build reading reaches the ROW
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — spawned-version carriers (T3.23)", () => {
  // `version-gate.test.ts` proves the READING is taken from the dereferenced
  // build. This proves the value that reading produced is what a later reader
  // gets back OUT OF THE DATABASE — through `create()`'s report validation, the
  // both-or-neither DDL CHECK, and the closed-key-set `spawn_config` parser,
  // none of which the in-memory projection helpers exercise. That end-to-end
  // claim is what `Spec-005 §Required Behavior` and invariant I-005-10 state:
  // the version compared, the version recorded on the binding, and the version
  // of the process that runs the session are ONE reading.
  const LAUNCHER_PATH: string = "/opt/homebrew/bin/claude";
  const DEREFERENCED_BUILD_PATH: string = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";

  // Keyed BY RESOLVED PATH — the launcher answers a build BELOW the ratified
  // floor, so a resolver that failed to dereference would not merely record the
  // wrong version: the read would REFUSE. Every assertion below therefore also
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

  // Injected rather than filesystem-backed: the drift is expressed as "realpath
  // answers a different path than the candidate", which is the whole semantic
  // content of a launcher symlink and runs on every platform (the real-symlink
  // fixture in `version-gate.test.ts` is posix-gated).
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

    // Read back out of the DATABASE — `create()`'s return value is not the
    // claim; the persisted row is.
    const found = store.findById(created.id);
    expect(found?.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
    expect(found?.spawnConfig.resolvedExecutablePath).toBe(DEREFERENCED_BUILD_PATH);
    // The launcher's own build appears NOWHERE in the row — not in the version
    // pair, and not in the spawn-bound record the resume assembly rebuilds from.
    expect(JSON.stringify(found)).not.toContain("2.1.198");
  });

  it("persists a Codex reading whose raw IS its semver (the extracted-token shape)", async () => {
    // A Codex version is EXTRACTED from the composite `userAgent`, so its `raw`
    // and `semver` are the same string — a combination the write seam's report
    // validation and the both-or-neither DDL CHECK have no other test for.
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
          // Declares the SAME executable the reading resolved — the agreement
          // arm of the carrier merge, exercised here against a real INSERT.
          spawnConfig: { ...FULL_SPAWN_CONFIG, resolvedExecutablePath: codexBuildPath },
          resumeHandle: "thread-abc",
        },
        toBindingVersionCarriers(reading),
      ),
    );

    const found = store.findById(created.id);
    expect(found?.cliVersion).toStrictEqual({ raw: "0.149.1", semver: "0.149.1" });
    // The rest of the spawn-bound record survives the carrier merge unchanged —
    // the merge REPLACES `resolvedExecutablePath` and touches nothing else.
    expect(found?.spawnConfig).toStrictEqual({
      ...FULL_SPAWN_CONFIG,
      resolvedExecutablePath: codexBuildPath,
    });
    expect(found?.resumeHandle).toBe("thread-abc");
  });
});

// ----------------------------------------------------------------------------
// T3.15 R4 — the resumed leg's spawn-bound surface, re-realized from the row.
// ----------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-005 §Required Behavior` — a resumed leg runs under the same
//     spawn-bound surface the original spawn declared. CP-005-1: resume is a
//     FRESH process spawn, so every leg is re-supplied or the relaunch sheds it
//     — a posture-less resume relaunches UNSANDBOXED.
//   I-005-5 — a binding that names no resumable provider session refuses
//     locally and classifiably rather than pushing an empty handle at the
//     provider.

describe("composeResumeSessionParams (T3.15 R4, CP-005-1)", () => {
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
      admittedCostCapCents: 2500,
      outputSpeed: "on",
      onCallbackToolCall: undefined,
      onMcpServerStatus: undefined,
    });
  });

  it("carries no `relaunch-input` member onto the resume params", () => {
    // A spread from `spawnConfig` would carry members the params shape does not
    // declare — the resolved executable path and the paying account among them,
    // which the relaunch path owns rather than the resume path.
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
    expect(Object.keys(params)).not.toContain("providerAccountId");
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
    // The dispatcher's only correct response is to relaunch fresh rather than
    // retry, and it cannot make that choice off a message string.
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
    // The honest absent case: an empty `spawn_config` yields absent legs, which
    // the driver then treats as "not declared" — never as a default posture.
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
    expect(params.admittedCostCapCents).toBeUndefined();
    expect(params.outputSpeed).toBeUndefined();
  });

  it("re-realizes the accelerated-output leg, which a resume would otherwise shed", () => {
    // The FIFTH resume leg, and the reason it is one rather than a
    // `relaunch-input`: the accelerated-output axis is realized at spawn on the
    // one provider that publishes it, and it is a parameter the DRIVER takes —
    // unlike the paying account and the resolved binary, which the spawn
    // resolution consumes before the driver is ever called. A resume that
    // dropped it would relaunch at the provider's default speed while every
    // layer above still read the operator's accepted choice.
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
    // `cooldown` is a state the Claude surface REPORTS and that no participant
    // may request — it is a rate-limit condition, not a setting. It reaches the
    // daemon on the binding-held `ProviderOutputSpeedState`, which is discarded
    // with the session. If it could ever reach this column, a restart would
    // re-realize a spawn asking for a level the provider does not accept, and a
    // transient condition would read as an accepted choice forever.
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

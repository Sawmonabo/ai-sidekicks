// The runtime binding store over real SQLite: the row recovery resumes from round-trips, the
// provider's contract version and resume handle are bounded before they land, on create and on
// update alike, a run's lookups return its superseded rows too, a corrupt spawn-bound record fails
// loud instead of resuming unsandboxed, so does a stored driver name that names no provider, and
// the version pair holds its CHECK.

import { DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/methods";
import { describe, expect, it } from "vitest";

import { captureRejection, captureThrow } from "../../__fixtures__/capture-failure.js";
import type { DriverCliVersionReport } from "../driver/contract.js";
import { ProviderOutputValidationError, RESUME_HANDLE_MAX_LEN } from "../output-validation.js";
import {
  CONTRACT_VERSION,
  DRIVER_NAME,
  FULL_SPAWN_CONFIG,
  OTHER_RUN_ID,
  readRawSpawnConfig,
  RUN_ID,
  useBindingDatabase,
} from "./runtime-binding-store.test-support.js";

const database = useBindingDatabase();

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
  database
    .connection()
    .prepare(
      `INSERT INTO runtime_bindings
         (id, run_id, driver_name, contract_version, cli_version_raw, cli_version_semver, ` +
        `resume_handle, spawn_config, runtime_metadata, created_at, updated_at)
       VALUES
         (@id, @run_id, @driver_name, @contract_version, @cli_version_raw, @cli_version_semver, ` +
        `NULL, @spawn_config, '{}', @created_at, @created_at)`,
    )
    .run({
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
  const info = database
    .connection()
    .prepare(`UPDATE runtime_bindings SET spawn_config = ? WHERE id = ?`)
    .run(rawSpawnConfig, id);
  if (info.changes !== 1) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
}

function readRawCliVersion(id: string): {
  cli_version_raw: string | null;
  cli_version_semver: string | null;
} {
  const row = database
    .connection()
    .prepare(`SELECT cli_version_raw, cli_version_semver FROM runtime_bindings WHERE id = ?`)
    .get(id) as { cli_version_raw: string | null; cli_version_semver: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`no runtime_bindings row for id ${id}`);
  }
  return row;
}

// Reads the mutable columns raw: the store's accessors refuse a corrupt row, so they cannot
// show what a refused write left behind.
function readRawMutableColumns(id: string): {
  contract_version: string;
  resume_handle: string | null;
  runtime_metadata: string;
  updated_at: string;
} {
  const row = database
    .connection()
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
  const row = database
    .connection()
    .prepare(`SELECT count(*) AS total FROM runtime_bindings`)
    .get() as { total: number };
  return row.total;
}

describe("RuntimeBindingStore — CRUD round-trips", () => {
  it("create → findById round-trips every column", async () => {
    const store = database.makeStore();
    const created = await store.create({
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

  it("findByRun and findByRuns return every binding of a run, superseded ones too", async () => {
    // A relaunch mints a new binding row and keeps the old one as history. The store has no
    // liveness column, so both come back and the caller owns the liveness intersection.
    const store = database.makeStore();
    const beforeRelaunch = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      resumeHandle: "handle-before-relaunch",
      spawnConfig: {},
    });
    const afterRelaunch = await store.create({
      runId: RUN_ID,
      driverName: "codex",
      contractVersion: "2.0.0",
      resumeHandle: "handle-after-relaunch",
      spawnConfig: {},
    });
    // A binding on a DIFFERENT run must not appear.
    await store.create({
      runId: OTHER_RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
    });

    const forRun = store.findByRun(RUN_ID);
    expect(forRun.map((binding) => binding.id)).toEqual([beforeRelaunch.id, afterRelaunch.id]);
    expect(store.findByRuns([RUN_ID])).toEqual(forRun);
  });

  it("update mutates the patched fields only, bumps updatedAt, preserves createdAt", async () => {
    const store = database.makeStore();
    const created = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "keep-me",
      runtimeMetadata: { a: 1 },
    });

    const updated = await store.update(created.id, {
      contractVersion: "1.1.0",
      runtimeMetadata: { a: 2, b: 3 },
    });

    expect(updated).toBeDefined();
    expect(updated?.contractVersion).toBe("1.1.0");
    expect(updated?.runtimeMetadata).toEqual({ a: 2, b: 3 });
    // A key the patch leaves out is untouched.
    expect(updated?.resumeHandle).toBe("keep-me");
    expect(updated?.id).toBe(created.id);
    expect(updated?.runId).toBe(created.runId);
    expect(updated?.driverName).toBe(created.driverName);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
    expect(updated?.updatedAt).not.toBe(updated?.createdAt);

    expect(store.findById(created.id)).toEqual(updated);
  });

  it("update can clear resumeHandle to null (COALESCE-binding would silently no-op)", async () => {
    const store = database.makeStore();
    const created = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      spawnConfig: {},
      resumeHandle: "present-handle",
    });

    const cleared = await store.update(created.id, { resumeHandle: null });
    expect(cleared?.resumeHandle).toBeNull();
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("findResumableBindings returns only bindings with a non-null resume_handle", async () => {
    const store = database.makeStore();
    const withHandle = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
      resumeHandle: "resumable-1",
    });
    // No handle: must not appear.
    await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      spawnConfig: {},
    });
    const otherWithHandle = await store.create({
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

// A value the provider sent, refused before it lands, with the field it failed named.
const REFUSED_PROVIDER_VALUES: readonly {
  readonly field: "contract_version" | "resume_handle";
  readonly label: string;
  readonly patch: { contractVersion?: string; resumeHandle?: string };
}[] = [
  {
    field: "contract_version",
    label: "one character over its cap",
    patch: {
      contractVersion: "1.0.0-" + "a".repeat(DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN - 6 + 1),
    },
  },
  ...["1.0", "1", "01.2.3", "v1.2.3", " 1.2.3 ", "1.2.3+build.5", ""].map((version) => ({
    field: "contract_version" as const,
    label: `non-canonical ${JSON.stringify(version)}`,
    patch: { contractVersion: version },
  })),
  {
    field: "resume_handle",
    label: "one character over its cap",
    patch: { resumeHandle: "h".repeat(RESUME_HANDLE_MAX_LEN + 1) },
  },
  // The /\S/ hardening beyond the DB CHECK.
  { field: "resume_handle", label: "whitespace only", patch: { resumeHandle: "   " } },
  { field: "resume_handle", label: "holding a NUL", patch: { resumeHandle: "before\0after" } },
];

describe("RuntimeBindingStore — the provider's contract version and resume handle", () => {
  it.each(REFUSED_PROVIDER_VALUES)(
    "refuses a $field $label on create, naming the field",
    async ({ field, patch }) => {
      const store = database.makeStore();
      const thrown = await captureRejection(() =>
        store.create({
          runId: RUN_ID,
          driverName: DRIVER_NAME,
          contractVersion: CONTRACT_VERSION,
          spawnConfig: {},
          ...patch,
        }),
      );
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe(field);
      expect(countBindings()).toBe(0);
    },
  );

  it.each(REFUSED_PROVIDER_VALUES)(
    "refuses an update to a $field $label and leaves the row unchanged",
    async ({ patch }) => {
      const store = database.makeStore();
      const created = await store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: "1.0.0",
        spawnConfig: {},
        resumeHandle: "original",
      });

      await expect(store.update(created.id, patch)).rejects.toThrow(ProviderOutputValidationError);

      // Validation runs before the write, so the row is untouched.
      const after = store.findById(created.id);
      expect(after?.contractVersion).toBe("1.0.0");
      expect(after?.resumeHandle).toBe("original");
      expect(after?.updatedAt).toBe(created.updatedAt);
    },
  );

  it(
    "REFUSES an update onto a row whose stored " +
      "spawn_config is unreadable, and commits NOTHING",
    async () => {
      // Committing a patch onto an unreadable record would make it newer, still unreadable, and
      // stamped with an `updated_at` implying this daemon wrote it, hiding the corruption from
      // the recovery read. So the parse runs before the UPDATE is sent, and its throw stops the
      // write.
      const store = database.makeStore();
      const created = await store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: "1.0.0",
        resumeHandle: "handle-before",
        spawnConfig: FULL_SPAWN_CONFIG,
        runtimeMetadata: { attempt: 1 },
      });
      corruptSpawnConfigOutOfBand(created.id, "{not json at all");

      const thrown = await captureRejection(() =>
        store.update(created.id, { contractVersion: "1.0.1", resumeHandle: "handle-after" }),
      );

      // A plain internal-invariant Error naming the row: corrupt daemon-written storage, not
      // provider input.
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ProviderOutputValidationError);
      expect((thrown as Error).message).toContain(created.id);
      expect((thrown as Error).message).toContain("spawn_config");

      // Read raw: the store's accessors refuse this row and could not tell "never written" from
      // "unreadable".
      const raw = readRawMutableColumns(created.id);
      expect(raw.contract_version).toBe("1.0.0");
      expect(raw.resume_handle).toBe("handle-before");
      expect(raw.runtime_metadata).toBe(JSON.stringify({ attempt: 1 }));
      // `updated_at` is the sharpest witness: an UPDATE that reached the DB would have moved it
      // from the advancing clock even if the other columns matched.
      expect(raw.updated_at).toBe(created.updatedAt);
      expect(readRawSpawnConfig(database.connection(), created.id)).toBe("{not json at all");
    },
  );
});

describe("RuntimeBindingStore — spawn_config", () => {
  it("round-trips the FULL spawn-bound record on create and on read", async () => {
    const store = database.makeStore();
    const created = await store.create({
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
      const store = database.makeStore();
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
    const store = database.makeStore();
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
  it("round-trips the pair and stores BOTH columns", async () => {
    const store = database.makeStore();
    const created = await store.create({
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

  it("keeps an unparsed printed version; refuses a parse with no printed version", async () => {
    const store = database.makeStore();
    const created = await store.create({
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

  it("the two-column CHECK survives an UPDATE that names neither column", async () => {
    // SQLite re-evaluates every CHECK on a row for every write to it, so the update path must
    // carry the pair through untouched.
    const store = database.makeStore();
    const created = await store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      cliVersion: CLI_VERSION,
      spawnConfig: FULL_SPAWN_CONFIG,
    });

    const updated = await store.update(created.id, { contractVersion: "1.0.1" });

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

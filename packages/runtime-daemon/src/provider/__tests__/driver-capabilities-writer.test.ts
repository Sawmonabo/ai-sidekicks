// DriverCapabilitiesWriter behavior.
//
// Exercises the three-table write and cold-start hydration over a real SQLite handle from
// `openDatabase(":memory:")`, so the driver tables and their CHECK constraints all fire.
//
// Coverage map:
//   * the flag matrix round-trips through `driver_capabilities` and `hydrate`, so a
//     `false`/absent flag is faithfully reconstructed.
//   * the declare and refresh paths (created / changed / unchanged).
//   * `hydrate` reconstructs the COMPLETE nested `GetCapabilitiesResult`, `cliVersion`
//     included from the `driver_contract_meta` currency pair, and reports a typed MISS
//     (with its cause) rather than fabricating a version it does not hold.
//   * a rejected declare writes no row to any of the three tables.
//   * a storage failure partway through a declare rolls back all three tables.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  type ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  DriverCapabilitiesWriter,
  type DriverCapabilityHydrationResult,
} from "../driver-capabilities-writer.js";
import { DRIVER_OUTPUT_SPEED_LEVELS } from "../driver-output-speed.js";
import {
  CLI_VERSION_RAW_MAX_LEN,
  CLI_VERSION_SEMVER_MAX_LEN,
  ProviderOutputValidationError,
} from "../provider-output-validation.js";

// ----------------------------------------------------------------------------
// Fixtures + per-test lifecycle
// ----------------------------------------------------------------------------

const DRIVER_NAME: string = "claude";
const CONTRACT_VERSION: string = "1.2.3";

// The full flag matrix every snapshot must answer (Record<DriverCapabilityFlag>
// — un-omittable by the contract type). Sourced from the canonical
// `DRIVER_CAPABILITY_FLAGS` array (no hardcoded copy): every flag defaults
// false, then `resume` + `tool_calls` are the baseline-true pair, then overrides.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

// The REQUIRED `cliVersion` reading every advertised snapshot carries. It
// describes the LIVE READING rather than a capability, which is why the writer
// persists it (into `driver_contract_meta.cli_version_raw` / `cli_version_semver`,
// so `hydrate()` can return the complete `GetCapabilitiesResult`) while keeping it
// OUT of change-detection.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// A SECOND, structurally distinct reading of the same driver — a provider
// upgrade. Used by the version-only arms, where the capability snapshot must be
// byte-identical and ONLY the version moves.
const UPGRADED_CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.9.001 (build 12)",
  semver: "2.9.1",
};

function makeResult(overrides: Partial<GetCapabilitiesResult> = {}): GetCapabilitiesResult {
  return {
    capabilities: {
      flags: makeFlags(),
      contractVersion: CONTRACT_VERSION,
    },
    tools: [],
    cliVersion: CLI_VERSION_REPORT,
    ...overrides,
  };
}

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

// An ADVANCING clock: each call returns a distinct timestamp, so a "no write on
// unchanged" assertion is non-vacuous.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

function makeWriter(now: () => string = makeAdvancingClock()): DriverCapabilitiesWriter {
  return new DriverCapabilitiesWriter(db, now);
}

// ---- Direct table readers (raw rows) ----

function countCapabilityRows(driverName: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM driver_capabilities WHERE driver_name = ?`)
    .get(driverName) as { readonly n: number };
  return row.n;
}

function readToolNames(driverName: string): string[] {
  const rows = db
    .prepare(`SELECT tool_name FROM driver_tools WHERE driver_name = ? ORDER BY tool_name`)
    .all(driverName) as ReadonlyArray<{ readonly tool_name: string }>;
  return rows.map((row) => row.tool_name);
}

function readToolIdempotencyClass(driverName: string, toolName: string): string | undefined {
  const row = db
    .prepare(`SELECT idempotency_class FROM driver_tools WHERE driver_name = ? AND tool_name = ?`)
    .get(driverName, toolName) as { readonly idempotency_class: string } | undefined;
  return row?.idempotency_class;
}

function countContractMetaRows(driverName: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly n: number };
  return row.n;
}

function readContractVersion(driverName: string): string | undefined {
  const row = db
    .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly contract_version: string } | undefined;
  return row?.contract_version;
}

interface RawCliVersionPair {
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
}

/**
 * The DURABLE currency pair, read by DIRECT SELECT off the raw columns rather than through
 * `hydrate()`. That is the point: routing this assertion through the writer's own reader would let
 * a symmetric bug (write the wrong thing, read it back) pass.
 */
function readCliVersionPair(driverName: string): RawCliVersionPair | undefined {
  return db
    .prepare(
      `SELECT cli_version_raw, cli_version_semver
         FROM driver_contract_meta
        WHERE driver_name = ?`,
    )
    .get(driverName) as RawCliVersionPair | undefined;
}

/**
 * `driver_contract_meta.refreshed_at` — the witness that makes "zero-write unchanged"
 * a NON-VACUOUS claim. The suite's clock advances on every read, so an unchanged
 * declare that touched the row would move this stamp.
 */
function readContractMetaRefreshedAt(driverName: string): string | undefined {
  const row = db
    .prepare(`SELECT refreshed_at FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly refreshed_at: string } | undefined;
  return row?.refreshed_at;
}

/**
 * Narrow a {@link DriverCapabilityHydrationResult} to its HIT arm, failing the
 * test on a miss (and NAMING the miss reason, so a regression reads as "expected
 * a hit, got cli_version_missing" rather than as an opaque undefined deref).
 */
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}

// ----------------------------------------------------------------------------
// First declare — writes all three tables
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — first declare", () => {
  it("returns 'created' and writes one row per flag, one per tool, and one meta row", async () => {
    const writer = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "search", idempotency_class: "idempotent", description: "search the web" },
        { name: "write_file", idempotency_class: "compensable" },
      ],
    });

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result,
    });
    expect(outcome).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // One row per canonical flag, 2 tool rows, 1 meta row.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search", "write_file"]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Identical re-declare — unchanged, rows untouched
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — identical re-declare", () => {
  it("returns {snapshotChange:'unchanged'} and leaves the rows unchanged", async () => {
    const writer = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [{ name: "search", idempotency_class: "idempotent" }],
    });

    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result,
      }),
    ).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // Re-declare the SAME snapshot — unchanged.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });

    // Rows unchanged.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Changed declare (flag flip) — the new flag value lands in driver_capabilities
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — changed declare (flag flip)", () => {
  it("returns {snapshotChange:'changed'} and writes the flipped flag", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Flip the `steer` flag false → true.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: makeFlags({ steer: true }),
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: false });

    const steerRow = db
      .prepare(
        `SELECT supported
           FROM driver_capabilities
          WHERE driver_name = ? AND capability_flag = 'steer'`,
      )
      .get(DRIVER_NAME) as { readonly supported: number };
    expect(steerRow.supported).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// contractVersion-only bump — NOT swallowed as unchanged
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — contractVersion-only bump", () => {
  it("returns {snapshotChange:'changed'} when only the contractVersion changes", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: makeFlags(),
          contractVersion: "2.0.0",
        },
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: false });

    // The durable meta row carries the new version.
    const meta = db
      .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly contract_version: string };
    expect(meta.contract_version).toBe("2.0.0");
  });
});

// ----------------------------------------------------------------------------
// A storage failure partway through the write — all three tables or none
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — a write failing mid-declare", () => {
  it("keeps all three tables as they were, for a re-declare and a first declare", async () => {
    const writer = makeWriter();
    const priorTools: ProviderToolMetadata[] = [
      { name: "search", idempotency_class: "idempotent" },
    ];
    await writer.declare({ driverName: DRIVER_NAME, result: makeResult({ tools: priorTools }) });

    // `declare` writes the flag rows first, then replaces the tool rows, then the meta
    // row, so a failing tool insert lands after the flag rows and the tool delete ran.
    db.exec(`CREATE TRIGGER fail_driver_tool_insert BEFORE INSERT ON driver_tools
             BEGIN SELECT RAISE(ABORT, 'forced driver_tools failure'); END`);
    const flippedResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true }), contractVersion: "2.0.0" },
      tools: priorTools,
    });

    await expect(
      writer.declare({ driverName: DRIVER_NAME, result: flippedResult }),
    ).rejects.toThrow("forced driver_tools failure");
    const steerRow = db
      .prepare(
        `SELECT supported FROM driver_capabilities
          WHERE driver_name = ? AND capability_flag = 'steer'`,
      )
      .get(DRIVER_NAME) as { readonly supported: number };
    expect(steerRow.supported).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
    expect(readContractVersion(DRIVER_NAME)).toBe(CONTRACT_VERSION);

    const freshDriverName: string = "codex";
    await expect(
      writer.declare({ driverName: freshDriverName, result: flippedResult }),
    ).rejects.toThrow("forced driver_tools failure");
    expect(countCapabilityRows(freshDriverName)).toBe(0);
    expect(readToolNames(freshDriverName)).toEqual([]);
    expect(countContractMetaRows(freshDriverName)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// cli_version currency pair — persisted on every mutating declare,
// refreshed side-band on a version-only re-declare
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — cli_version pair persistence", () => {
  it("a THROWING accessor on the report surfaces as the typed leak-safe refusal, before any txn", async () => {
    // The property reads at step (0b) are inside the
    // same getter/Proxy threat model as the swap case below — a throwing
    // accessor must surface as `ProviderOutputValidationError`, never as the
    // provider object's own exception text, and must open no transaction.
    // Built literally for the same `makeResult`-spread reason as below.
    const throwingReport: DriverCliVersionReport = {
      get raw(): string {
        throw new Error("PROVIDER-CONTROLLED-SECRET-TEXT");
      },
      semver: CLI_VERSION_REPORT.semver,
    } as DriverCliVersionReport;
    const result: GetCapabilitiesResult = {
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: [],
      cliVersion: throwingReport,
    };

    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        result,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).not.toContain("PROVIDER-CONTROLLED-SECRET-TEXT");
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("cliVersion");
    const metaCount = db
      .prepare(`SELECT COUNT(*) AS n FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly n: number };
    expect(metaCount.n).toBe(0);
  });

  it("validates and persists ONE snapshot of the report — a getter cannot swap the value after validation", async () => {
    // The write-side twin of the RuntimeBindingStore case. `declare` copies the
    // reading into a plain object at step (0b), BEFORE validating it, and every
    // later use — the assert, the `cliVersionRefreshed` comparison, the durable
    // upsert — reads that copy. A re-read after validation would persist this
    // fixture's SECOND value, which no validator saw.
    //
    // The result is built literally rather than through `makeResult`, whose
    // `...overrides` spread would itself evaluate the getter and hand `declare`
    // a plain object — the fixture would then pass no matter what `declare` did.
    let rawReads: number = 0;
    const mutatingReport: DriverCliVersionReport = {
      get raw(): string {
        rawReads += 1;
        return rawReads === 1 ? CLI_VERSION_REPORT.raw : "swapped-after-validation";
      },
      get semver(): string {
        return CLI_VERSION_REPORT.semver;
      },
    };
    const result: GetCapabilitiesResult = {
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: [],
      cliVersion: mutatingReport,
    };

    const writer = makeWriter();
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result,
    });

    expect(outcome).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });
    // The mechanism: exactly ONE read of the provider's member…
    expect(rawReads).toBe(1);
    // …and the durable row carries the value that was validated.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("writes cli_version_raw / cli_version_semver on the FIRST declare and reports cliVersionRefreshed:true", async () => {
    const writer = makeWriter();

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // Read the RAW columns by direct SELECT — the contract with not the writer's own
    // reader.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("updates the pair on a CAPABILITY-changing declare that also carries a new reading", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // A provider upgrade that ALSO flipped a capability — the pair rides the
    // ordinary mutating upsert, so both move in one transaction.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: true });
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: UPGRADED_CLI_VERSION_REPORT.raw,
      cli_version_semver: UPGRADED_CLI_VERSION_REPORT.semver,
    });
  });

  it("reports cliVersionRefreshed:false on a capability-changing declare from the SAME build (the flag is about the ROW, not about whether a statement ran)", async () => {
    // The discriminator against the naive implementation ("the upsert wrote the
    // pair, therefore true"). The upsert DOES restate the pair here; the durable
    // value is unchanged, so the flag must read `false`.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: false });
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("VERSION-ONLY change: 'unchanged' with cliVersionRefreshed:true", async () => {
    // THE SUBTLE ARM. Change-detection runs on the canonical capability snapshot
    // (flags / contractVersion / tools) and deliberately EXCLUDES `cliVersion` —
    // version metadata is cache currency, not a capability. But the mutating
    // upsert is the only OTHER writer of the pair, so without the side-write a
    // provider upgrade that changed no capability would strand the OLD version
    // forever.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    const refreshedAtBefore: string | undefined = readContractMetaRefreshedAt(DRIVER_NAME);
    expect(refreshedAtBefore).toBeDefined();

    // IDENTICAL capabilities / contractVersion / tools; ONLY the reading moves.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [{ name: "search", idempotency_class: "idempotent" }],
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });

    // (a) The snapshot stays `"unchanged"` — the side-write is NOT a fourth
    // value, because no capability moved.
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: true });

    // (b) The RAW columns carry the NEW pair — the side-write actually landed.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: UPGRADED_CLI_VERSION_REPORT.raw,
      cli_version_semver: UPGRADED_CLI_VERSION_REPORT.semver,
    });
    // (c) …and `refreshed_at` ADVANCED, which is what makes (b) a WRITE rather
    // than a row that happened to already hold those bytes. The mirror of the
    // zero-write assertion in the identical-declare arm below.
    expect(readContractMetaRefreshedAt(DRIVER_NAME)).not.toBe(refreshedAtBefore);

    // (d) The capability rows are untouched by a version-only refresh — the
    // side-write is scoped to the parent row's two version columns plus its
    // stamp, never the three-table write set.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
    expect(readContractVersion(DRIVER_NAME)).toBe(CONTRACT_VERSION);
  });

  it("IDENTICAL declare (same snapshot, same reading) writes NOTHING — refreshed_at is unmoved and cliVersionRefreshed is false", async () => {
    // The zero-write unchanged declare, made NON-VACUOUS by the advancing clock: if
    // the unchanged branch ran its side-write unconditionally, `refreshed_at` would move to a
    // later stamp and this assertion would go red.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    const refreshedAtBefore: string | undefined = readContractMetaRefreshedAt(DRIVER_NAME);
    expect(refreshedAtBefore).toBeDefined();

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });

    expect(readContractMetaRefreshedAt(DRIVER_NAME)).toBe(refreshedAtBefore);
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });
});

// ----------------------------------------------------------------------------
// Invalid cliVersion — leak-safe typed error, pre-txn (tables untouched)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid cliVersion report", () => {
  // Each case is rejected by `assertValidCliVersionReport` in the PRE-TXN ladder,
  // so the three driver tables stay untouched — the same
  // "a rejected input never opens a transaction" doctrine the contract_version
  // and tool-metadata arms assert.
  async function expectCliVersionReject(cliVersion: unknown, expectedField: string): Promise<void> {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({ cliVersion: cliVersion as DriverCliVersionReport }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe(expectedField);

    // No txn ever opened — all three driver tables untouched.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  }

  it("rejects an EMPTY raw + writes NO rows", async () => {
    await expectCliVersionReject({ raw: "", semver: "2.1.234" }, "cli_version_raw");
  });

  it("rejects an EMPTY semver + writes NO rows", async () => {
    await expectCliVersionReject({ raw: CLI_VERSION_REPORT.raw, semver: "" }, "cli_version_semver");
  });

  it("rejects an OVERSIZE raw (one byte past the 128-char CHECK literal) + writes NO rows", async () => {
    // DEFENSE-IN-DEPTH, not a tautology: the length is derived from
    // `CLI_VERSION_RAW_MAX_LEN`, which is documented in lockstep with the
    // `length(cli_version_raw) <= 128` SQL CHECK. Delete the pre-txn guard and
    // this value reaches the DB, raising a raw `SqliteError` from INSIDE the
    // write transaction — a different error type AND a violated doctrine.
    await expectCliVersionReject(
      { raw: "v".repeat(CLI_VERSION_RAW_MAX_LEN + 1), semver: "2.1.234" },
      "cli_version_raw",
    );
  });

  it("rejects an OVERSIZE semver (one byte past the 64-char CHECK literal) + writes NO rows", async () => {
    await expectCliVersionReject(
      { raw: CLI_VERSION_REPORT.raw, semver: "9".repeat(CLI_VERSION_SEMVER_MAX_LEN + 1) },
      "cli_version_semver",
    );
  });

  it("rejects a NUL-bearing raw + writes NO rows", async () => {
    // An embedded NUL is the class the SQL CHECK's `instr(..., char(0)) = 0`
    // clause exists for; the pre-txn guard must catch it FIRST so the failure is
    // a typed refusal rather than a constraint violation mid-transaction. Written
    // as the `\u0000` ESCAPE rather than a literal control byte so the fixture is
    // greppable and survives every editor/formatter round-trip.
    await expectCliVersionReject(
      { raw: "mock-provider-cli \u00002.1.234", semver: "2.1.234" },
      "cli_version_raw",
    );
  });

  it("rejects an ABSENT cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    // The static type forbids this, so it is cast through `unknown` — the
    // boundary an untyped provider actually hits. The bounded shape guard
    // (`assertValidGetCapabilitiesResultShape`) does NOT reach `cliVersion`, so
    // this arm is what proves the presence/type check is genuinely performed by
    // the imported validator rather than assumed.
    await expectCliVersionReject(undefined, "cliVersion");
  });

  it("rejects a NULL cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    await expectCliVersionReject(null, "cliVersion");
  });
});

// ----------------------------------------------------------------------------
// Tool removed on refresh — delete-then-reinsert drops the orphan row
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool removed on refresh", () => {
  it("drops a removed tool's row (delete-then-reinsert) and returns 'changed'", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable" },
        ],
      }),
    });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search", "write_file"]);

    // Refresh WITHOUT `write_file` — it must be deleted, not orphaned.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: false });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Tool with omitted idempotency_class — normalized to manual_reconcile_only
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool idempotency_class default", () => {
  it("persists an omitted idempotency_class as 'manual_reconcile_only'", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      // No `idempotency_class` on the tool — the schema default fills it.
      result: makeResult({ tools: [{ name: "search" }] }),
    });

    expect(readToolIdempotencyClass(DRIVER_NAME, "search")).toBe("manual_reconcile_only");
  });
});

// ----------------------------------------------------------------------------
// Tools in different array order — canonical-ordering guard (no spurious change)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — canonical tool ordering", () => {
  it("treats the same tool set in a DIFFERENT array order as unchanged", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable" },
        ],
      }),
    });

    // SAME tools, REVERSED order — must canonicalize to the same snapshot → unchanged.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "write_file", idempotency_class: "compensable" },
          { name: "search", idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });
  });

  it("uses the reader's BINARY collation: locale-divergent names stay unchanged", async () => {
    // `"Search"` (uppercase 'S' = 0x53) sorts BEFORE `"add"` (lowercase 'a' =
    // 0x61) under SQLite BINARY collation, but a locale-aware `localeCompare`
    // would order `"add"` first — so these two names are the discriminating case
    // that catches a write-side sort using the WRONG collation (a mismatch would
    // make the write order disagree with the `ORDER BY tool_name` reader,
    // producing a spurious "changed" AND a hydrate-order mismatch).
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "Search", idempotency_class: "idempotent" },
          { name: "add", idempotency_class: "compensable" },
        ],
      }),
    });

    // Re-declare the SAME pair in a DIFFERENT array order — must canonicalize to
    // the reader's BINARY order on BOTH sides → unchanged (the spurious-change
    // guard for collation-divergent names).
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "add", idempotency_class: "compensable" },
          { name: "Search", idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });

    // hydrate returns tools in the reader's BINARY order — `"Search"` BEFORE
    // `"add"` — proving write-side and read-side collation coincide.
    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual(["Search", "add"]);
  });

  it("sorts by UTF-8 BYTES: a supplementary-plane name re-declares unchanged", async () => {
    // The discriminating case the ASCII "Search"/"add" test CANNOT catch: JS
    // string `<`/`>` compares UTF-16 CODE UNITS, while SQLite `ORDER BY
    // tool_name` (no COLLATE → default BINARY) compares UTF-8 BYTES.
    //   * `\u{1F600}` (😀, supplementary plane) → UTF-16 lead surrogate 0xD83D,
    //     UTF-8 lead byte 0xF0.
    //   * `\u{E000}` (high-BMP private-use) → UTF-16 code unit 0xE000, UTF-8
    //     lead byte 0xEE.
    // JS says `\u{1F600}_tool < \u{E000}_tool` (0xD83D < 0xE000); SQLite BINARY
    // says the REVERSE (0xEE < 0xF0). A JS-`<` comparator would make the
    // write-side order DISAGREE with the `ORDER BY tool_name` reader, so an
    // identical re-declare would read as a spurious "changed" (array-order-sensitive
    // `isDeepStrictEqual`), AND hydrate would return a different order than the
    // write side. The UTF-8-byte comparator makes both sides coincide → unchanged
    // + matching hydrate order.
    const supplementaryName = "\u{1F600}_tool"; // 😀_tool — UTF-8 lead byte 0xF0
    const highBmpName = "\u{E000}_tool"; // private-use — UTF-8 lead byte 0xEE
    const writer = makeWriter();

    // First declare establishes the snapshot (priorSnapshot === undefined, so a
    // spurious change could only show on the IDENTICAL re-declare below).
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: supplementaryName, idempotency_class: "idempotent" },
          { name: highBmpName, idempotency_class: "compensable" },
        ],
      }),
    });

    // Re-declare the IDENTICAL set in a DIFFERENT array order. The UTF-8-byte
    // sort canonicalizes BOTH sides to the reader's BINARY order → unchanged.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: highBmpName, idempotency_class: "compensable" },
          { name: supplementaryName, idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });

    // hydrate returns tools in the reader's BINARY (UTF-8 byte) order — the
    // high-BMP 0xEE name BEFORE the supplementary-plane 0xF0 name — matching the
    // write-side sort.
    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual([highBmpName, supplementaryName]);
  });
});

// ----------------------------------------------------------------------------
// Invalid contract_version — throws + opens NO txn (tables untouched)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid contract_version", () => {
  it("throws ProviderOutputValidationError and writes NO rows (txn never opened)", async () => {
    const writer = makeWriter();
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        // Non-canonical semver — rejected at the write seam BEFORE any txn opens.
        result: makeResult({
          capabilities: {
            flags: makeFlags(),
            contractVersion: "not-a-semver",
          },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    // The tables must be completely untouched (the txn never opened).
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Invalid flags key-set — extra / missing flag rejected at the write seam
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid flags key-set", () => {
  it("throws ProviderOutputValidationError on an EXTRA (bogus) flag + writes NO rows", async () => {
    const writer = makeWriter();
    // The nominal `Record<DriverCapabilityFlag, boolean>` forbids an unknown key,
    // so build the canonical set PLUS one bogus key and widen through `unknown` to
    // reach the write-seam cardinality guard (the boundary an untyped provider
    // would hit). Derived from `makeFlags()`, so this stays an OVER-cardinality
    // case for whatever the canonical set currently is.
    const extraFlags = { ...makeFlags(), nonsense_flag: true } as unknown as Record<
      DriverCapabilityFlag,
      boolean
    >;
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: extraFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });

  it("throws ProviderOutputValidationError on a MISSING flag + writes NO rows", async () => {
    const writer = makeWriter();
    const missingFlags = makeFlags();
    // Drop a canonical flag — the guard catches the SHORT cardinality. Bracket
    // access because the `Record<string, boolean>` widening goes through an index
    // signature (`noPropertyAccessFromIndexSignature`).
    delete (missingFlags as Record<string, boolean>)["mcp"];
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: missingFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });

  it("rejects a right-COUNT flag set with one non-canonical key and writes NO rows", async () => {
    const writer = makeWriter();
    // The canonical key COUNT, but `mcp` swapped for a bogus name — the cardinality
    // check passes, so the per-flag own-key loop is the guard that must reject
    // (canonical `mcp` absent as an own key). Delete-then-add off `makeFlags()`
    // keeps the count matching whatever the canonical set currently is. This is the
    // same-cardinality wrong-key case the loop exists for; the extra/missing tests
    // trip the cardinality guard first.
    const wrongKeyFlags = makeFlags();
    delete (wrongKeyFlags as Record<string, boolean>)["mcp"];
    (wrongKeyFlags as Record<string, boolean>)["bogus_flag"] = true;
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: {
            flags: wrongKeyFlags as unknown as Record<DriverCapabilityFlag, boolean>,
            contractVersion: CONTRACT_VERSION,
          },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Malformed tool — leak-safe typed error (NOT raw ZodError), txn never opened
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — malformed tool metadata", () => {
  it("rejects a whitespace-only tool name with the leak-safe error, writes NO rows", async () => {
    const writer = makeWriter();
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        // Whitespace-only name — rejected by `wireFreeFormString`'s /\S/ guard,
        // surfaced as the leak-safe typed error (symmetric with contract_version).
        result: makeResult({ tools: [{ name: "   " }] }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Structurally-malformed result — leak-safe typed error (NOT raw TypeError),
// txn never opened
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — structurally-malformed result (leak-safe)", () => {
  // The static `GetCapabilitiesResult` type forbids these shapes, so each malformed
  // input is built and cast through `unknown` — the boundary an untyped provider
  // would actually hit. Without the structural guard, `declare` would dereference
  // `result.capabilities.<...>` / `result.tools.map(...)` and raw-throw a TypeError;
  // the leak-safe `ProviderOutputValidationError` is thrown BEFORE any txn opens,
  // so the tables stay untouched.

  async function expectLeakSafeReject(malformedResult: unknown): Promise<void> {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        result: malformedResult as GetCapabilitiesResult,
      });
    } catch (error) {
      thrown = error;
    }
    // The DISCRIMINATOR is the error CLASS (an unguarded path throws a raw TypeError).
    // The class carries no dotted `code` — the driver error-contract registry is
    // closed and has no row for this refusal — so class identity plus the
    // leak-safe structured detail IS the contract under test. The three
    // malformed shapes land on three different guard arms (`capabilities`,
    // `flags`, `tools`), so the `field` VALUE is arm-specific; what every arm
    // owes is that both structured members are present and are strings.
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    const validationError = thrown as ProviderOutputValidationError;
    expect(validationError.name).toBe("ProviderOutputValidationError");
    expect(typeof validationError.fields?.["field"]).toBe("string");
    expect(typeof validationError.fields?.["reason"]).toBe("string");

    // No txn ever opened — all three driver tables untouched.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  }

  it("rejects a null `capabilities` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({ capabilities: null, tools: [] });
  });

  it("rejects a null `flags` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({
      capabilities: { flags: null, contractVersion: CONTRACT_VERSION },
      tools: [],
    });
  });

  it("rejects a null `tools` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: null,
    });
  });

  it("NEGATIVE CONTROL: the class-identity guard is not vacuous — a raw TypeError fails it", () => {
    // `expectLeakSafeReject`'s discriminator is `toBeInstanceOf`, and the shape
    // it discriminates AGAINST is the unguarded raw TypeError. Pin that the two
    // are actually separable: a TypeError IS an `Error`, so the same assertion
    // written one level up the prototype chain would pass for both and prove
    // nothing. This is what makes the assertions above load-bearing, since no
    // dotted `code` member backs them up.
    const rawTypeError = new TypeError("Cannot read properties of null (reading 'flags')");
    expect(rawTypeError).toBeInstanceOf(Error);
    expect(rawTypeError).not.toBeInstanceOf(ProviderOutputValidationError);
    // ...and the typed refusal passes the guard the TypeError fails.
    expect(new ProviderOutputValidationError("x", { field: "tools", reason: "y" })).toBeInstanceOf(
      ProviderOutputValidationError,
    );
  });
});

// ----------------------------------------------------------------------------
// Sparse tools array — rejected at the shape guard, txn never opened
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — sparse tools array (leak-safe, shape guard)", () => {
  it("rejects a SPARSE tools array (a hole) as ProviderOutputValidationError BEFORE any txn opens — closes the undefined-hole-deref class", async () => {
    const writer = makeWriter();

    // Build a SPARSE array PROGRAMMATICALLY (not a literal `[a, , b]`, which the
    // `no-sparse-arrays` lint forbids): a valid tool at index 0, then bump the
    // length so index 1 is a HOLE (`length === 2`, only index 0 set). `Array.isArray`
    // is true for this, so a bare array-check would PASS it; the
    // `declare` `.map` then SKIPS the hole (leaving it in `normalizedTools`) and the
    // in-txn `for...of` insert loop iterates the hole as `undefined`, dereferencing
    // `undefined.name` — a raw TypeError from INSIDE an already-opened transaction.
    const validTool: ProviderToolMetadata = { name: "search", idempotency_class: "idempotent" };
    const sparseTools: ProviderToolMetadata[] = [];
    sparseTools[0] = validTool;
    sparseTools.length = 2; // index 1 is a HOLE
    expect(0 in sparseTools).toBe(true);
    expect(1 in sparseTools).toBe(false); // confirms the hole

    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Pass the sparse array by REFERENCE (object spread copies the reference, so
        // holes survive to the shape guard). NEVER route through an array spread —
        // `[...sparseTools]` densifies holes to `undefined` and defeats the test.
        result: makeResult({ tools: sparseTools }),
      });
    } catch (error) {
      thrown = error;
    }
    // Leak-safe typed error, not a raw TypeError from inside the txn.
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");
    // The reason names the density/sparse contract (the documented rule).
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/dense|sparse/i);

    // No txn ever opened — all three driver tables untouched.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// toJSON-tainted flags — snapshot clones flags into a fresh plain record
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — toJSON-tainted flags (defensive snapshot clone)", () => {
  it("clones flags to a plain record: real booleans, re-declare unchanged", async () => {
    const writer = makeWriter();

    // All canonical boolean flags, PLUS a NON-ENUMERABLE `toJSON` — so the
    // `assertValidCapabilityFlags` cardinality check (`Object.keys`, own ENUMERABLE
    // keys) still sees EXACTLY the canonical set and passes, but if flags were
    // stored by reference `JSON.stringify(snapshot)` would invoke `toJSON` and
    // serialize `{poisoned:true}` instead of the real flag booleans — tainting the
    // change-detection JSON round-trip while the raw `flags[flag]` write loop sees
    // the TRUE booleans, so an identical re-declare would report a spurious "changed".
    const taintedFlags = makeFlags({ steer: true, mcp: true }) as Record<string, unknown>;
    Object.defineProperty(taintedFlags, "toJSON", {
      value: () => ({ poisoned: true }),
      enumerable: false,
    });
    // Sanity: the own-ENUMERABLE key-set is still exactly the canonical flags
    // (the non-enumerable toJSON does not inflate cardinality).
    expect(Object.keys(taintedFlags).sort()).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: taintedFlags as unknown as Record<DriverCapabilityFlag, boolean>,
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(outcome).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // (a) The three-table write carries the TRUE boolean values. `steer` + `mcp`
    // are the true pair (alongside the makeFlags baseline `resume` + `tool_calls`);
    // the rest are false. (This would pass on a by-reference snapshot too — the
    // write loop never serializes — so it is a coherence check, NOT the class-closing
    // discriminator.)
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    const supportedByFlag = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT capability_flag, supported FROM driver_capabilities WHERE driver_name = ?`,
          )
          .all(DRIVER_NAME) as ReadonlyArray<{ capability_flag: string; supported: number }>
      ).map((row) => [row.capability_flag, row.supported === 1]),
    );
    // Derived from the SAME builder that produced the declared input, so widening
    // the flag union cannot leave a stale hand-written record asserting a subset.
    // It still closes the class: the poisoned form is `{poisoned:true}`, which no
    // canonical record equals.
    expect(supportedByFlag).toEqual(makeFlags({ steer: true, mcp: true }));

    // (b) CLASS-CLOSING DISCRIMINATOR: a SECOND identical declare (same tainted
    // object) is unchanged — change-detection compares plain booleans on BOTH sides.
    // A stored raw object's `toJSON` would serialize `{poisoned:true}` on one side
    // and diverge, reporting a spurious "changed".
    const secondOutcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: taintedFlags as unknown as Record<DriverCapabilityFlag, boolean>,
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(secondOutcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });
  });
});

// ----------------------------------------------------------------------------
// contract_version build metadata — rejected (canonical-identity), documented
// contract rule with explicit reason
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — contract_version build metadata rejected", () => {
  it("rejects `1.2.3+build.5` (SemVer section 10 build metadata) with a reason that names build metadata + writes NO rows", async () => {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Build metadata is NON-identifying (SemVer section 10): `semver.valid` STRIPS it
        // to `1.2.3`, so `=== value` fails and the canonical-identity refine
        // rejects it. Accepting it would let `+build.5` / `+build.6` denote the
        // SAME version yet store byte-different strings → a spurious "changed".
        result: makeResult({
          capabilities: { flags: makeFlags(), contractVersion: "1.2.3+build.5" },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("contract_version");
    // The surfaced reason explicitly references build metadata (the documented rule).
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/build metadata/i);

    // Rejected before any txn opened — tables untouched.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Duplicate tool names — leak-safe typed error, pre-txn (tables untouched)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — duplicate tool names", () => {
  it("rejects two tools sharing a name (field 'tools') before any txn opens", async () => {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Two tools with the SAME name — unguarded, the second `#insertToolStmt.run`
        // would violate the (driver_name, tool_name) PK INSIDE the txn, throwing a raw
        // SqliteError from an already-opened transaction. This is caught BEFORE the
        // txn opens and surfaced as the leak-safe typed error.
        result: makeResult({
          tools: [
            { name: "search", idempotency_class: "idempotent" },
            { name: "search", idempotency_class: "compensable", description: "dup" },
          ],
        }),
      });
    } catch (error) {
      thrown = error;
    }
    // The DISCRIMINATOR is the error TYPE/field (unguarded: a raw SqliteError).
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");

    // No txn ever opened — all three driver tables untouched.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// No-description re-declare — NULL→omitted round-trip compares equal (unchanged)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — no-description tool round-trip", () => {
  it("treats a re-declare of a description-less tool as unchanged (NULL round-trips)", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });

    // Re-declare the identical description-less tool. The DB stores NULL; the
    // snapshot reader omits `description` entirely, so the prior snapshot
    // compares deep-equal to the new one → unchanged.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });
  });
});

// ----------------------------------------------------------------------------
// Multi-driver isolation — no row/snapshot bleed
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — multi-driver isolation", () => {
  it("keeps each driver's rows + snapshot isolated", async () => {
    const writer = makeWriter();

    const codexResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
      tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
    });
    const claudeResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
      tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
    });

    await writer.declare({
      driverName: "codex",
      result: codexResult,
    });
    await writer.declare({
      driverName: "claude",
      result: claudeResult,
    });

    // (i) no row bleed — each driver has its own full flag-row set + own tools.
    expect(countCapabilityRows("codex")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countCapabilityRows("claude")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames("codex")).toEqual(["codex_tool"]);
    expect(readToolNames("claude")).toEqual(["claude_tool"]);

    // (ii) hydrate returns each driver's own snapshot, each carrying its own
    // cached `cliVersion` off its own `driver_contract_meta` row.
    expect(writer.hydrate("codex")).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
        tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
    expect(writer.hydrate("claude")).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
        tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
  });
});

// ----------------------------------------------------------------------------
// Snapshot reader row-set invariant — corrupt cache (a wrong flag KEY SET) throws
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — snapshot reader row-set invariant", () => {
  it("throws on a corrupt cache (a flag row deleted out-of-band)", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Corrupt the cache out-of-band: drop one canonical flag row, leaving the
    // parent contract_meta row intact (so the snapshot reader passes the existence gate).
    db.prepare(
      `DELETE FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'mcp'`,
    ).run(DRIVER_NAME);

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/row-set invariant/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/missing \[mcp\]/);
  });

  it("the flag CHECK at the database admits exactly the canonical set", async () => {
    // THE NEGATIVE CONTROL FOR THE COUNT-ONLY GUARD. A cache with the right ROW
    // COUNT and the wrong KEY SET is what a `flagRows.length` comparison would wave
    // through. Both routes to one are asserted closed: the CHECK rejects a value
    // the union does not declare, and the key uniqueness rejects a rename onto a
    // value it does. Together those make a same-count key-set corruption
    // unreachable through an admitted value — the key-set proof stays as defense in
    // depth against a CHECK wider than the union, and the missing-key direction is
    // proven by the case above.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);

    // (a) A rename onto a canonical value the driver already holds collides.
    expect(() => {
      db.prepare(
        `UPDATE driver_capabilities
            SET capability_flag = 'transcript_replay'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/UNIQUE constraint failed|PRIMARY KEY/i);

    // (b) A rename onto a value outside the canonical set is refused by the CHECK.
    expect(() => {
      db.prepare(
        `UPDATE driver_capabilities
            SET capability_flag = 'transcript_replays'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/CHECK constraint failed/i);

    // Neither attempt moved the cache, so a hydrate still succeeds — the proof
    // that this case failed for the reasons asserted and not by corrupting the
    // row set some third way.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(() => writer.hydrate(DRIVER_NAME)).not.toThrow();
  });

  it("answers `transcript_replay` after a cold-start hydrate, at full cardinality", async () => {
    // A cache written through the writer answers every canonical flag, so the
    // hydrator's exact-cardinality guard passes rather than throwing before any
    // refresh could heal it.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const hydrated: DriverCapabilityHydrationResult = writer.hydrate(DRIVER_NAME);
    expect(hydrated.hit).toBe(true);
    if (!hydrated.hit) {
      return;
    }
    expect(Object.keys(hydrated.result.capabilities.flags).sort()).toEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
    expect(hydrated.result.capabilities.flags.transcript_replay).toBe(false);
  });

  it("throws when a cache is left one flag short of the canonical set", async () => {
    // Driven through the real guard: a cache carrying every flag but one must fail
    // loudly at the first cold-start read rather than hand back a matrix missing a
    // key.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    db.prepare(
      `DELETE FROM driver_capabilities
        WHERE driver_name = ? AND capability_flag = 'transcript_replay'`,
    ).run(DRIVER_NAME);
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length - 1);

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/row-set invariant/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/missing \[transcript_replay\]/);
  });
});

// ----------------------------------------------------------------------------
// hydrate — round-trips the nested GetCapabilitiesResult; a typed miss otherwise
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — hydrate (cold-start cache read)", () => {
  it("round-trips a declared driver into the COMPLETE nested GetCapabilitiesResult (canonical tool order + cached cliVersion)", async () => {
    const writer = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "search", idempotency_class: "idempotent" },
      ],
    });
    await writer.declare({
      driverName: DRIVER_NAME,
      result,
    });

    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      hit: true,
      result: {
        capabilities: {
          flags: makeFlags(),
          contractVersion: CONTRACT_VERSION,
        },
        // Canonical (name-ascending) order — search before write_file — regardless
        // of the declared array order.
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        ],
        // `cliVersion` comes BACK from the cache, so the return is the complete
        // `GetCapabilitiesResult` a caller can hand straight to the attach-time floor
        // gate.
        cliVersion: CLI_VERSION_REPORT,
      },
    });
    // Asserted so a later widening that fabricated a provenance value here
    // goes red.
    expect(Object.keys(expectHydrationHit(hydrated))).not.toContain("detectionSource");
  });

  it("returns a MISS with reason 'never_written' for a driver that was never written", () => {
    const writer = makeWriter();
    // The REASON, not just `hit: false` — the two miss causes demand the same
    // caller behavior (refresh from the driver) but stay distinguishable, so a
    // regression collapsing them into one reason must go red HERE as well as on
    // the NULL-pair arm below.
    expect(writer.hydrate("never-seen")).toEqual({ hit: false, reason: "never_written" });
  });

  it("serves `outputSpeedLevels` on the CACHE path for a driver whose cached flag declares the axis", async () => {
    // The contract requires this member whenever `flags.output_speed` is true
    // "on either read path". The cache stores flag VALUES and no vocabulary, so
    // a hydrate that only replayed columns would hand back `output_speed: true`
    // with nothing for a client to render — well-formed and contract-invalid.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: makeFlags({ output_speed: true }),
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });

    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));

    expect(hydrated.capabilities.flags.output_speed).toBe(true);
    expect(Object.hasOwn(hydrated, "outputSpeedLevels")).toBe(true);
    // EQUAL TO THE STATIC VOCABULARY, sourced from the same table the live
    // declaration reads — asserted against the table rather than against a
    // literal, so the two paths cannot drift apart without this going red.
    expect(hydrated.outputSpeedLevels).toStrictEqual([...DRIVER_OUTPUT_SPEED_LEVELS.claude]);
    // A MUTABLE copy, never the frozen shared array: a consumer that sorts or
    // extends its own reply must not hit a TypeError, and its mutation must not
    // reach the next hydrate.
    hydrated.outputSpeedLevels?.push("turbo");
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME)).outputSpeedLevels).toStrictEqual([
      ...DRIVER_OUTPUT_SPEED_LEVELS.claude,
    ]);
  });

  it("omits `outputSpeedLevels` entirely when the cached flag does not declare the axis", async () => {
    // Absence and emptiness mean the same thing to the axis contract, and this
    // pins the honest encoding: a driver with no speed axis hydrates with the
    // member ABSENT rather than present-and-empty. `Object.hasOwn` rather than a
    // value check, because `exactOptionalPropertyTypes` makes present-undefined
    // a different shape from absent.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));

    expect(hydrated.capabilities.flags.output_speed).toBe(false);
    expect(Object.hasOwn(hydrated, "outputSpeedLevels")).toBe(false);
  });

  it("REFUSES to hydrate a cached `output_speed` for a driver that declares no vocabulary", async () => {
    // A wiring fault rather than provider misbehaviour: either a driver was
    // registered without a vocabulary entry, or the row was written out-of-band.
    // Loud is the same discipline the row-set-invariant guard takes — the quiet
    // alternative publishes a report that violates its own required-when rule.
    const writer = makeWriter();
    await writer.declare({
      driverName: "gemini",
      result: makeResult({
        capabilities: {
          flags: makeFlags({ output_speed: true }),
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });

    expect(() => writer.hydrate("gemini")).toThrow(/no output-speed vocabulary is declared/);
  });

  // hydrate routes its three-SELECT snapshot read through the
  // DEFERRED `#readTxn` (one consistent read snapshot, closing the torn-read
  // hazard a concurrent refresh would open between autocommit SELECTs). The
  // torn-read concurrency aspect is NOT deterministically unit-testable with
  // synchronous better-sqlite3 (no interleaving point between the SELECTs), so
  // this is a PATH-EXERCISING regression guard: it proves the read-transaction
  // path round-trips a multi-tool, multi-table snapshot coherently end-to-end.
  it("round-trips a multi-table snapshot THROUGH the deferred read-transaction path (torn-read guard)", async () => {
    const writer = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "add", idempotency_class: "idempotent" },
        { name: "search", idempotency_class: "manual_reconcile_only" },
      ],
    });
    await writer.declare({
      driverName: DRIVER_NAME,
      result,
    });

    // The nested GetCapabilitiesResult reconstructed via the deferred read txn:
    // contractVersion (contract_meta), flags (driver_capabilities), and tools
    // (driver_tools) all cohere from the SAME consistent snapshot, in canonical
    // (name-ascending) order.
    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
        tools: [
          { name: "add", idempotency_class: "idempotent" },
          { name: "search", idempotency_class: "manual_reconcile_only" },
          { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        ],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
  });

  // --------------------------------------------------------------------------
  // NULL currency pair — a cache MISS, never a fabricated version
  // --------------------------------------------------------------------------

  it("misses 'cli_version_missing' on a NULL stored pair, never inventing one", async () => {
    // THE NEGATIVE CONTROL FOR THE NULL-PAIR BRANCH. The rule on the
    // `cli_version_semver` column: "cold-start hydration MUST treat a NULL pair as a cache miss and
    // refresh from the driver — the required `GetCapabilitiesResult.cliVersion` is never fabricated
    // from cache". Delete the branch that implements it and this test goes red three ways at once:
    // the assertion is on `{ hit: false, reason }` as a WHOLE, so a hit arm carrying `{ raw: null,
    // semver: null }`, a hit arm carrying `{ raw: "", semver: "" }`, and a miss reporting the OTHER
    // reason (`"never_written"`) all fail. The `reason` VALUE is what closes the last of those —
    // `expect(hydrated.hit).toBe(false)` alone would pass a branch that returned the wrong cause.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    // Sanity: the pair IS populated by the declare, so the NULL-ing below is a
    // real state change rather than a no-op that would make this arm vacuous.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });

    // A NULL-pair row, reproduced out-of-band: the parent row EXISTS (so the
    // existence gate passes and the snapshot reader reconstructs a full, valid
    // capability matrix) but the currency pair is NULL. Both columns together —
    // the table's both-or-neither CHECK rejects NULL-ing just one.
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);

    expect(writer.hydrate(DRIVER_NAME)).toEqual({
      hit: false,
      reason: "cli_version_missing",
    });
    // And the miss is about the VERSION, not about the capability rows — those
    // are all still present and reconstructible. Asserting this is what keeps
    // the two miss reasons from being read as interchangeable.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });

  it("self-heals a NULL-pair row on the next declare: the miss becomes a hit and cliVersionRefreshed reports the repair", async () => {
    // The complement of the arm above. A NULL pair is a MISS, and the caller's
    // prescribed remedy is to refresh from the driver — which lands back here as
    // a declare. That declare's capability snapshot is IDENTICAL, so it takes
    // the unchanged branch; without that branch's side-write the row would stay
    // NULL forever and the driver would be permanently un-hydratable.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);
    expect(writer.hydrate(DRIVER_NAME)).toEqual({ hit: false, reason: "cli_version_missing" });

    // The remedy: re-declare the SAME capability snapshot with a live reading.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    // The capabilities did not change, but the pair WAS repaired.
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: true });
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME)).cliVersion).toEqual(CLI_VERSION_REPORT);
  });
});

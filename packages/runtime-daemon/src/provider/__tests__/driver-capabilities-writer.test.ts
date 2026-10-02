// DriverCapabilitiesWriter: the three-table write and cold-start hydration, over a real SQLite
// handle from `openDatabase(":memory:")` so the driver tables and their CHECK constraints fire.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureRejection } from "../../workspace/__tests__/workspace.test-support.js";
import {
  DRIVER_CAPABILITY_FLAGS,
  type ProviderName,
  type ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { makeAdvancingClock } from "../__fixtures__/advancing-clock.js";
import {
  CLI_VERSION_REPORT,
  CONTRACT_VERSION,
  expectHydrationHit,
  makeFlags,
  makeResult,
} from "../__fixtures__/capability-results.js";
import { DriverCapabilitiesWriter } from "../driver-capabilities-writer.js";
import { ProviderOutputValidationError } from "../provider-output-validation.js";
import type { DriverCliVersionReport, GetCapabilitiesResult } from "../provider-driver.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../provider-driver-descriptors.js";

const DRIVER_NAME: ProviderName = "claude";

// A provider upgrade: the version-only cases keep the capability snapshot identical and change
// only this.
const UPGRADED_CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.9.001 (build 12)",
  semver: "2.9.1",
};

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

function makeWriter(now: () => string = makeAdvancingClock()): DriverCapabilitiesWriter {
  return new DriverCapabilitiesWriter(db, now);
}

// Direct table readers (raw rows).

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
 * The stored version pair, read straight off the columns rather than through `hydrate()`, which
 * would let a symmetric write-and-read bug pass.
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

/** `driver_contract_meta.refreshed_at`: moves whenever a declare touches the row. */
function readContractMetaRefreshedAt(driverName: string): string | undefined {
  const row = db
    .prepare(`SELECT refreshed_at FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly refreshed_at: string } | undefined;
  return row?.refreshed_at;
}

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

    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search", "write_file"]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });
});

describe("DriverCapabilitiesWriter — changed declare (flag flip)", () => {
  it("returns {snapshotChange:'changed'} and writes the flipped flag", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

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

    const meta = db
      .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly contract_version: string };
    expect(meta.contract_version).toBe("2.0.0");
  });
});

describe("DriverCapabilitiesWriter — contract_version is canonical semver", () => {
  it("rejects `1.2.3+build.5` (SemVer section 10 build metadata) with a reason that names build metadata + writes NO rows", async () => {
    const writer = makeWriter();
    const thrown = await captureRejection(async () => {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Build metadata does not identify a version: `semver.valid` strips it, so the
        // canonical-identity check rejects it. Accepting it would store byte-different strings
        // for the same version and report a spurious "changed".
        result: makeResult({
          capabilities: { flags: makeFlags(), contractVersion: "1.2.3+build.5" },
        }),
      });
    });
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("contract_version");
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/build metadata/i);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — a write failing mid-declare", () => {
  it("keeps all three tables as they were, for a re-declare and a first declare", async () => {
    const writer = makeWriter();
    const priorTools: ProviderToolMetadata[] = [
      { name: "search", idempotency_class: "idempotent" },
    ];
    await writer.declare({ driverName: DRIVER_NAME, result: makeResult({ tools: priorTools }) });

    // `declare` writes the flag rows, then the tool rows, then the meta row, so a failing tool
    // insert lands after the flag rows are written.
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

    const freshDriverName: ProviderName = "codex";
    await expect(
      writer.declare({ driverName: freshDriverName, result: flippedResult }),
    ).rejects.toThrow("forced driver_tools failure");
    expect(countCapabilityRows(freshDriverName)).toBe(0);
    expect(readToolNames(freshDriverName)).toEqual([]);
    expect(countContractMetaRows(freshDriverName)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — cli_version pair persistence", () => {
  it("updates the pair on a CAPABILITY-changing declare that also carries a new reading", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // A provider upgrade that also flipped a capability: both move in one transaction.
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

  it("VERSION-ONLY change: 'unchanged' with cliVersionRefreshed:true", async () => {
    // Change detection excludes `cliVersion` (cache currency, not a capability), so without a
    // side-write a provider upgrade that changed no capability would leave the old version stored.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    const refreshedAtBefore: string | undefined = readContractMetaRefreshedAt(DRIVER_NAME);
    expect(refreshedAtBefore).toBeDefined();

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [{ name: "search", idempotency_class: "idempotent" }],
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });

    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: true });

    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: UPGRADED_CLI_VERSION_REPORT.raw,
      cli_version_semver: UPGRADED_CLI_VERSION_REPORT.semver,
    });
    // The stamp advanced, so the pair was written rather than already holding these bytes.
    expect(readContractMetaRefreshedAt(DRIVER_NAME)).not.toBe(refreshedAtBefore);

    // The side-write touches only the version columns and the stamp, not the capability rows.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
    expect(readContractVersion(DRIVER_NAME)).toBe(CONTRACT_VERSION);
  });
});

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

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "changed", cliVersionRefreshed: false });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

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

    expect(countCapabilityRows("codex")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countCapabilityRows("claude")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames("codex")).toEqual(["codex_tool"]);
    expect(readToolNames("claude")).toEqual(["claude_tool"]);

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

describe("DriverCapabilitiesWriter — snapshot reader row-set invariant", () => {
  it("throws on a corrupt cache (a flag row deleted out-of-band)", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Drop one flag row out-of-band, leaving the parent `driver_contract_meta` row intact.
    db.prepare(
      `DELETE FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'mcp'`,
    ).run(DRIVER_NAME);

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/row-set invariant/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/missing \[mcp\]/);
  });

  it("the flag CHECK at the database admits exactly the canonical set", async () => {
    // A cache with the right row count and the wrong key set would pass a count-only guard. Both
    // routes to one are closed: the CHECK rejects an undeclared value and the primary key rejects
    // a rename onto an existing one.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);

    // A rename onto a value the driver already holds collides.
    expect(() => {
      db.prepare(
        `UPDATE driver_capabilities
            SET capability_flag = 'context_compaction'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/UNIQUE constraint failed|PRIMARY KEY/i);

    // A rename onto a value outside the canonical set is refused by the CHECK.
    expect(() => {
      db.prepare(
        `UPDATE driver_capabilities
            SET capability_flag = 'context_compactions'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/CHECK constraint failed/i);

    // Neither attempt changed the cache.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(() => writer.hydrate(DRIVER_NAME)).not.toThrow();
  });
});

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
        // Name-ascending order regardless of the declared order.
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        ],
        // `cliVersion` comes back from the cache, so the result is complete.
        cliVersion: CLI_VERSION_REPORT,
      },
    });
    // A hydrate must not invent a detection source.
    expect(Object.keys(expectHydrationHit(hydrated))).not.toContain("detectionSource");
  });

  it("returns a MISS with reason 'never_written' for a driver that was never written", () => {
    const writer = makeWriter();
    // The two miss causes need the same caller behavior but must stay distinguishable.
    expect(writer.hydrate("codex")).toEqual({ hit: false, reason: "never_written" });
  });

  it("misses 'cli_version_missing' on a NULL stored pair, never inventing one", async () => {
    // A NULL pair must be a cache miss, never a fabricated version. The whole
    // `{ hit: false, reason }` is asserted so a wrong miss reason also fails.
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    // The pair is populated first, so NULL-ing it below is a real change.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });

    // Both columns together, because the table's CHECK rejects NULL-ing just one.
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);

    expect(writer.hydrate(DRIVER_NAME)).toEqual({
      hit: false,
      reason: "cli_version_missing",
    });
    // The capability rows are still present; only the version is missing.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });

  it("self-heals a NULL-pair row on the next declare: the miss becomes a hit and cliVersionRefreshed reports the repair", async () => {
    // The refresh after a miss is a declare with an identical snapshot; without the unchanged
    // branch's side-write the row would stay NULL and the driver could never hydrate.
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

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: true });
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME)).cliVersion).toEqual(CLI_VERSION_REPORT);
  });

  it("serves `outputSpeedLevels` on the CACHE path for a driver whose cached flag declares the axis", async () => {
    // The result must carry this member whenever `flags.output_speed` is true. The cache stores
    // flag values but no vocabulary, so a hydrate that only replayed columns would omit it.
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
    // Compared with the table the live declaration reads, so the two paths cannot drift.
    expect(hydrated.outputSpeedLevels).toStrictEqual([
      ...PROVIDER_DRIVER_DESCRIPTORS.claude.outputSpeedLevels,
    ]);
  });
});

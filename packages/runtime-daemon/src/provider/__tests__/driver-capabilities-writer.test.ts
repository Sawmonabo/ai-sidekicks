// DriverCapabilitiesWriter: the three-table write and cold-start hydration, over a real SQLite
// handle from `openDatabase(":memory:")` so the driver tables and their CHECK constraints fire.

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

const DRIVER_NAME: string = "claude";
const CONTRACT_VERSION: string = "1.2.3";

// The full flag matrix every snapshot must answer, built from `DRIVER_CAPABILITY_FLAGS`: every
// flag false, then `resume` and `tool_calls` true, then the overrides.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

// The `cliVersion` reading every snapshot carries. It describes the live reading, not a
// capability, so the writer persists it (so `hydrate()` can return the complete result) but keeps
// it out of change detection.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// A provider upgrade: the version-only cases keep the capability snapshot identical and change
// only this.
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

// Each call returns a later timestamp, so a "no write on unchanged" assertion can fail.
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

/** Narrows a hydration result to its hit, failing with the miss reason otherwise. */
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
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

    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });

    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
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

    const freshDriverName: string = "codex";
    await expect(
      writer.declare({ driverName: freshDriverName, result: flippedResult }),
    ).rejects.toThrow("forced driver_tools failure");
    expect(countCapabilityRows(freshDriverName)).toBe(0);
    expect(readToolNames(freshDriverName)).toEqual([]);
    expect(countContractMetaRows(freshDriverName)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — cli_version pair persistence", () => {
  it("a THROWING accessor on the report surfaces as the typed leak-safe refusal, before any txn", async () => {
    // A throwing accessor must surface as `ProviderOutputValidationError`, never as the provider
    // object's own exception text, and must open no transaction. Built literally so the
    // `makeResult` spread does not evaluate the getter.
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
    // `declare` copies the reading into a plain object before validating it and uses only that
    // copy, so a re-read after validation would persist this fixture's second value, which no
    // validator saw. Built literally: the `makeResult` spread would evaluate the getter and hand
    // `declare` a plain object.
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
    expect(rawReads).toBe(1);
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

  it("reports cliVersionRefreshed:false on a capability-changing declare from the SAME build (the flag is about the ROW, not about whether a statement ran)", async () => {
    // The upsert restates the pair here, but the stored value is unchanged, so the flag is false.
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

  it("IDENTICAL declare (same snapshot, same reading) writes NOTHING — refreshed_at is unmoved and cliVersionRefreshed is false", async () => {
    // The advancing clock makes this fail if the unchanged branch wrote unconditionally.
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

describe("DriverCapabilitiesWriter — invalid cliVersion report", () => {
  // `assertValidCliVersionReport` rejects each case before any transaction opens, so the three
  // driver tables stay untouched.
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
    // `CLI_VERSION_RAW_MAX_LEN` mirrors the `length(cli_version_raw) <= 128` CHECK. Without the
    // guard the value would reach the database and raise a raw `SqliteError` mid-transaction.
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
    // The CHECK's `instr(..., char(0)) = 0` clause covers a NUL, but the guard must refuse it
    // first as a typed error. Written as the `\u0000` escape so the fixture survives editors.
    await expectCliVersionReject(
      { raw: "mock-provider-cli \u00002.1.234", semver: "2.1.234" },
      "cli_version_raw",
    );
  });

  it("rejects an ABSENT cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    // Cast through `unknown` because the type forbids it. The shape guard
    // (`assertValidGetCapabilitiesResultShape`) does not reach `cliVersion`, so this proves the
    // validator checks presence and type.
    await expectCliVersionReject(undefined, "cliVersion");
  });

  it("rejects a NULL cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    await expectCliVersionReject(null, "cliVersion");
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

    // The same tools in reversed order canonicalize to the same snapshot.
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
    // `"Search"` (0x53) sorts before `"add"` (0x61) under SQLite BINARY collation, but
    // `localeCompare` orders `"add"` first. A write-side sort with the wrong collation would
    // disagree with the `ORDER BY tool_name` reader, giving a spurious "changed" and a different
    // hydrate order.
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

    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual(["Search", "add"]);
  });

  it("sorts by UTF-8 BYTES: a supplementary-plane name re-declares unchanged", async () => {
    // JS `<` compares UTF-16 code units while SQLite `ORDER BY tool_name` compares UTF-8 bytes.
    // `\u{1F600}` is lead surrogate 0xD83D in UTF-16 and lead byte 0xF0 in UTF-8; `\u{E000}` is
    // 0xE000 and 0xEE. JS orders the first before the second, SQLite the reverse, so a JS `<`
    // comparator would make an identical re-declare read as "changed" and reorder hydrate output.
    const supplementaryName = "\u{1F600}_tool";
    const highBmpName = "\u{E000}_tool";
    const writer = makeWriter();

    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: supplementaryName, idempotency_class: "idempotent" },
          { name: highBmpName, idempotency_class: "compensable" },
        ],
      }),
    });

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

    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual([highBmpName, supplementaryName]);
  });
});

describe("DriverCapabilitiesWriter — invalid contract_version", () => {
  it("throws ProviderOutputValidationError and writes NO rows (txn never opened)", async () => {
    const writer = makeWriter();
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: {
            flags: makeFlags(),
            contractVersion: "not-a-semver",
          },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — invalid flags key-set", () => {
  it("throws ProviderOutputValidationError on an EXTRA (bogus) flag + writes NO rows", async () => {
    const writer = makeWriter();
    // The type forbids an unknown key, so widen through `unknown` to reach the cardinality guard.
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
    // Bracket access because of `noPropertyAccessFromIndexSignature`.
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
    // The right count with `mcp` swapped for a bogus name passes the cardinality check, so the
    // per-flag own-key loop must reject it.
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

describe("DriverCapabilitiesWriter — malformed tool metadata", () => {
  it("rejects a whitespace-only tool name with the leak-safe error, writes NO rows", async () => {
    const writer = makeWriter();
    await expect(
      writer.declare({
        driverName: DRIVER_NAME,
        // `wireFreeFormString`'s /\S/ guard rejects a whitespace-only name.
        result: makeResult({ tools: [{ name: "   " }] }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — structurally-malformed result (leak-safe)", () => {
  // The type forbids these shapes, so each input is cast through `unknown`. Without the
  // structural guard `declare` would raise a raw TypeError; the typed error is thrown before any
  // transaction opens.

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
    // The error class is the discriminator (the unguarded path throws a raw TypeError); it has
    // no `code`. The `field` value differs per guard (`capabilities`, `flags`, `tools`), so only
    // its presence as a string is asserted.
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    const validationError = thrown as ProviderOutputValidationError;
    expect(validationError.name).toBe("ProviderOutputValidationError");
    expect(typeof validationError.fields?.["field"]).toBe("string");
    expect(typeof validationError.fields?.["reason"]).toBe("string");

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
    // `expectLeakSafeReject` relies on `toBeInstanceOf`; a raw TypeError must not satisfy it.
    const rawTypeError = new TypeError("Cannot read properties of null (reading 'flags')");
    expect(rawTypeError).toBeInstanceOf(Error);
    expect(rawTypeError).not.toBeInstanceOf(ProviderOutputValidationError);
    expect(new ProviderOutputValidationError("x", { field: "tools", reason: "y" })).toBeInstanceOf(
      ProviderOutputValidationError,
    );
  });
});

describe("DriverCapabilitiesWriter — sparse tools array (leak-safe, shape guard)", () => {
  it("rejects a SPARSE tools array (a hole) as ProviderOutputValidationError BEFORE any txn opens — closes the undefined-hole-deref class", async () => {
    const writer = makeWriter();

    // Built programmatically because the `no-sparse-arrays` lint forbids a literal. A bare
    // `Array.isArray` check passes it, `.map` skips the hole, and the insert loop would then
    // dereference `undefined.name` inside an open transaction.
    const validTool: ProviderToolMetadata = { name: "search", idempotency_class: "idempotent" };
    const sparseTools: ProviderToolMetadata[] = [];
    sparseTools[0] = validTool;
    sparseTools.length = 2;
    expect(0 in sparseTools).toBe(true);
    expect(1 in sparseTools).toBe(false);

    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Passed by reference: an array spread would densify the hole to `undefined`.
        result: makeResult({ tools: sparseTools }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/dense|sparse/i);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — toJSON-tainted flags (defensive snapshot clone)", () => {
  it("clones flags to a plain record: real booleans, re-declare unchanged", async () => {
    const writer = makeWriter();

    // A non-enumerable `toJSON` passes the `assertValidCapabilityFlags` key check. If flags were
    // stored by reference, `JSON.stringify(snapshot)` would serialize `{poisoned:true}` while the
    // write loop saw the real booleans, so an identical re-declare would report "changed".
    const taintedFlags = makeFlags({ steer: true, mcp: true }) as Record<string, unknown>;
    Object.defineProperty(taintedFlags, "toJSON", {
      value: () => ({ poisoned: true }),
      enumerable: false,
    });
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

    // The write carries the real boolean values. This passes for a by-reference snapshot too,
    // since the write loop never serializes; the re-declare below is the discriminating check.
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
    expect(supportedByFlag).toEqual(makeFlags({ steer: true, mcp: true }));

    // A second declare of the same tainted object is unchanged because both sides compare plain
    // booleans.
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

describe("DriverCapabilitiesWriter — contract_version build metadata rejected", () => {
  it("rejects `1.2.3+build.5` (SemVer section 10 build metadata) with a reason that names build metadata + writes NO rows", async () => {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Build metadata does not identify a version: `semver.valid` strips it, so the
        // canonical-identity check rejects it. Accepting it would store byte-different strings
        // for the same version and report a spurious "changed".
        result: makeResult({
          capabilities: { flags: makeFlags(), contractVersion: "1.2.3+build.5" },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("contract_version");
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/build metadata/i);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — duplicate tool names", () => {
  it("rejects two tools sharing a name (field 'tools') before any txn opens", async () => {
    const writer = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        driverName: DRIVER_NAME,
        // Unguarded, the second insert would violate the (driver_name, tool_name) primary key
        // inside the transaction and throw a raw `SqliteError`.
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
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
  });
});

describe("DriverCapabilitiesWriter — no-description tool round-trip", () => {
  it("treats a re-declare of a description-less tool as unchanged (NULL round-trips)", async () => {
    const writer = makeWriter();
    await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });

    // The database stores NULL and the snapshot reader omits `description`, so the two snapshots
    // compare equal.
    const outcome = await writer.declare({
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: false });
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
            SET capability_flag = 'transcript_replay'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/UNIQUE constraint failed|PRIMARY KEY/i);

    // A rename onto a value outside the canonical set is refused by the CHECK.
    expect(() => {
      db.prepare(
        `UPDATE driver_capabilities
            SET capability_flag = 'transcript_replays'
          WHERE driver_name = ? AND capability_flag = 'mcp'`,
      ).run(DRIVER_NAME);
    }).toThrow(/CHECK constraint failed/i);

    // Neither attempt changed the cache.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(() => writer.hydrate(DRIVER_NAME)).not.toThrow();
  });

  it("answers `transcript_replay` after a cold-start hydrate, at full cardinality", async () => {
    // A cache written through the writer answers every flag, so the cardinality guard passes.
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
    // A cache missing one flag must fail at the first cold-start read, not return a short matrix.
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
    expect(writer.hydrate("never-seen")).toEqual({ hit: false, reason: "never_written" });
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
    expect(hydrated.outputSpeedLevels).toStrictEqual([...DRIVER_OUTPUT_SPEED_LEVELS.claude]);
    // A mutable copy, never the frozen shared array: a consumer's edit must not throw or reach
    // the next hydrate.
    hydrated.outputSpeedLevels?.push("turbo");
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME)).outputSpeedLevels).toStrictEqual([
      ...DRIVER_OUTPUT_SPEED_LEVELS.claude,
    ]);
  });

  it("omits `outputSpeedLevels` entirely when the cached flag does not declare the axis", async () => {
    // A driver with no speed axis hydrates with the member absent, not empty. `Object.hasOwn`
    // because `exactOptionalPropertyTypes` distinguishes present-undefined from absent.
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
    // A driver registered without a vocabulary entry, or a row written out-of-band, is a wiring
    // fault; hydrating quietly would publish a report that breaks its own contract.
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

  // `hydrate` reads its three tables through the deferred `#readTxn` so a concurrent refresh
  // cannot tear the snapshot. Synchronous better-sqlite3 has no interleaving point, so this only
  // exercises that path end to end.
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
});

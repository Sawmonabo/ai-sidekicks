// The daemon-resident driver-capability cache.
//
// Persists a driver's capability snapshot to three driver-keyed tables (`driver_capabilities`,
// `driver_tools`, `driver_contract_meta`) in one transaction, and rebuilds the whole
// `GetCapabilitiesResult` from them on cold start without asking the driver. No table has a
// session column.
// - `driver_contract_meta` is the parent row: its presence means the driver was written.
// - The `cliVersion` pair is cache currency, not a capability, so it sits outside change
//   detection; the unchanged branch rewrites it only when the stored pair differs.
// - `declare` validates and sorts before opening a transaction; the read-decide-write then runs
//   `BEGIN IMMEDIATE`, so concurrent declares cannot overwrite each other or hit
//   `SQLITE_BUSY_SNAPSHOT`.

import { isDeepStrictEqual } from "node:util";

import {
  DRIVER_CAPABILITY_FLAGS,
  ProviderToolMetadataSchema,
  type DriverCapabilityFlag,
  type NormalizedProviderToolMetadata,
} from "@ai-sidekicks/contracts/provider-driver";
import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import type { Database, Statement, Transaction } from "better-sqlite3";

import {
  assertValidCapabilityFlags,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
  ProviderOutputValidationError,
} from "./provider-output-validation.js";
import { composeStaticOutputSpeedLevels } from "./provider-driver-descriptors.js";
import {
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  readCliVersionColumns,
} from "./provider-driver.js";

// One driver's stored capabilities: every flag, the contract version and the normalized tools.
interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: readonly NormalizedProviderToolMetadata[];
}

// The JSON round-trip drops `undefined`-valued keys (an omitted tool `description`).
function snapshotsEqual(
  left: CapabilityDetails | undefined,
  right: CapabilityDetails | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown,
  );
}

/** One capability declaration; `result.cliVersion` is persisted with the snapshot. */
export interface DeclareDriverCapabilitiesInput {
  readonly driverName: ProviderName;
  readonly result: GetCapabilitiesResult;
}

/**
 * What `declare` did to the snapshot. `cliVersionRefreshed` is true iff the declared version pair
 * differs from the stored one.
 */
export interface DeclareDriverCapabilitiesResult {
  readonly snapshotChange: "created" | "changed" | "unchanged";
  readonly cliVersionRefreshed: boolean;
}

/**
 * A hit carries the whole `GetCapabilitiesResult`; a miss is `never_written` or
 * `cli_version_missing` (row with a NULL pair; the version is never invented, because the stored
 * pair is the spawned build's own report). A wrong flag key set throws instead of missing.
 */
export type DriverCapabilityHydrationResult =
  | { readonly hit: true; readonly result: GetCapabilitiesResult }
  | { readonly hit: false; readonly reason: "never_written" | "cli_version_missing" };

interface DriverCapabilityRow {
  readonly capability_flag: string;
  readonly supported: number;
}

interface DriverToolRow {
  readonly tool_name: string;
  readonly idempotency_class: string;
  readonly description: string | null;
}

interface DriverContractMetaRow {
  readonly contract_version: string;
  // The table's CHECK never admits a parse without its printed version.
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
}

// `snapshot` undefined: never written. `storedCliVersion` undefined: the row has no version.
interface CachedDriverCapabilityRead {
  readonly snapshot: CapabilityDetails | undefined;
  readonly storedCliVersion: DriverCliVersionReport | undefined;
}

// Absent versus present is a difference, so a row with no version heals on the next declare.
function cliVersionReportsEqual(
  left: DriverCliVersionReport | undefined,
  right: DriverCliVersionReport | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.rawVersion === right.rawVersion && left.parsedVersion === right.parsedVersion;
}

/** The write seam a driver declares through: the writer narrowed to `declare`. */
export type DriverCapabilityDeclarationSink = Pick<DriverCapabilitiesWriter, "declare">;

/** Persists a driver's declared capabilities and hydrates them back without a provider call. */
export class DriverCapabilitiesWriter {
  readonly #selectCapabilityFlagsStmt: Statement;
  readonly #selectToolsStmt: Statement;
  readonly #selectContractMetaStmt: Statement;
  readonly #upsertCapabilityFlagStmt: Statement;
  readonly #deleteToolsStmt: Statement;
  readonly #insertToolStmt: Statement;
  readonly #upsertContractMetaStmt: Statement;
  // Version-only refresh: must not touch `contract_version`, insert, or rewrite capability rows.
  readonly #refreshCliVersionPairStmt: Statement;
  // One DEFERRED transaction so the three SELECTs share a snapshot; autocommit would let a
  // refresh tear the read.
  readonly #readTxn: Transaction<(driverName: ProviderName) => CachedDriverCapabilityRead>;
  readonly #declareTxn: Transaction<
    (
      driverName: ProviderName,
      newSnapshot: CapabilityDetails,
      declaredCliVersion: DriverCliVersionReport,
    ) => DeclareDriverCapabilitiesResult
  >;
  readonly #now: () => string;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.#now = now;

    // No ORDER BY: flags reconstruct into a keyed record, so row order is irrelevant.
    this.#selectCapabilityFlagsStmt = db.prepare(
      `SELECT capability_flag, supported
         FROM driver_capabilities
        WHERE driver_name = ?`,
    );
    this.#selectToolsStmt = db.prepare(
      `SELECT tool_name, idempotency_class, description
         FROM driver_tools
        WHERE driver_name = ?
        ORDER BY tool_name`,
    );
    // The version pair comes from this same row, so "row, NULL pair" stays distinct from "no row".
    this.#selectContractMetaStmt = db.prepare(
      `SELECT contract_version, cli_version_raw, cli_version_semver
         FROM driver_contract_meta
        WHERE driver_name = ?`,
    );

    // One row per flag is upserted on every write and a flag is never dropped, so no orphan rows.
    this.#upsertCapabilityFlagStmt = db.prepare(
      `INSERT INTO driver_capabilities (driver_name, capability_flag, supported, refreshed_at)
       VALUES (@driver_name, @capability_flag, @supported, @refreshed_at)
       ON CONFLICT(driver_name, capability_flag)
         DO UPDATE SET supported    = excluded.supported,
                       refreshed_at = excluded.refreshed_at`,
    );
    // Delete and reinsert in one transaction so a removed tool leaves no orphan row.
    this.#deleteToolsStmt = db.prepare(`DELETE FROM driver_tools WHERE driver_name = ?`);
    this.#insertToolStmt = db.prepare(
      `INSERT INTO driver_tools (driver_name, tool_name, idempotency_class, description, ` +
        `refreshed_at)
       VALUES (@driver_name, @tool_name, @idempotency_class, @description, @refreshed_at)`,
    );
    // The version pair rides every mutating branch, so it never lags a capability write.
    this.#upsertContractMetaStmt = db.prepare(
      `INSERT INTO driver_contract_meta (driver_name, contract_version, cli_version_raw, ` +
        `cli_version_semver, refreshed_at)
       VALUES (@driver_name, @contract_version, @cli_version_raw, @cli_version_semver, ` +
        `@refreshed_at)
       ON CONFLICT(driver_name)
         DO UPDATE SET contract_version   = excluded.contract_version,
                       cli_version_raw    = excluded.cli_version_raw,
                       cli_version_semver = excluded.cli_version_semver,
                       refreshed_at       = excluded.refreshed_at`,
    );
    // Both version columns are written together, so a parse never outlives its printed version.
    this.#refreshCliVersionPairStmt = db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw    = @cli_version_raw,
              cli_version_semver = @cli_version_semver,
              refreshed_at       = @refreshed_at
        WHERE driver_name = @driver_name`,
    );

    this.#readTxn = db.transaction(
      (driverName: ProviderName): CachedDriverCapabilityRead => this.#cachedRead(driverName),
    );
    this.#declareTxn = db.transaction(
      (
        driverName: ProviderName,
        newSnapshot: CapabilityDetails,
        declaredCliVersion: DriverCliVersionReport,
      ): DeclareDriverCapabilitiesResult =>
        this.#readDecideWrite(driverName, newSnapshot, declaredCliVersion),
    );
  }

  /**
   * Declares (or refreshes) a driver's capabilities in one IMMEDIATE transaction; an identical
   * re-declare writes no capability row. Throws `ProviderOutputValidationError`, before any
   * transaction opens, for an invalid contract version, a bad flag key set, or a malformed or
   * duplicate tool.
   */
  async declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    // The declared type is erased at runtime, so a malformed driver can ship null or a primitive;
    // this guard keeps the accesses below from raw-throwing a TypeError.
    assertValidGetCapabilitiesResultShape(input.result);

    // Validated where the daemon read it off the spawned build, so it is trusted here.
    const declaredCliVersion: DriverCliVersionReport = input.result.cliVersion;

    // Reject a bad contract_version here so the SQL CHECK never fires mid-transaction.
    assertValidContractVersion(input.result.capabilities.contractVersion);

    // Exactly the canonical key set: an extra key would hit the SQL CHECK, a missing one would
    // persist an incomplete cache.
    assertValidCapabilityFlags(input.result.capabilities.flags);

    // Normalize through the contract schema (fills the `idempotency_class` default); `safeParse`
    // keeps a malformed tool from surfacing as a raw `ZodError`.
    const normalizedTools: NormalizedProviderToolMetadata[] = input.result.tools.map((tool) => {
      const parsed = ProviderToolMetadataSchema.safeParse(tool);
      if (!parsed.success) {
        throw new ProviderOutputValidationError("Invalid provider tool metadata.", {
          field: "tools",
          reason:
            "tool name/description must be non-empty, non-whitespace, NUL-free, within " +
            "length bounds",
        });
      }
      return parsed.data;
    });

    // Sort by UTF-8 bytes to match SQLite's BINARY collation in `ORDER BY tool_name`; JS `<` and
    // `localeCompare` order differently and would report a spurious "changed". Matching orders
    // also make a reorder-only re-declare a no-op, as `isDeepStrictEqual` is array-order-sensitive.
    normalizedTools.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );

    // Reject duplicates before the transaction so a provider bug does not look like a storage
    // failure. The tools are sorted, so a duplicate is an adjacent pair.
    for (let index = 1; index < normalizedTools.length; index += 1) {
      if (normalizedTools[index]?.name === normalizedTools[index - 1]?.name) {
        throw new ProviderOutputValidationError("Invalid provider tool metadata.", {
          field: "tools",
          reason: "duplicate tool name",
        });
      }
    }

    // A fresh record, each flag read once: a provider object with a `toJSON` would taint change
    // detection while the write loop sees the true booleans.
    const flags = {} as Record<DriverCapabilityFlag, boolean>;
    for (const capabilityFlag of DRIVER_CAPABILITY_FLAGS) {
      flags[capabilityFlag] = input.result.capabilities.flags[capabilityFlag] === true;
    }
    const newSnapshot: CapabilityDetails = {
      flags,
      contractVersion: input.result.capabilities.contractVersion,
      tools: normalizedTools,
    };

    // `cliVersion` stays out of `newSnapshot`: it is cache currency, not a capability.
    return this.#declareTxn.immediate(input.driverName, newSnapshot, declaredCliVersion);
  }

  // Runs inside `#declareTxn`; calls `#cachedRead` directly because better-sqlite3 rejects nested
  // transactions.
  #readDecideWrite(
    driverName: ProviderName,
    newSnapshot: CapabilityDetails,
    declaredCliVersion: DriverCliVersionReport,
  ): DeclareDriverCapabilitiesResult {
    const priorRead: CachedDriverCapabilityRead = this.#cachedRead(driverName);
    const priorSnapshot: CapabilityDetails | undefined = priorRead.snapshot;
    // Whether the stored pair differs, not whether a statement ran.
    const cliVersionRefreshed: boolean = !cliVersionReportsEqual(
      priorRead.storedCliVersion,
      declaredCliVersion,
    );

    if (snapshotsEqual(priorSnapshot, newSnapshot)) {
      // A provider upgrade with no capability change must still refresh the pair, or the stored
      // version names a build no longer installed.
      if (cliVersionRefreshed) {
        this.#refreshCliVersionPairStmt.run({
          driver_name: driverName,
          cli_version_raw: declaredCliVersion.rawVersion,
          cli_version_semver: declaredCliVersion.parsedVersion ?? null,
          refreshed_at: this.#now(),
        });
      }
      return { snapshotChange: "unchanged", cliVersionRefreshed };
    }

    const refreshedAt: string = this.#now();

    for (const capabilityFlag of Object.keys(newSnapshot.flags) as DriverCapabilityFlag[]) {
      this.#upsertCapabilityFlagStmt.run({
        driver_name: driverName,
        capability_flag: capabilityFlag,
        supported: newSnapshot.flags[capabilityFlag] ? 1 : 0,
        refreshed_at: refreshedAt,
      });
    }

    this.#deleteToolsStmt.run(driverName);
    for (const tool of newSnapshot.tools) {
      this.#insertToolStmt.run({
        driver_name: driverName,
        tool_name: tool.name,
        idempotency_class: tool.idempotency_class,
        description: tool.description ?? null,
        refreshed_at: refreshedAt,
      });
    }

    // The pair rides the upsert unconditionally; restating an unchanged pair costs nothing.
    this.#upsertContractMetaStmt.run({
      driver_name: driverName,
      contract_version: newSnapshot.contractVersion,
      cli_version_raw: declaredCliVersion.rawVersion,
      cli_version_semver: declaredCliVersion.parsedVersion ?? null,
      refreshed_at: refreshedAt,
    });

    return {
      snapshotChange: priorSnapshot === undefined ? "created" : "changed",
      cliVersionRefreshed,
    };
  }

  /**
   * Rebuilds a driver's capabilities from the durable cache without asking the driver, in one
   * DEFERRED read transaction. A static `outputSpeedLevels` comes from the provider's descriptor.
   */
  hydrate(driverName: ProviderName): DriverCapabilityHydrationResult {
    const cached: CachedDriverCapabilityRead = this.#readTxn.deferred(driverName);
    if (cached.snapshot === undefined) {
      return { hit: false, reason: "never_written" };
    }
    if (cached.storedCliVersion === undefined) {
      return { hit: false, reason: "cli_version_missing" };
    }
    return {
      hit: true,
      result: {
        capabilities: {
          flags: cached.snapshot.flags,
          contractVersion: cached.snapshot.contractVersion,
        },
        // Copied: `CapabilityDetails.tools` is readonly, `GetCapabilitiesResult.tools` is mutable.
        tools: [...cached.snapshot.tools],
        cliVersion: cached.storedCliVersion,
        ...composeStaticOutputSpeedLevels(driverName, cached.snapshot.flags),
      },
    };
  }

  // Runs inside `#readTxn` or `#declareTxn`, so both halves share one read snapshot.
  #cachedRead(driverName: ProviderName): CachedDriverCapabilityRead {
    const contractMeta: DriverContractMetaRow | undefined = this.#selectContractMetaStmt.get(
      driverName,
    ) as DriverContractMetaRow | undefined;
    if (contractMeta === undefined) {
      return { snapshot: undefined, storedCliVersion: undefined };
    }
    return {
      snapshot: this.#snapshotFromContractMeta(driverName, contractMeta),
      storedCliVersion:
        contractMeta.cli_version_raw === null
          ? undefined
          : readCliVersionColumns(contractMeta.cli_version_raw, contractMeta.cli_version_semver),
    };
  }

  // Throws a plain `Error` naming the keys when the stored flag rows are not the canonical set.
  #snapshotFromContractMeta(
    driverName: ProviderName,
    contractMeta: DriverContractMetaRow,
  ): CapabilityDetails {
    // The column's CHECK is a superset whitelist, so a stored name is not by itself a
    // `DriverCapabilityFlag`; the key-set check below makes the typing sound.
    const flagRows: DriverCapabilityRow[] = this.#selectCapabilityFlagsStmt.all(
      driverName,
    ) as DriverCapabilityRow[];
    // Compare the key set, not a row count: an out-of-band row with an admitted name outside the
    // union keeps the count steady. A violation means corruption, so it throws a plain `Error`
    // naming the keys (our own rows, not provider input).
    const flags: Record<DriverCapabilityFlag, boolean> = {} as Record<
      DriverCapabilityFlag,
      boolean
    >;
    const unexpectedFlags: string[] = [];
    for (const row of flagRows) {
      if ((DRIVER_CAPABILITY_FLAGS as readonly string[]).includes(row.capability_flag)) {
        flags[row.capability_flag as DriverCapabilityFlag] = row.supported === 1;
      } else {
        // Collected but never assigned, so a non-canonical row cannot become a key.
        unexpectedFlags.push(row.capability_flag);
      }
    }
    const missingFlags: DriverCapabilityFlag[] = DRIVER_CAPABILITY_FLAGS.filter(
      (flag) => !Object.hasOwn(flags, flag),
    );
    if (missingFlags.length > 0 || unexpectedFlags.length > 0) {
      throw new Error(
        `driver_capabilities row-set invariant violated for "${driverName}": ` +
          `expected exactly the ${DRIVER_CAPABILITY_FLAGS.length.toString()} canonical ` +
          `capability flags; missing [${missingFlags.join(", ")}], ` +
          `unexpected [${unexpectedFlags.join(", ")}].`,
      );
    }

    // The `idempotency_class` CHECK guarantees a valid stored enum.
    const toolRows: DriverToolRow[] = this.#selectToolsStmt.all(driverName) as DriverToolRow[];
    const tools: NormalizedProviderToolMetadata[] = toolRows.map((row) => {
      const tool: NormalizedProviderToolMetadata = {
        name: row.tool_name,
        idempotency_class:
          row.idempotency_class as NormalizedProviderToolMetadata["idempotency_class"],
        // Omitted when NULL: `exactOptionalPropertyTypes` forbids `description: undefined`, and
        // the omitted key matches a tool declared without one.
        ...(row.description !== null ? { description: row.description } : {}),
      };
      return tool;
    });

    return {
      flags,
      contractVersion: contractMeta.contract_version,
      tools,
    };
  }
}

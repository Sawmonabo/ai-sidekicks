// Pins the provider-account contract to the live DDL. Each check reads `sqlite_master.sql` or
// `PRAGMA table_info` on a database the real migration runner just built and compares it with the
// contract symbol consumers parse with; two hand-written lists could agree as the schema drifts.
//
// Pinned: the provider, billing-mode, health-state, auth-mode and quota-source unions against their
// DDL CHECK lists; the wire record's members against the registry's columns, with a reasoned list
// of exceptions; the generation floor against the DDL CHECK bound; the quota-window key.
// The CHECK extractor has a negative control: it must flag a deliberately wrong DDL.

import {
  BILLING_MODES,
  CREDENTIAL_GENERATION_MIN,
  PROVIDER_ACCOUNT_HEALTH_STATES,
  PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES,
  PROVIDER_AUTH_MODES,
  PROVIDER_NAMES,
  ProviderAccountHealthStateSchema,
  ProviderAccountSchema,
  ProviderAccountUsageWindowSchema,
  CredentialGenerationSchema,
} from "@ai-sidekicks/contracts";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

const PROVIDER_ACCOUNTS_TABLE = "provider_accounts";
const PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE = "provider_account_usage_windows";

interface PragmaColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly dflt_value: string | null;
  /** 1-based ordinal within the primary key; 0 when the column is not part of it. */
  readonly pk: number;
}

/** Strips SQL line comments, so a parenthesized comment cannot masquerade as a constraint. */
function withoutSqlLineComments(tableSql: string): string {
  return tableSql
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");
}

/**
 * The member list of a `CHECK(<column> IN (...))` constraint, in DDL order; the nullable spelling
 * `IS NULL OR <column> IN (...)` counts as the same constraint. Returns `[]` for no constraint, so
 * an absent CHECK fails the comparison instead of passing vacuously.
 */
function checkMembersOf(tableSql: string, columnName: string): readonly string[] {
  const constraintPattern = new RegExp(
    String.raw`CHECK\(\s*(?:${columnName}\s+IS\s+NULL\s+OR\s+)?${columnName}\s+IN\s*\(([^)]*)\)\s*\)`,
  );
  const match = constraintPattern.exec(withoutSqlLineComments(tableSql));
  if (match?.[1] === undefined) {
    return [];
  }
  return match[1]
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0)
    .map((member) => member.replace(/^'(.*)'$/, "$1"));
}

/**
 * The bound of a `CHECK(<column> >= N)` constraint, or null when there is none (null, not 0, so an
 * absent floor never reads as the value the floor exists to exclude).
 */
function numericFloorOf(tableSql: string, columnName: string): number | null {
  // The optional prefix is the generation columns' storage-class conjunct, spelled exactly so a
  // CHECK on something else still reports no floor.
  const constraintPattern = new RegExp(
    String.raw`CHECK\(\s*(?:typeof\(${columnName}\)\s*=\s*'integer'\s+AND\s+)?${columnName}\s*>=\s*(-?\d+)\s*\)`,
  );
  const match = constraintPattern.exec(withoutSqlLineComments(tableSql));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Whether the CHECK pins the STORAGE CLASS too: a column type is only an affinity, so `1.5` stores
 * as REAL and satisfies `>= 1`, which on a monotonic counter is a counter that divides.
 */
function checkPinsIntegerStorage(tableSql: string, columnName: string): boolean {
  return new RegExp(String.raw`CHECK\(\s*typeof\(${columnName}\)\s*=\s*'integer'\s+AND\s`).test(
    withoutSqlLineComments(tableSql),
  );
}

/** Whether the column's CHECK explicitly admits NULL alongside its member list. */
function checkAdmitsNull(tableSql: string, columnName: string): boolean {
  return new RegExp(String.raw`CHECK\(\s*${columnName}\s+IS\s+NULL\s+OR\s`).test(
    withoutSqlLineComments(tableSql),
  );
}

/** The declared member names of a strict object schema, in declaration order. */
function schemaMemberNames(schema: z.ZodType<unknown>): readonly string[] {
  const objectDefinition = (schema as unknown as { def: { shape: Record<string, unknown> } }).def;
  return Object.keys(objectDefinition.shape);
}

describe("provider-account contract <-> DDL conformance", () => {
  let db: DatabaseType;
  let providerAccountsSql: string;
  let usageWindowsSql: string;

  beforeEach(() => {
    // The real runner on an in-memory database: the schema a daemon would boot with, not a copy.
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
    providerAccountsSql = tableSqlOf(PROVIDER_ACCOUNTS_TABLE);
    usageWindowsSql = tableSqlOf(PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE);
  });

  afterEach(() => {
    db.close();
  });

  function tableSqlOf(table: string): string {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    if (row === undefined) {
      throw new Error(`conformance suite found no CREATE statement for \`${table}\``);
    }
    return row.sql;
  }

  function columnsOf(table: string): ReadonlyArray<PragmaColumn> {
    return db.pragma(`table_info(${table})`) as ReadonlyArray<PragmaColumn>;
  }

  describe("enum lockstep", () => {
    it("pins the provider union against the registry's provider CHECK", () => {
      expect(checkMembersOf(providerAccountsSql, "provider")).toEqual([...PROVIDER_NAMES]);
    });

    it("pins the billing-mode union against the registry's billing_mode CHECK", () => {
      expect(checkMembersOf(providerAccountsSql, "billing_mode")).toEqual([...BILLING_MODES]);
    });

    it("pins the health-state union against the registry's health_state CHECK", () => {
      expect(checkMembersOf(providerAccountsSql, "health_state")).toEqual([
        ...PROVIDER_ACCOUNT_HEALTH_STATES,
      ]);
    });

    it("pins the auth-mode union against the registry's observed_auth_mode CHECK", () => {
      expect(checkMembersOf(providerAccountsSql, "observed_auth_mode")).toEqual([
        ...PROVIDER_AUTH_MODES,
      ]);
    });

    it("pins the quota-source union against the window store's source CHECK", () => {
      expect(checkMembersOf(usageWindowsSql, "source")).toEqual([
        ...PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES,
      ]);
    });

    it("detects a member-list mismatch (negative control for the extractor)", () => {
      // Without this, a clean result above is equally consistent with a regex that matched nothing.
      const wrongMemberSet = `CREATE TABLE t (provider TEXT NOT NULL CHECK(provider IN ('claude', 'gemini')))`;
      expect(checkMembersOf(wrongMemberSet, "provider")).not.toEqual([...PROVIDER_NAMES]);

      const noConstraintAtAll = `CREATE TABLE t (provider TEXT NOT NULL)`;
      expect(checkMembersOf(noConstraintAtAll, "provider")).toEqual([]);

      // A CHECK that lives only inside a comment must not read as a constraint.
      const constraintInACommentOnly = `CREATE TABLE t (
        provider TEXT NOT NULL -- CHECK(provider IN ('claude', 'codex')) was considered
      )`;
      expect(checkMembersOf(constraintInACommentOnly, "provider")).toEqual([]);
    });
  });

  describe("null-arm asymmetry", () => {
    it("admits NULL in the stored health columns while the wire union does not", () => {
      // Health columns are nullable (never validated means no reading) but the wire arm is not: a
      // NULL reading projects as `indeterminate`. Pinning both keeps the wire member from becoming
      // nullable, which would put two spellings of "unknown" on one wire.
      expect(checkAdmitsNull(providerAccountsSql, "health_state")).toBe(true);
      expect(checkAdmitsNull(providerAccountsSql, "observed_auth_mode")).toBe(true);
      expect(PROVIDER_ACCOUNT_HEALTH_STATES).toContain("indeterminate");
      expect(ProviderAccountHealthStateSchema.safeParse(null).success).toBe(false);
      expect(ProviderAccountHealthStateSchema.safeParse("indeterminate").success).toBe(true);

      // Negative control: the quota-source CHECK is not nullable.
      expect(checkAdmitsNull(usageWindowsSql, "source")).toBe(false);
    });
  });

  describe("record shape vs column set", () => {
    // Not one-to-one; each exception is listed with its reason, so an omission cannot hide.
    const WIRE_MEMBER_BY_COLUMN: Readonly<Record<string, string>> = {
      account_id: "accountId",
      provider: "provider",
      display_label: "displayLabel",
      credential_generation: "credentialGeneration",
      billing_mode: "billingMode",
      is_default: "isDefault",
      health_state: "healthState",
      health_observed_at: "healthObservedAt",
      observed_auth_mode: "observedAuthMode",
      logged_in_at: "loggedInAt",
      observed_account_email: "observedAccountEmail",
      observed_account_org_id: "observedAccountOrgId",
      observed_account_org_name: "observedAccountOrgName",
      observed_account_plan: "observedAccountPlan",
      last_refresh_observed_at: "lastRefreshObservedAt",
      probe_enabled: "probeEnabled",
      window_start_enabled: "windowStartEnabled",
      wake_for_window_start_enabled: "wakeForWindowStartEnabled",
      // The memory import's outcome, count and time are one member on the wire.
      memory_import_outcome: "memoryImport",
      memory_import_count: "memoryImport",
      memory_imported_at: "memoryImport",
    };

    /** Columns the account record deliberately does not project, and why. */
    const COLUMNS_WITH_NO_ACCOUNT_MEMBER: Readonly<Record<string, string>> = {
      credential_home_path:
        "the home reaches an operator only through the readiness remedy's sign-in arm; on every surface a session user can reach, this names a column and nothing else",
      removal_intent:
        "the durable half of the cross-store removal protocol — an intent-marked account is refused at admission and is not a state a client renders",
      created_at: "row bookkeeping with no wire consumer",
      updated_at:
        "row bookkeeping that moves on ANY mutation, so surfacing it beside the health pair would invite a relabel to read as a fresh observation",
    };

    /** Members the account record carries that no column holds, and why. */
    const MEMBERS_WITH_NO_COLUMN: Readonly<Record<string, string>> = {
      expectedReloginAtEstimate:
        "DERIVED at read time, mode-dispatched from the issuance anchor; storing an estimate would let it outlive the facts it was computed from",
    };

    it("accounts for every registry column and every account member exactly once", () => {
      const columnNames = columnsOf(PROVIDER_ACCOUNTS_TABLE).map((column) => column.name);
      const memberNames = schemaMemberNames(ProviderAccountSchema);

      for (const columnName of columnNames) {
        const isMapped = columnName in WIRE_MEMBER_BY_COLUMN;
        const isExcepted = columnName in COLUMNS_WITH_NO_ACCOUNT_MEMBER;
        expect(
          isMapped !== isExcepted,
          `column \`${columnName}\` must be either mapped to a wire member or listed as a reasoned exception, and never both`,
        ).toBe(true);
      }

      for (const columnName of Object.keys(WIRE_MEMBER_BY_COLUMN)) {
        expect(columnNames).toContain(columnName);
      }
      for (const columnName of Object.keys(COLUMNS_WITH_NO_ACCOUNT_MEMBER)) {
        expect(columnNames).toContain(columnName);
      }

      const mappedMembers = new Set(Object.values(WIRE_MEMBER_BY_COLUMN));
      for (const memberName of memberNames) {
        const isMapped = mappedMembers.has(memberName);
        const isExcepted = memberName in MEMBERS_WITH_NO_COLUMN;
        expect(
          isMapped !== isExcepted,
          `member \`${memberName}\` must be either backed by a column or listed as a reasoned exception, and never both`,
        ).toBe(true);
      }
      for (const memberName of mappedMembers) {
        expect(memberNames).toContain(memberName);
      }
    });

    it("keeps every exception reasoned rather than merely listed", () => {
      for (const [columnName, reason] of Object.entries(COLUMNS_WITH_NO_ACCOUNT_MEMBER)) {
        expect(reason.length, `\`${columnName}\` exception carries no reason`).toBeGreaterThan(20);
      }
      for (const [memberName, reason] of Object.entries(MEMBERS_WITH_NO_COLUMN)) {
        expect(reason.length, `\`${memberName}\` exception carries no reason`).toBeGreaterThan(20);
      }
    });

    it("maps the quota-window record onto its column set with no exception at all", () => {
      // Contrast: a quota reading is stored and served in full.
      const expectedMemberByColumn: Readonly<Record<string, string>> = {
        account_id: "accountId",
        limit_id: "limitId",
        window_mins: "windowMins",
        label: "label",
        used_percent: "usedPercent",
        resets_at: "resetsAt",
        observed_at: "observedAt",
        observed_credential_generation: "observedCredentialGeneration",
        source: "source",
      };
      const columnNames = columnsOf(PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE).map(
        (column) => column.name,
      );
      expect(columnNames).toEqual(Object.keys(expectedMemberByColumn));
      expect([...schemaMemberNames(ProviderAccountUsageWindowSchema)].sort()).toEqual(
        Object.values(expectedMemberByColumn).sort(),
      );
    });
  });

  describe("generation floor", () => {
    it("pins the contract floor against the CHECK bound the schema enforces it with", () => {
      // The DEFAULT is where a generation starts and the CHECK is how far down it may go;
      // pinning only the DEFAULT would let the two floors diverge.
      const generationColumn = columnsOf(PROVIDER_ACCOUNTS_TABLE).find(
        (column) => column.name === "credential_generation",
      );
      expect(generationColumn?.notnull).toBe(1);
      expect(generationColumn?.dflt_value).toBe(String(CREDENTIAL_GENERATION_MIN));
      // Read from the live DDL so raising one floor without the other fails here.
      expect(numericFloorOf(providerAccountsSql, "credential_generation")).toBe(
        CREDENTIAL_GENERATION_MIN,
      );
      // INTEGER is only an affinity: 1.5 stores as REAL and passes `>= 1`, so the CHECK must
      // also pin the storage class, or the wire's `.int()` and the database disagree.
      expect(checkPinsIntegerStorage(providerAccountsSql, "credential_generation")).toBe(true);
      // Negative control: `window_mins` has no floor CHECK, so a loose matcher would find one.
      expect(numericFloorOf(usageWindowsSql, "window_mins")).toBeNull();
      expect(checkPinsIntegerStorage(usageWindowsSql, "window_mins")).toBe(false);

      // A zero or negative generation would order before a fresh account and let a fabricated
      // reading look newer than the account it describes.
      expect(CredentialGenerationSchema.safeParse(CREDENTIAL_GENERATION_MIN).success).toBe(true);
      expect(CredentialGenerationSchema.safeParse(CREDENTIAL_GENERATION_MIN - 1).success).toBe(
        false,
      );
      expect(CredentialGenerationSchema.safeParse(-1).success).toBe(false);
      expect(CredentialGenerationSchema.safeParse(1.5).success).toBe(false);
    });

    it("applies the same floor to a stored quota reading's generation stamp", () => {
      const stampColumn = columnsOf(PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE).find(
        (column) => column.name === "observed_credential_generation",
      );
      // NOT NULL with no default: a reading with no recorded generation cannot be told from
      // a current one.
      expect(stampColumn?.notnull).toBe(1);
      expect(stampColumn?.dflt_value).toBeNull();
      // The FK constrains which account a reading belongs to, not its stamp; a stamp below the
      // floor would render its reading permanently stale instead of being refused at write time.
      expect(numericFloorOf(usageWindowsSql, "observed_credential_generation")).toBe(
        CREDENTIAL_GENERATION_MIN,
      );
      // A fractional stamp would be neither current nor cleanly stale against the parent.
      expect(checkPinsIntegerStorage(usageWindowsSql, "observed_credential_generation")).toBe(true);
      // The wire parser refuses the same value.
      expect(CredentialGenerationSchema.safeParse(1.5).success).toBe(false);
    });
  });

  describe("quota-window key shape", () => {
    it("keys on (account_id, limit_id) with window_mins an attribute", () => {
      const keyOrdinalByColumn = new Map(
        columnsOf(PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE).map((column) => [column.name, column.pk]),
      );
      expect(keyOrdinalByColumn.get("account_id")).toBe(1);
      expect(keyOrdinalByColumn.get("limit_id")).toBe(2);
      // The window length is not part of the identity: Claude publishes three limit
      // identifiers sharing a 10080-minute window, and a key including the length would admit
      // two rows for one limit.
      expect(keyOrdinalByColumn.get("window_mins")).toBe(0);
      for (const [columnName, keyOrdinal] of keyOrdinalByColumn) {
        if (columnName !== "account_id" && columnName !== "limit_id") {
          expect(keyOrdinal, `column \`${columnName}\` must not be part of the primary key`).toBe(
            0,
          );
        }
      }
    });

    it("leaves the limit identifier unenumerated, because the vocabulary is open", () => {
      // Deliberately no CHECK: a closed list would fail a reading closed as soon as a vendor
      // added a window.
      expect(checkMembersOf(usageWindowsSql, "limit_id")).toEqual([]);
    });
  });

  describe("memory import columns", () => {
    function insertAccount(memoryImport: {
      outcome: string | null;
      count: number | null;
      importedAt: string | null;
    }): void {
      db.prepare(
        `INSERT INTO provider_accounts (account_id, provider, display_label,
           credential_home_path, billing_mode, memory_import_outcome, memory_import_count,
           memory_imported_at, created_at, updated_at)
         VALUES (?, 'claude', 'Work', ?, 'subscription', ?, ?, ?, ?, ?)`,
      ).run(
        "account-1",
        "/homes/account-1",
        memoryImport.outcome,
        memoryImport.count,
        memoryImport.importedAt,
        "2026-09-30T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
      );
    }

    it("stores each outcome the contract names, and no import at all", () => {
      expect(() => {
        insertAccount({ outcome: null, count: null, importedAt: null });
      }).not.toThrow();
      db.prepare("DELETE FROM provider_accounts").run();
      expect(() => {
        insertAccount({ outcome: "imported", count: 3, importedAt: "2026-09-30T00:00:00.000Z" });
      }).not.toThrow();
      db.prepare("DELETE FROM provider_accounts").run();
      expect(() => {
        insertAccount({ outcome: "nothingToImport", count: null, importedAt: null });
      }).not.toThrow();
    });

    it("refuses an outcome whose count and time disagree with it", () => {
      // An outcome missing its count or time would read back as one the wire refuses, and
      // an import that copied nothing cannot carry them.
      expect(() => {
        insertAccount({ outcome: "imported", count: null, importedAt: null });
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        insertAccount({ outcome: "imported", count: 3, importedAt: null });
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        insertAccount({
          outcome: "nothingToImport",
          count: 3,
          importedAt: "2026-09-30T00:00:00.000Z",
        });
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        insertAccount({ outcome: "nothingToImport", count: 3, importedAt: null });
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        insertAccount({ outcome: null, count: 3, importedAt: "2026-09-30T00:00:00.000Z" });
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        insertAccount({ outcome: "imported", count: 0, importedAt: "2026-09-30T00:00:00.000Z" });
      }).toThrow(/CHECK constraint failed/);
    });
  });
});

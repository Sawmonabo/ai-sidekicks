// Plan-029 T1.3 — contract <-> DDL conformance.
//
// The suite IS the test: one row per pinned pair, and every pin reads the LIVE
// schema rather than a transcription of it. That distinction is the whole point
// (documented-pin != enforced-pin): a test that compared two hand-written lists
// would agree with itself forever while the migration drifted underneath.
// Every assertion here therefore reads `sqlite_master.sql` or `PRAGMA
// table_info` on a database the real runner just migrated, and compares it
// against the exported contract symbol a consumer actually parses with.
//
// What is pinned:
//   * the contract's provider, billing-mode, health-state, auth-mode, and
//     quota-source unions against the DDL CHECK lists that admit them;
//   * the wire record's member set against the registry's column set, with an
//     explicit, reasoned exception list for the deliberate asymmetries;
//   * the contract's generation floor against the CHECK bound the schema
//     enforces it with, parsed out of the live DDL rather than transcribed;
//   * the quota-window key as `(account_id, limit_id)` with `window_mins` an
//     attribute rather than a key member.
//
// The CHECK-list extractor carries its own negative control: a checker that has
// never been shown to fail proves nothing about a clean result, so it is run
// against a deliberately-wrong DDL and must report the mismatch.
//
// Spec coverage: `Spec-029 §State And Data Implications`.
// Refs: Plan-029 T1.3, I-029-1, I-029-2, I-029-13.

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

/**
 * Strip SQL line comments before matching. The canonical DDL carries a
 * constraint-stating comment on nearly every column, and several of them
 * contain parentheses and quoted values — so matching against the raw text
 * would let a comment masquerade as a constraint. Stripping first makes the
 * extractor read constraints and nothing else.
 */
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
 * The member list of a `CHECK(<column> IN (...))` constraint, in DDL order.
 * Accepts the nullable spelling `CHECK(<column> IS NULL OR <column> IN (...))`
 * as the same constraint — the null arm is a separate fact, asserted on its own
 * below rather than folded into the member list.
 *
 * Returns an empty array when the column carries no such constraint, so an
 * absent CHECK reads as "admits nothing this suite can pin" and fails the
 * comparison loudly instead of passing vacuously.
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
 * The bound of a `CHECK(<column> >= N)` constraint, or null when the column
 * carries none. Returning null rather than a sentinel number keeps an absent
 * floor from reading as a floor of zero, which is exactly the value the floor
 * exists to exclude.
 */
function numericFloorOf(tableSql: string, columnName: string): number | null {
  const constraintPattern = new RegExp(String.raw`CHECK\(\s*${columnName}\s*>=\s*(-?\d+)\s*\)`);
  const match = constraintPattern.exec(withoutSqlLineComments(tableSql));
  return match?.[1] === undefined ? null : Number(match[1]);
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
    // The REAL runner against an in-memory database: what is pinned below is the
    // schema a daemon would actually boot with, not a copy of the CREATE.
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
      // Without this, every clean result above would be equally consistent with
      // a regex that silently matched nothing. Three deliberate defects, each of
      // a different class the extractor could plausibly miss.
      const wrongMemberSet = `CREATE TABLE t (provider TEXT NOT NULL CHECK(provider IN ('claude', 'gemini')))`;
      expect(checkMembersOf(wrongMemberSet, "provider")).not.toEqual([...PROVIDER_NAMES]);

      const noConstraintAtAll = `CREATE TABLE t (provider TEXT NOT NULL)`;
      expect(checkMembersOf(noConstraintAtAll, "provider")).toEqual([]);

      // A CHECK that lives only inside a comment must not be read as a
      // constraint — the case the comment-stripping step exists for.
      const constraintInACommentOnly = `CREATE TABLE t (
        provider TEXT NOT NULL -- CHECK(provider IN ('claude', 'codex')) was considered
      )`;
      expect(checkMembersOf(constraintInACommentOnly, "provider")).toEqual([]);
    });
  });

  describe("null-arm asymmetry", () => {
    it("admits NULL in the stored health columns while the wire union does not", () => {
      // The registry's health columns are nullable — an account that has never
      // been validated holds no reading. The WIRE arm is not: a NULL stored
      // reading projects as `indeterminate`, which is fail-closed and is neither
      // an error nor an assertion of health. Pinning both halves here is what
      // keeps a later contributor from "fixing" the asymmetry by making the wire
      // member nullable, which would put two spellings of "unknown" on one wire.
      expect(checkAdmitsNull(providerAccountsSql, "health_state")).toBe(true);
      expect(checkAdmitsNull(providerAccountsSql, "observed_auth_mode")).toBe(true);
      expect(PROVIDER_ACCOUNT_HEALTH_STATES).toContain("indeterminate");
      expect(ProviderAccountHealthStateSchema.safeParse(null).success).toBe(false);
      expect(ProviderAccountHealthStateSchema.safeParse("indeterminate").success).toBe(true);

      // Negative control: the quota-source CHECK is NOT nullable, so the helper
      // is discriminating rather than returning true for everything.
      expect(checkAdmitsNull(usageWindowsSql, "source")).toBe(false);
    });
  });

  describe("record shape vs column set", () => {
    // The mapping is deliberately NOT one-to-one, and each exception is listed
    // with the reason it is one. An unexplained absence would be indistinguishable
    // from an omission, which is exactly what this suite exists to catch.
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
      probe_enabled: "probeEnabled",
    };

    /** Columns the account record deliberately does not project, and why. */
    const COLUMNS_WITH_NO_ACCOUNT_MEMBER: Readonly<Record<string, string>> = {
      credential_home_path:
        "the home reaches an operator only through the readiness remedy's sign-in arm; on every surface a session participant can reach, this names a column and nothing else",
      last_refresh_observed_at:
        "an input to the re-login estimate; the wire carries the estimate, not its inputs",
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

      // Every column is either mapped to a member or listed as an exception —
      // never both, and never neither.
      for (const columnName of columnNames) {
        const isMapped = columnName in WIRE_MEMBER_BY_COLUMN;
        const isExcepted = columnName in COLUMNS_WITH_NO_ACCOUNT_MEMBER;
        expect(
          isMapped !== isExcepted,
          `column \`${columnName}\` must be either mapped to a wire member or listed as a reasoned exception, and never both`,
        ).toBe(true);
      }

      // And the mapping names no column that has since been renamed away.
      for (const columnName of Object.keys(WIRE_MEMBER_BY_COLUMN)) {
        expect(columnNames).toContain(columnName);
      }
      for (const columnName of Object.keys(COLUMNS_WITH_NO_ACCOUNT_MEMBER)) {
        expect(columnNames).toContain(columnName);
      }

      // Symmetrically for members.
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
      // The contrast case, and it is load-bearing: the account record's
      // exceptions are deliberate design, not a tolerance this suite grants
      // generally. A quota reading is stored and served in full.
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
      // The rule has two halves and the schema states both: the DEFAULT is where
      // a generation STARTS, the CHECK is how far down it may ever go. Pinning
      // only the DEFAULT would leave the contract's floor and the database's
      // floor free to diverge — the drift this file exists to catch.
      const generationColumn = columnsOf(PROVIDER_ACCOUNTS_TABLE).find(
        (column) => column.name === "credential_generation",
      );
      expect(generationColumn?.notnull).toBe(1);
      expect(generationColumn?.dflt_value).toBe(String(CREDENTIAL_GENERATION_MIN));
      // The floor is READ OUT of the live DDL and compared to the exported
      // constant, so raising one without the other fails here rather than at a
      // spawn that trusted a fabricated generation.
      expect(numericFloorOf(providerAccountsSql, "credential_generation")).toBe(
        CREDENTIAL_GENERATION_MIN,
      );
      // Negative control: the extractor is discriminating. `window_mins` carries
      // no floor CHECK, so a helper that matched loosely would report one here.
      expect(numericFloorOf(usageWindowsSql, "window_mins")).toBeNull();

      // The contract parser holds the rest of the floor: a zero or negative
      // generation would order BEFORE a freshly registered account and let a
      // fabricated reading read as newer than the account it describes.
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
      // NOT NULL and undefaulted: a reading whose generation nobody recorded
      // cannot be told from a current one, which is the staleness signal the
      // stamp exists to carry.
      expect(stampColumn?.notnull).toBe(1);
      expect(stampColumn?.dflt_value).toBeNull();
      // The stamp carries the SAME floor, read out of the live DDL and compared
      // to the exported constant the wire parser enforces. Mirroring the parent's
      // generation is not on its own enough: the FK constrains which account a
      // reading belongs to and says nothing about the value stamped on it, so a
      // writer could record a generation below the floor for an account whose own
      // column could never hold one — a stamp naming a generation that never
      // existed, matching no account state, rendering its reading permanently
      // stale rather than refusing at write time.
      expect(numericFloorOf(usageWindowsSql, "observed_credential_generation")).toBe(
        CREDENTIAL_GENERATION_MIN,
      );
    });
  });

  describe("quota-window key shape", () => {
    it("keys on (account_id, limit_id) with window_mins an attribute", () => {
      const keyOrdinalByColumn = new Map(
        columnsOf(PROVIDER_ACCOUNT_USAGE_WINDOWS_TABLE).map((column) => [column.name, column.pk]),
      );
      expect(keyOrdinalByColumn.get("account_id")).toBe(1);
      expect(keyOrdinalByColumn.get("limit_id")).toBe(2);
      // The assertion that matters: the window length is NOT part of the
      // identity. The pinned Claude surface publishes three limit identifiers
      // sharing a 10080-minute window, and a key that included the length would
      // admit two rows for one limit instead.
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
      // The deliberate absence of a CHECK. A closed list would fail a reading
      // closed the moment a vendor added a window, which is the opposite of the
      // degrade-honestly posture the rest of this plane takes.
      expect(checkMembersOf(usageWindowsSql, "limit_id")).toEqual([]);
    });
  });
});

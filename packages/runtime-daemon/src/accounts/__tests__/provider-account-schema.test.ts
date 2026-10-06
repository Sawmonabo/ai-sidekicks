// The provider-account tables on the schema the real migration runner builds. Every member of the
// provider, billing-mode and health-state unions is stored and a value outside each is refused, a
// generation below the floor is refused, a provider holds one default account at most, a
// credential home belongs to one account, a quota reading is keyed by account and limit alone,
// and a memory-import outcome whose count and time disagree with it is refused. The member lists
// are `Record<Union, true>` maps, so a member added to the contract is a type error here until
// its case exists, and that case then fails until the CHECK admits it.

import {
  CREDENTIAL_GENERATION_MIN,
  type BillingMode,
  type ProviderAccountHealthState,
} from "@ai-sidekicks/contracts/provider/account/record";
import { type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

const TIMESTAMP = "2026-09-30T00:00:00.000Z";
const NON_MEMBER = "not-a-member";
const CHECK_FAILURE = /CHECK constraint failed/;

const PROVIDER_MEMBERS: Record<ProviderName, true> = { claude: true, codex: true };

const BILLING_MODE_MEMBERS: Record<BillingMode, true> = {
  subscription: true,
  metered: true,
  unknown: true,
};

const HEALTH_STATE_MEMBERS: Record<ProviderAccountHealthState, true> = {
  authenticated: true,
  reauth_required: true,
  home_missing: true,
  indeterminate: true,
};

interface AccountColumns {
  readonly provider: string;
  readonly billingMode: string;
  readonly healthState: string | null;
  readonly credentialGeneration: number;
  readonly memoryImportOutcome: string | null;
  readonly memoryImportCount: number | null;
  readonly memoryImportedAt: string | null;
  readonly isDefault: 0 | 1;
  readonly credentialHomePath: string | null;
}

const VALID_ACCOUNT: AccountColumns = {
  provider: "claude",
  billingMode: "subscription",
  healthState: null,
  credentialGeneration: CREDENTIAL_GENERATION_MIN,
  memoryImportOutcome: null,
  memoryImportCount: null,
  memoryImportedAt: null,
  isDefault: 0,
  credentialHomePath: null,
};

describe("provider-account schema", () => {
  let db: DatabaseType;
  let nextAccountNumber = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // Each account gets its own id and, unless a case names one, its own home path, and none is a
  // default unless a case says so, so the unique indexes never refuse a row for a reason other
  // than the column under test. A health state is stored with the time it was observed, as the
  // schema requires of the pair.
  function insertAccount(overrides: Partial<AccountColumns>): string {
    const account = { ...VALID_ACCOUNT, ...overrides };
    nextAccountNumber += 1;
    const accountId = `account-${String(nextAccountNumber)}`;
    db.prepare(
      `INSERT INTO provider_accounts (account_id, provider, display_label, credential_home_path,
         credential_generation, billing_mode, health_state, health_observed_at, ` +
        `memory_import_outcome,
         memory_import_count, memory_imported_at, is_default, created_at, updated_at)
       VALUES (?, ?, 'Work', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      account.provider,
      account.credentialHomePath ?? `/homes/${accountId}`,
      account.credentialGeneration,
      account.billingMode,
      account.healthState,
      account.healthState === null ? null : TIMESTAMP,
      account.memoryImportOutcome,
      account.memoryImportCount,
      account.memoryImportedAt,
      account.isDefault,
      TIMESTAMP,
      TIMESTAMP,
    );
    return accountId;
  }

  function insertUsageWindow(accountId: string, limitId: string, windowMins: number): void {
    db.prepare(
      `INSERT INTO provider_account_usage_windows (account_id, limit_id, window_mins,
         used_percent, observed_at, observed_credential_generation, source)
       VALUES (?, ?, ?, 10, ?, ?, 'probe')`,
    ).run(accountId, limitId, windowMins, TIMESTAMP, CREDENTIAL_GENERATION_MIN);
  }

  describe("contract unions against the CHECK constraints", () => {
    it("stores every provider and refuses one outside the union", () => {
      for (const provider of Object.keys(PROVIDER_MEMBERS)) {
        expect(() => insertAccount({ provider })).not.toThrow();
      }
      expect(() => insertAccount({ provider: NON_MEMBER })).toThrow(CHECK_FAILURE);
    });

    it("stores every billing mode and refuses one outside the union", () => {
      for (const billingMode of Object.keys(BILLING_MODE_MEMBERS)) {
        expect(() => insertAccount({ billingMode })).not.toThrow();
      }
      expect(() => insertAccount({ billingMode: NON_MEMBER })).toThrow(CHECK_FAILURE);
    });

    it("stores every health state and NULL (never probed), refusing one outside the union", () => {
      for (const healthState of Object.keys(HEALTH_STATE_MEMBERS)) {
        expect(() => insertAccount({ healthState })).not.toThrow();
      }
      expect(() => insertAccount({ healthState: null })).not.toThrow();
      expect(() => insertAccount({ healthState: NON_MEMBER })).toThrow(CHECK_FAILURE);
    });

    it("stores the contract's generation floor and refuses a generation below it", () => {
      expect(() =>
        insertAccount({ credentialGeneration: CREDENTIAL_GENERATION_MIN }),
      ).not.toThrow();
      expect(() => insertAccount({ credentialGeneration: CREDENTIAL_GENERATION_MIN - 1 })).toThrow(
        CHECK_FAILURE,
      );
    });
  });

  it("allows each provider one default account and refuses a second", () => {
    insertAccount({ provider: "claude", isDefault: 1 });
    expect(() => insertAccount({ provider: "codex", isDefault: 1 })).not.toThrow();
    expect(() => insertAccount({ provider: "claude", isDefault: 0 })).not.toThrow();
    expect(() => insertAccount({ provider: "claude", isDefault: 1 })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("refuses a second account on a credential home, whatever its provider", () => {
    insertAccount({ provider: "claude", credentialHomePath: "/homes/shared" });
    expect(() => insertAccount({ provider: "codex", credentialHomePath: "/homes/shared" })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("keys a quota reading on (account_id, limit_id), with window_mins an attribute", () => {
    const accountId = insertAccount({});
    insertUsageWindow(accountId, "five_hour", 300);
    expect(() => {
      insertUsageWindow(accountId, "weekly", 300);
    }).not.toThrow();
    expect(() => {
      insertUsageWindow(accountId, "five_hour", 10080);
    }).toThrow(/UNIQUE constraint failed/);
  });

  describe("memory import columns", () => {
    it("stores each outcome the contract names, and no import at all", () => {
      expect(() =>
        insertAccount({
          memoryImportOutcome: null,
          memoryImportCount: null,
          memoryImportedAt: null,
        }),
      ).not.toThrow();
      expect(() =>
        insertAccount({
          memoryImportOutcome: "imported",
          memoryImportCount: 3,
          memoryImportedAt: TIMESTAMP,
        }),
      ).not.toThrow();
      expect(() =>
        insertAccount({
          memoryImportOutcome: "nothingToImport",
          memoryImportCount: null,
          memoryImportedAt: null,
        }),
      ).not.toThrow();
    });

    it("refuses an outcome whose count and time disagree with it", () => {
      // An outcome missing its count or time would read back as one the wire refuses, and
      // an import that copied nothing cannot carry them.
      const disagreeing: readonly Partial<AccountColumns>[] = [
        { memoryImportOutcome: "imported", memoryImportCount: null, memoryImportedAt: null },
        { memoryImportOutcome: "imported", memoryImportCount: 3, memoryImportedAt: null },
        {
          memoryImportOutcome: "nothingToImport",
          memoryImportCount: 3,
          memoryImportedAt: TIMESTAMP,
        },
        { memoryImportOutcome: "nothingToImport", memoryImportCount: 3, memoryImportedAt: null },
        { memoryImportOutcome: null, memoryImportCount: 3, memoryImportedAt: TIMESTAMP },
        { memoryImportOutcome: "imported", memoryImportCount: 0, memoryImportedAt: TIMESTAMP },
      ];
      for (const memoryImport of disagreeing) {
        expect(() => insertAccount(memoryImport)).toThrow(CHECK_FAILURE);
      }
    });
  });
});

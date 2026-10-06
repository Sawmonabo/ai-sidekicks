// The provider-account tables on the schema the daemon's writer builds, written through the writer
// as every store writes and read on the read-only connection. Every member of the
// provider, billing-mode and health-state unions is stored and a value outside each is refused, a
// generation below the floor is refused, a provider holds one default account at most, a
// credential home belongs to one account, a typed name is optional, unique per provider by its
// fold and renamed only where one is carried, each of those rules holds under INSERT OR REPLACE
// too, a quota reading is keyed by account and limit alone, and a memory-import outcome whose
// count and time disagree with it is refused. The member lists are `Record<Union, true>` maps, so
// a member added to the contract is a type error here until its case exists, and that case then
// fails until the CHECK admits it.

import {
  CREDENTIAL_GENERATION_MIN,
  type BillingMode,
  type ProviderAccountHealthState,
} from "@ai-sidekicks/contracts/provider/account/record";
import { type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { foldName } from "@ai-sidekicks/contracts/name-fold";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";

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
  readonly displayLabel: string | null;
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
  displayLabel: null,
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
  let database: ScratchDatabase;
  let nextAccountNumber = 0;

  beforeEach(async () => {
    database = await openScratchDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  /** Runs one statement as one write through the writer. */
  async function write(sql: string, bindings: readonly unknown[]): Promise<void> {
    await database.writer.write([{ sql, bindings }]);
  }

  // Each account gets its own id and, unless a case names one, its own home path, and none is a
  // default unless a case says so, so the unique indexes never refuse a row for a reason other
  // than the column under test. A health state is stored with the time it was observed, as the
  // schema requires of the pair, and a typed name with its fold, as the store writes it.
  // `replace` writes with INSERT OR REPLACE, under the id it names or a new one.
  async function insertAccount(
    overrides: Partial<AccountColumns>,
    replace?: { readonly accountId?: string },
  ): Promise<string> {
    const account = { ...VALID_ACCOUNT, ...overrides };
    nextAccountNumber += 1;
    const accountId = replace?.accountId ?? `account-${String(nextAccountNumber)}`;
    await write(
      `INSERT ${replace === undefined ? "" : "OR REPLACE "}INTO provider_accounts (account_id,
         provider, display_label, display_label_folded, credential_home_path,
         credential_generation, billing_mode, health_state, health_observed_at,
         memory_import_outcome, memory_import_count, memory_imported_at, is_default, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        account.provider,
        account.displayLabel,
        account.displayLabel === null ? null : foldName(account.displayLabel),
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
      ],
    );
    return accountId;
  }

  function accountIds(): readonly string[] {
    return database.reader
      .prepare<[], { account_id: string }>("SELECT account_id FROM provider_accounts")
      .all()
      .map((row) => row.account_id);
  }

  async function insertUsageWindow(
    accountId: string,
    limitId: string,
    windowMins: number,
  ): Promise<void> {
    await write(
      `INSERT INTO provider_account_usage_windows (account_id, limit_id, window_mins,
         used_percent, observed_at, observed_credential_generation, source)
       VALUES (?, ?, ?, 10, ?, ?, 'probe')`,
      [accountId, limitId, windowMins, TIMESTAMP, CREDENTIAL_GENERATION_MIN],
    );
  }

  describe("contract unions against the CHECK constraints", () => {
    it("stores every provider and refuses one outside the union", async () => {
      for (const provider of Object.keys(PROVIDER_MEMBERS)) {
        await insertAccount({ provider });
      }
      await expect(insertAccount({ provider: NON_MEMBER })).rejects.toThrow(CHECK_FAILURE);
    });

    it("stores every billing mode and refuses one outside the union", async () => {
      for (const billingMode of Object.keys(BILLING_MODE_MEMBERS)) {
        await insertAccount({ billingMode });
      }
      await expect(insertAccount({ billingMode: NON_MEMBER })).rejects.toThrow(CHECK_FAILURE);
    });

    it("stores every health state and NULL (never probed), refusing one outside the union", async () => {
      for (const healthState of Object.keys(HEALTH_STATE_MEMBERS)) {
        await insertAccount({ healthState });
      }
      await insertAccount({ healthState: null });
      await expect(insertAccount({ healthState: NON_MEMBER })).rejects.toThrow(CHECK_FAILURE);
    });

    it("stores the contract's generation floor and refuses a generation below it", async () => {
      await insertAccount({ credentialGeneration: CREDENTIAL_GENERATION_MIN });
      await expect(
        insertAccount({ credentialGeneration: CREDENTIAL_GENERATION_MIN - 1 }),
      ).rejects.toThrow(CHECK_FAILURE);
    });
  });

  it("allows each provider one default account and refuses a second", async () => {
    await insertAccount({ provider: "claude", isDefault: 1 });
    await insertAccount({ provider: "codex", isDefault: 1 });
    const other = await insertAccount({ provider: "claude", isDefault: 0 });
    await expect(insertAccount({ provider: "claude", isDefault: 1 })).rejects.toThrow(
      /is the default/,
    );
    await expect(
      write("UPDATE provider_accounts SET is_default = 1 WHERE account_id = ?", [other]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a second account on a credential home, whatever its provider", async () => {
    const shared = await insertAccount({ provider: "claude", credentialHomePath: "/homes/shared" });
    await expect(
      insertAccount({ provider: "codex", credentialHomePath: "/homes/shared" }),
    ).rejects.toThrow(/holds that credential_home_path/);
    const other = await insertAccount({ provider: "codex" });
    await expect(
      write("UPDATE provider_accounts SET credential_home_path = ? WHERE account_id = ?", [
        "/homes/shared",
        other,
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(accountIds()).toContain(shared);
  });

  it("stores an account with no typed name and reads it back as none", async () => {
    const accountId = await insertAccount({ displayLabel: null });
    expect(
      database.reader
        .prepare("SELECT display_label FROM provider_accounts WHERE account_id = ?")
        .get(accountId),
    ).toEqual({ display_label: null });
  });

  it("refuses a provider's second account with the same typed name under its fold", async () => {
    await insertAccount({ provider: "claude", displayLabel: "Work" });
    await expect(insertAccount({ provider: "claude", displayLabel: "WORK" })).rejects.toThrow(
      /holds that display_label/,
    );
    await insertAccount({ provider: "claude", displayLabel: "Straße" });
    await expect(insertAccount({ provider: "claude", displayLabel: "STRASSE" })).rejects.toThrow(
      /holds that display_label/,
    );
    await insertAccount({ provider: "codex", displayLabel: "work" });
    await insertAccount({ provider: "claude", displayLabel: "Personal" });
  });

  it("refuses a name with no fold beside it, and a fold with no name", async () => {
    const insert = `INSERT INTO provider_accounts (account_id, provider, display_label,
         display_label_folded, credential_home_path, billing_mode, created_at, updated_at)
       VALUES (?, 'claude', ?, ?, ?, 'subscription', ?, ?)`;
    await expect(
      write(insert, ["a", "Work", null, "/homes/a", TIMESTAMP, TIMESTAMP]),
    ).rejects.toThrow(CHECK_FAILURE);
    await expect(
      write(insert, ["b", null, "work", "/homes/b", TIMESTAMP, TIMESTAMP]),
    ).rejects.toThrow(CHECK_FAILURE);
  });

  it("renames an account that carries a typed name, to a name no other account holds", async () => {
    const named = await insertAccount({ displayLabel: "Work" });
    const unnamed = await insertAccount({ displayLabel: null });
    await insertAccount({ displayLabel: "Personal" });
    const rename = (displayLabel: string | null, accountId: string): Promise<void> =>
      write(
        "UPDATE provider_accounts SET display_label = ?, display_label_folded = ? WHERE account_id = ?",
        [displayLabel, displayLabel === null ? null : foldName(displayLabel), accountId],
      );
    await rename("Office", named);
    await expect(rename("Office 2", unnamed)).rejects.toThrow(/renamed only on an account/);
    await expect(rename(null, named)).rejects.toThrow(/renamed only on an account/);
    await expect(rename("PERSONAL", named)).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("holds every rule against INSERT OR REPLACE, which deletes what it collides with", async () => {
    const named = await insertAccount({ provider: "claude", displayLabel: "Work", isDefault: 1 });
    await insertUsageWindow(named, "five_hour", 300);
    const homed = await insertAccount({ provider: "codex", credentialHomePath: "/homes/kept" });
    // Written over, the account would lose its name rule and its quota readings to the cascade.
    await expect(insertAccount({ displayLabel: null }, { accountId: named })).rejects.toThrow(
      /never written over/,
    );
    await expect(insertAccount({ displayLabel: "Work" }, { accountId: named })).rejects.toThrow(
      /never written over/,
    );
    // A new account that takes another's name, default mark or home would delete that account.
    await expect(insertAccount({ displayLabel: "WORK" }, {})).rejects.toThrow(
      /holds that display_label/,
    );
    await expect(insertAccount({ provider: "claude", isDefault: 1 }, {})).rejects.toThrow(
      /is the default/,
    );
    await expect(insertAccount({ credentialHomePath: "/homes/kept" }, {})).rejects.toThrow(
      /holds that credential_home_path/,
    );
    expect(accountIds()).toEqual([named, homed]);
    expect(
      database.reader
        .prepare(
          "SELECT count(*) AS readings FROM provider_account_usage_windows WHERE account_id = ?",
        )
        .get(named),
    ).toEqual({ readings: 1 });
    // A replacement that collides with nothing is an ordinary insert.
    await insertAccount({ provider: "codex", displayLabel: "Work" }, {});
  });

  it("keys a quota reading on (account_id, limit_id), with window_mins an attribute", async () => {
    const accountId = await insertAccount({});
    await insertUsageWindow(accountId, "five_hour", 300);
    await insertUsageWindow(accountId, "weekly", 300);
    await expect(insertUsageWindow(accountId, "five_hour", 10080)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  describe("memory import columns", () => {
    it("stores each outcome the contract names, and no import at all", async () => {
      await insertAccount({
        memoryImportOutcome: null,
        memoryImportCount: null,
        memoryImportedAt: null,
      });
      await insertAccount({
        memoryImportOutcome: "imported",
        memoryImportCount: 3,
        memoryImportedAt: TIMESTAMP,
      });
      await insertAccount({
        memoryImportOutcome: "nothingToImport",
        memoryImportCount: null,
        memoryImportedAt: null,
      });
    });

    it("refuses an outcome whose count and time disagree with it", async () => {
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
        await expect(insertAccount(memoryImport)).rejects.toThrow(CHECK_FAILURE);
      }
    });
  });
});

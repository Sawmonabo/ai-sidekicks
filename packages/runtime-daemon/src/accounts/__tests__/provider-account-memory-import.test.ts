// The provider-account table's memory-import columns on the schema the real migration runner
// builds: every outcome the contract names is stored, and an outcome whose count and time
// disagree with it is refused.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, applyPragmas } from "../../session/migration-runner.js";

describe("provider-account memory import columns", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    applyPragmas(db);
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

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

// Damage to the database file found while the daemon has it open: the start's check, or any read
// or write SQLite failed as corrupt. The file cannot be replaced under open connections, so the
// damage is recorded beside the file, the daemon stops, and its next start repairs the file from
// the record, before anything opens it.

import { readFile, rm } from "node:fs/promises";

import { writeFileAtomically } from "../../file/atomic-write.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";

/**
 * Whether SQLite failed because the file is damaged: any `SQLITE_CORRUPT` code, an index's
 * included, which a write can raise too, or a file that is not a database.
 */
export function isDatabaseDamageError(error: unknown): boolean {
  return hasSqliteErrorCode(error, "SQLITE_CORRUPT") || hasSqliteErrorCode(error, "SQLITE_NOTADB");
}

/** Learns of damage to the database file once, from whichever part of the daemon meets it. */
export class DatabaseDamageWatch {
  /** Resolves with what the first damage found was; never settles while none is. */
  readonly whenFound: Promise<string>;

  readonly #found = Promise.withResolvers<string>();
  #isFound = false;

  constructor() {
    this.whenFound = this.#found.promise;
  }

  /** Whether damage has been found, so a caller can act before {@link whenFound}'s callbacks run. */
  get isFound(): boolean {
    return this.#isFound;
  }

  /** Records damage the check or a caller describes as `damage`; only the first counts. */
  find(damage: string): void {
    if (!this.#isFound) {
      this.#isFound = true;
      this.#found.resolve(damage);
    }
  }

  /** Records `error` as damage when SQLite raised it for a damaged file; any other is ignored. */
  report(error: unknown): void {
    if (isDatabaseDamageError(error)) {
      this.find(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Records the damage beside the database file, durably, so the next start repairs the file.
 * Rejects with the file system's error.
 */
export async function recordDatabaseDamage(databasePath: string, damage: string): Promise<void> {
  await writeFileAtomically(damageRecordPath(databasePath), damage, 0o600);
}

/** The damage a run recorded for the next start to repair, `undefined` when none was. */
export async function readDatabaseDamage(databasePath: string): Promise<string | undefined> {
  try {
    return await readFile(damageRecordPath(databasePath), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Removes the damage record once the file it named is replaced or gone. */
export async function removeDatabaseDamage(databasePath: string): Promise<void> {
  await rm(damageRecordPath(databasePath), { force: true });
}

function damageRecordPath(databasePath: string): string {
  return `${databasePath}.damaged`;
}

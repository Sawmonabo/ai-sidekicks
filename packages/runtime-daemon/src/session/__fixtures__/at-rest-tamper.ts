// Test support for read guards against an edited database file. STRICT typing
// is checked only when SQLite writes a row, so a file changed outside SQLite can
// still hand back any storage class in any column.

import type { Database } from "better-sqlite3";

/**
 * Runs `write` with `table`'s STRICT typing lifted, then restores it, so the
 * write can leave a value of the wrong storage class the way an at-rest edit
 * of the file would.
 */
export function writeAcrossStrictTyping(
  database: Database,
  table: string,
  write: () => void,
): void {
  const strictSql = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .pluck()
    .get(table) as string;
  replaceTableSql(database, table, strictSql.replace(/\)\s*STRICT\s*$/, ")"));
  try {
    write();
  } finally {
    replaceTableSql(database, table, strictSql);
  }
}

// Rewriting `sqlite_schema` needs better-sqlite3's defensive mode off; bumping
// `schema_version` makes the connection reload the table definition.
function replaceTableSql(database: Database, table: string, sql: string): void {
  const schemaVersion = database.pragma("schema_version", { simple: true }) as number;
  database.unsafeMode(true);
  database.pragma("writable_schema = ON");
  try {
    database
      .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?")
      .run(sql, table);
    database.pragma(`schema_version = ${schemaVersion + 1}`);
  } finally {
    database.pragma("writable_schema = OFF");
    database.unsafeMode(false);
  }
}

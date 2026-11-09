// The case tables the Rust contracts' tests read, read here by each TypeScript twin's suite, so the
// two sides run the same rows.
import { readFileSync } from "node:fs";

import type { z } from "zod";

const CASE_TABLE_FOLDER = new URL(
  "../../../../crates/sidekicks-contracts/tests/fixtures/",
  import.meta.url,
);

/**
 * Reads the case table at `relativePath` under the Rust contracts' fixtures, parsed by `schema`;
 * throws on a row the schema refuses.
 */
export function readCaseTable<Schema extends z.ZodType>(
  schema: Schema,
  relativePath: string,
): z.output<Schema> {
  return schema.parse(JSON.parse(readFileSync(new URL(relativePath, CASE_TABLE_FOLDER), "utf8")));
}

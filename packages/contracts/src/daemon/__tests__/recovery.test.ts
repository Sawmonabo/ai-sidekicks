// The line a person reads while the service repairs its database file. The command line draws it
// by the same case table, so both screens say the same words around the same counts.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { countSchema } from "../../internal/wire-scalars.js";
import { describeDaemonRepairingLine } from "../recovery.js";

const repairingLineCases = readCaseTable(
  z.array(
    z
      .object({
        progress: z.object({ done: countSchema, total: countSchema }).strict().nullable(),
        parts: z.array(z.union([z.string(), z.object({ count: countSchema }).strict()])),
      })
      .strict(),
  ),
  "repairing-line.json",
);

describe("describeDaemonRepairingLine", () => {
  it.each(repairingLineCases)("draws the repair at $progress", ({ progress, parts }) => {
    expect(describeDaemonRepairingLine(progress ?? undefined, (count) => ({ count }))).toEqual(
      parts,
    );
  });
});

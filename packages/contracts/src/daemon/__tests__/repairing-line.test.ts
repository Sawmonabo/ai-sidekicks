// The line a person reads while the service repairs its database file. The command line draws it
// by the same case table, parsed strictly here with zod, so both screens say the same words around
// the same counts.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { describeDaemonRepairingLine } from "../repairing-line.js";

const count = z.int().nonnegative();

const repairingLineCases = readCaseTable(
  z.array(
    z
      .object({
        progress: z.object({ done: count, total: count }).strict().nullable(),
        parts: z.array(z.union([z.string(), z.object({ count }).strict()])),
      })
      .strict(),
  ),
  "repairing-line.json",
);

describe("describeDaemonRepairingLine", () => {
  it.each(repairingLineCases)("draws the repair at $progress", ({ progress, parts }) => {
    expect(
      describeDaemonRepairingLine(progress ?? undefined, (figure) => ({ count: figure })),
    ).toEqual(parts);
  });
});

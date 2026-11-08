// The line a person reads while the service repairs its database file. The command line draws it
// by the same case table, so both screens say the same words around the same counts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { describeDaemonRepairingLine } from "../recovery.js";

const repairingLineCases = z
  .array(
    z
      .object({
        progress: z
          .object({ done: z.int().nonnegative(), total: z.int().nonnegative() })
          .strict()
          .nullable(),
        parts: z.array(z.union([z.string(), z.object({ count: z.int().nonnegative() }).strict()])),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../crates/sidekicks-contracts/tests/fixtures/repairing-line.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("describeDaemonRepairingLine", () => {
  it.each(repairingLineCases)("draws the repair at $progress", ({ progress, parts }) => {
    expect(describeDaemonRepairingLine(progress ?? undefined, (count) => ({ count }))).toEqual(
      parts,
    );
  });
});

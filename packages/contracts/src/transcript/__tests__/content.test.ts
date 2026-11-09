// A row's body as a row read and a body read report it, from what is stored. The daemon's readers
// read the same case table, parsed strictly here with zod, so both sides answer a stored body alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { PAGE_MAX_BYTES } from "../../generated/jsonrpc/page.js";
import { storedBodyContentOf, transcriptRowContentOf } from "../content.js";

const count = z.int().nonnegative();
const available = z
  .object({ status: z.literal("available"), body: z.string(), contentLength: count.optional() })
  .strict();
const unavailable = z
  .object({ status: z.literal("unavailable"), reason: z.literal("absent") })
  .strict();
const large = z.object({ status: z.literal("large"), contentLength: count }).strict();

const storedBodyCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        payload: z.record(z.string(), z.unknown()).nullable(),
        stored: z
          .object({ byteLength: z.int().nonnegative(), body: z.string().nullable() })
          .strict()
          .nullable(),
        bodyRead: z.discriminatedUnion("status", [
          available.extend({ offset: count, nextOffset: count.nullable() }),
          unavailable,
        ]),
        rowContent: z.discriminatedUnion("status", [available, unavailable, large]),
      })
      .strict(),
  ),
  "transcript/stored-body.json",
);

describe("reading a stored body", () => {
  it.each(storedBodyCases)("$note", ({ payload, stored, bodyRead, rowContent }) => {
    const body = stored?.body ?? undefined;
    expect(storedBodyContentOf(payload ?? undefined, body)).toStrictEqual(bodyRead);
    expect(
      transcriptRowContentOf(
        payload ?? undefined,
        stored === null ? undefined : { byteLength: stored.byteLength, body },
      ),
    ).toStrictEqual(rowContent);
  });

  // Each control character takes six JSON bytes, so this body spans two pages; the first part ends
  // at the page and names where the second starts, in UTF-8 bytes.
  it("answers a body over one page by its first part", () => {
    const body = `${"\u0001".repeat(200_000)}é`;
    const part = storedBodyContentOf(undefined, body);
    const firstLength = Math.floor((PAGE_MAX_BYTES - 2) / 6);
    expect(part).toStrictEqual({
      status: "available",
      body: body.slice(0, firstLength),
      offset: 0,
      nextOffset: firstLength,
    });
  });
});

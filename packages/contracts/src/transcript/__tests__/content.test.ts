// A row's body as a row read and a body read report it, from what is stored. The daemon's readers
// read the same case table, parsed strictly here with zod, so both sides answer a stored body alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { PAGE_MAX_BYTES } from "../../generated/jsonrpc/page.js";
import {
  BodyReadOffsetRefusedError,
  storedBodyContentOf,
  transcriptRowContentOf,
} from "../content.js";

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
});

/** Reads `body` part by part from `offset` until a part names no next one: the parts joined, and how many. */
function readFrom(
  body: string,
  offset: number,
): { readonly joined: string; readonly partCount: number } {
  let joined = "";
  let partCount = 0;
  let next: number | null = offset;
  while (next !== null) {
    const part = storedBodyContentOf(undefined, body, next);
    if (part.status !== "available") {
      throw new Error("a stored body is available");
    }
    joined += part.body;
    partCount += 1;
    next = part.nextOffset;
  }
  return { joined, partCount };
}

// The daemon's own reader runs these same cases.
describe("a body read in parts joins back whole from any character boundary", () => {
  // Each control character takes six JSON bytes, so 200,000 of them span two pages.
  it.each([
    { note: "over one page", body: "\u0001".repeat(200_000), offset: 0, rest: 0, partCount: 2 },
    { note: "from a later offset", body: "a\u00e9b", offset: 3, rest: 2, partCount: 1 },
    { note: "at the end", body: "ab", offset: 2, rest: 2, partCount: 1 },
  ])("$note", ({ body, offset, rest, partCount }) => {
    expect(readFrom(body, offset)).toStrictEqual({ joined: body.slice(rest), partCount });
  });

  // The first part ends at the page and names where the second starts, in UTF-8 bytes.
  it("ends a part over one page at the page", () => {
    const body = `${"\u0001".repeat(200_000)}é`;
    const firstLength = Math.floor((PAGE_MAX_BYTES - 2) / 6);
    expect(storedBodyContentOf(undefined, body)).toStrictEqual({
      status: "available",
      body: body.slice(0, firstLength),
      offset: 0,
      nextOffset: firstLength,
    });
  });

  it.each([
    { note: "inside a character", body: "a\u00e9b", offset: 2, bodyLength: 4 },
    { note: "past the end", body: "ab", offset: 3, bodyLength: 2 },
  ])("refuses an offset $note", ({ body, offset, bodyLength }) => {
    expect(() => storedBodyContentOf(undefined, body, offset)).toThrow(
      expect.objectContaining({
        constructor: BodyReadOffsetRefusedError,
        code: "transcript.body.offsetInvalid",
        offset,
        bodyLength,
      }),
    );
  });
});

describe("a part's block starts", () => {
  // The first start falls before the part, so a part from offset 3 carries the second alone, as its
  // drawn offset in four little-endian bytes.
  it("carries the starts that fall in it", () => {
    const part = storedBodyContentOf(undefined, "a\u00e9b\n\nc", 3, {
      kind: "starts",
      starts: [
        { storedOffset: 0, drawnOffset: 0 },
        { storedOffset: 6, drawnOffset: 5 },
      ],
    });
    expect(part).toStrictEqual({
      status: "available",
      body: "b\n\nc",
      offset: 3,
      nextOffset: null,
      blockStarts: new Uint8Array([5, 0, 0, 0]),
    });
  });

  it("says on every part that the cut failed", () => {
    const body = "\u0001".repeat(200_000);
    const failed = { kind: "failed", failure: "stalled" } as const;
    const first = storedBodyContentOf(undefined, body, 0, failed);
    expect(first).toMatchObject({ blockCutFailure: "stalled" });
    if (first.status !== "available" || first.nextOffset === null) {
      throw new Error("the body spans two parts");
    }
    expect(storedBodyContentOf(undefined, body, first.nextOffset, failed)).toMatchObject({
      blockCutFailure: "stalled",
      nextOffset: null,
    });
  });
});

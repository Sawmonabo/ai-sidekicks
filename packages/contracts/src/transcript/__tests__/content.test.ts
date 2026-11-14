// A row's body as a row read and a body read report it, from what is stored, and a body read in
// parts. The daemon's readers read the same case tables, parsed strictly here with zod, so both
// sides answer a stored body alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { PAGE_MAX_BYTES } from "../../generated/jsonrpc/page.js";
import {
  type BodyBlockCut,
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

const blockStart = z.object({ storedOffset: count, drawnOffset: count }).strict();
const blockCutFailure = z.enum(["stalled", "overPage"]);

const bodyPartCases = readCaseTable(
  z.array(
    z
      .object({
        note: z.string(),
        body: z.string(),
        repeat: count.optional(),
        offset: count,
        blockCut: z
          .union([
            z.object({ starts: z.array(blockStart) }).strict(),
            z.object({ failed: blockCutFailure }).strict(),
          ])
          .optional(),
        read: z
          .object({
            partCount: count,
            blockStarts: z.array(count).optional(),
            blockCutFailure: blockCutFailure.optional(),
          })
          .strict()
          .optional(),
        refusedBodyLength: count.optional(),
      })
      .strict(),
  ),
  "transcript/body-parts.json",
);

/** The drawn offsets a part's block starts carry, each a little-endian u32. */
function drawnOffsetsOf(blockStarts: Uint8Array | undefined): number[] {
  if (blockStarts === undefined) {
    return [];
  }
  const view = new DataView(blockStarts.buffer, blockStarts.byteOffset, blockStarts.byteLength);
  return Array.from({ length: blockStarts.byteLength / 4 }, (_, index) =>
    view.getUint32(4 * index, true),
  );
}

/**
 * Reads `body` part by part from `offset` until a part names no next one: the parts joined, how
 * many, the drawn block starts they carry and each part's cut failure.
 */
function readParts(
  body: string,
  offset: number,
  blockCut: BodyBlockCut,
): {
  readonly joined: string;
  readonly partCount: number;
  readonly blockStarts: readonly number[];
  readonly failures: readonly (string | undefined)[];
} {
  let joined = "";
  let partCount = 0;
  const blockStarts: number[] = [];
  const failures: (string | undefined)[] = [];
  let next: number | null = offset;
  while (next !== null) {
    const part = storedBodyContentOf(undefined, body, next, blockCut);
    if (part.status !== "available") {
      throw new Error("a stored body is available");
    }
    joined += part.body;
    partCount += 1;
    blockStarts.push(...drawnOffsetsOf(part.blockStarts));
    failures.push(part.blockCutFailure);
    next = part.nextOffset;
  }
  return { joined, partCount, blockStarts, failures };
}

// The daemon's own reader runs the same table.
describe("a body read in parts joins back whole from any character boundary", () => {
  it.each(bodyPartCases)(
    "$note",
    ({ body: piece, repeat, offset, blockCut, read, refusedBodyLength }) => {
      const body = piece.repeat(repeat ?? 1);
      const cut: BodyBlockCut =
        blockCut === undefined
          ? { kind: "notCut" }
          : "starts" in blockCut
            ? { kind: "starts", starts: blockCut.starts }
            : { kind: "failed", failure: blockCut.failed };
      if (refusedBodyLength !== undefined) {
        expect(() => readParts(body, offset, cut)).toThrow(
          expect.objectContaining({
            constructor: BodyReadOffsetRefusedError,
            code: "transcript.body.offsetInvalid",
            offset,
            bodyLength: refusedBodyLength,
          }),
        );
        return;
      }
      if (read === undefined) {
        throw new Error("a case reads or is refused");
      }
      const rest = new TextDecoder().decode(new TextEncoder().encode(body).slice(offset));
      expect(readParts(body, offset, cut)).toStrictEqual({
        joined: rest,
        partCount: read.partCount,
        blockStarts: read.blockStarts ?? [],
        failures: Array.from({ length: read.partCount }, () => read.blockCutFailure),
      });
    },
  );

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
});

// A large body longer than one page is read part by part, each asked for at the offset the last one
// names, and lands and copies whole; a part that fails fails the read.

import { describe, expect, it, vi } from "vitest";

import { PAGE_MAX_BYTES } from "@ai-sidekicks/contracts/jsonrpc/page";
import { storedBodyContentOf } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptBodyReadResponse } from "@ai-sidekicks/contracts/transcript/operations";

import { refuse } from "#renderer/lib/refusal/contract.js";
import type { TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { FullBodyReads } from "./full-body-reads.js";

const ROW_ID = "event-large";

/** A body of numbered words two and a half pages long, so no two of its parts read alike. */
const BODY = Array.from({ length: Math.ceil((2.5 * PAGE_MAX_BYTES) / 8) }, (_, index) =>
  String(index).padStart(7, "0"),
).join(" ");

/** One block start in each of the body's three parts; the body is ASCII, so both offsets agree. */
const BLOCK_STARTS = [0, 1_200_000, 2_200_000];

const PAYLOAD = { contentLength: BODY.length };

/** The daemon's read of `BODY` from the asked offset, and every offset asked, in order. */
function pagedBody(): { readonly readBody: TranscriptBodyRead; readonly offsets: number[] } {
  const offsets: number[] = [];
  const readBody: TranscriptBodyRead = (request) => {
    offsets.push(request.offset ?? 0);
    return Promise.resolve({
      status: "served",
      value: storedBodyContentOf(PAYLOAD, BODY, request.offset, {
        kind: "starts",
        starts: BLOCK_STARTS.map((offset) => ({ storedOffset: offset, drawnOffset: offset })),
      }),
    });
  };
  return { readBody, offsets };
}

function sessionStoreAdmitting(
  admitFullBody: (rowId: string, body: TranscriptBodyReadResponse) => void,
): SessionStore {
  return { sessionId: "session-1", admitFullBody } as unknown as SessionStore;
}

/** The drawn offsets a body's block starts carry, each a little-endian u32. */
function drawnOffsetsOf(blockStarts: Uint8Array | undefined): number[] {
  const view = new DataView(blockStarts?.buffer ?? new ArrayBuffer(0));
  return Array.from({ length: view.byteLength / 4 }, (_, index) => view.getUint32(4 * index, true));
}

describe("a body longer than one page", () => {
  it("copies and shows all three parts joined in order", async () => {
    const { readBody, offsets } = pagedBody();
    const admitFullBody = vi.fn<(rowId: string, body: TranscriptBodyReadResponse) => void>();
    const fullBodyReads = new FullBodyReads(sessionStoreAdmitting(admitFullBody), readBody);

    const copied = await fullBodyReads.readFullBody(ROW_ID);
    expect(offsets).toHaveLength(3);
    expect(copied.status === "served" && copied.value.status === "available").toBe(true);
    const copiedBody = copied.status === "served" ? copied.value : undefined;
    expect(copiedBody?.status === "available" && copiedBody.body === BODY).toBe(true);
    expect(copiedBody).toMatchObject({ offset: 0, nextOffset: null, contentLength: BODY.length });
    expect(
      drawnOffsetsOf(copiedBody?.status === "available" ? copiedBody.blockStarts : undefined),
    ).toStrictEqual(BLOCK_STARTS);

    fullBodyReads.open(ROW_ID);
    await vi.waitFor(() => {
      expect(admitFullBody).toHaveBeenCalledTimes(1);
    });
    const [admittedRowId, admitted] = admitFullBody.mock.calls[0] ?? [];
    expect(admittedRowId).toBe(ROW_ID);
    expect(admitted?.status === "available" && admitted.body === BODY).toBe(true);
  });

  it("reads as the failed body when its second part is refused", async () => {
    const refusal = refuse(
      "daemon-call",
      "call-rejected",
      "The background service did not answer.",
    );
    const { readBody: servedPages } = pagedBody();
    const readBody: TranscriptBodyRead = (request, options) =>
      request.offset === undefined
        ? servedPages(request, options)
        : Promise.resolve({ status: "refused", refusal });
    const admitFullBody = vi.fn<(rowId: string, body: TranscriptBodyReadResponse) => void>();
    const fullBodyReads = new FullBodyReads(sessionStoreAdmitting(admitFullBody), readBody);

    await expect(fullBodyReads.readFullBody(ROW_ID)).resolves.toStrictEqual({
      status: "refused",
      refusal,
    });

    fullBodyReads.open(ROW_ID);
    await vi.waitFor(() => {
      expect(fullBodyReads.readingOf(ROW_ID)).toBe("refused");
    });
    expect(admitFullBody).not.toHaveBeenCalled();
  });
});

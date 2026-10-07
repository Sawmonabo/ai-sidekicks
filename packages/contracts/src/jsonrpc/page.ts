// The byte budget every paged reply shares. A row count alone is not a bound, since one valid entry
// can run to tens of KB, so each page is measured in bytes against a budget well inside the
// transport's message limit.
import type { z } from "zod";

import { jsonUtf8ByteLength } from "./message.js";

/**
 * The byte ceiling on a reply's one large member, measured as {@link jsonUtf8ByteLength} of that
 * member: a page's `entries`, `reasoningEntries`, `hits`, `sessions` or `groups`, or a read's
 * stored `body` or `files`. It is a 1,000,000-byte reply less 8,192 bytes for the envelope, the
 * echoed id and a continuation cursor, sized apart from the message limit.
 */
export const PAGE_MAX_BYTES = 991_808;

/**
 * How many leading entries of `candidates`, at most `maxCount`, fit
 * {@link PAGE_MAX_BYTES} exactly, so a page built from the count passes the schema. A
 * non-empty list yields at least one, since a zero would stall the cursor; an over-budget lone
 * entry is then refused by the schema.
 */
export function countEntriesFittingOneFrame(
  candidates: readonly unknown[],
  maxCount: number,
): number {
  // The two brackets are charged up front; every element past the first also charges a comma.
  let usedBytes = 2;
  let fittedCount = 0;
  const ceiling = Math.min(maxCount, candidates.length);
  for (let index = 0; index < ceiling; index += 1) {
    const entryBytes = jsonUtf8ByteLength(candidates[index]);
    const separatorBytes = fittedCount === 0 ? 0 : 1;
    if (usedBytes + separatorBytes + entryBytes > PAGE_MAX_BYTES) {
      // The first candidate alone is over budget: deliver it alone rather than an empty page
      // beside an unconsumed cursor.
      if (fittedCount === 0) {
        return 1;
      }
      break;
    }
    usedBytes += separatorBytes + entryBytes;
    fittedCount += 1;
  }
  return fittedCount;
}

/**
 * Refuse a reply member over the page budget, so an oversized reply is a failed read. The issue
 * path names the member, so a client learns which one overflowed; a paged member's producer
 * stops at whichever of its row limit and this budget trips first.
 */
export function requireMemberToRideOneFrame(
  member: unknown,
  memberName: string,
  issueContext: z.RefinementCtx,
): void {
  const measuredBytes = jsonUtf8ByteLength(member);
  if (measuredBytes > PAGE_MAX_BYTES) {
    issueContext.addIssue({
      code: "custom",
      path: [memberName],
      message:
        `${memberName} measures ${String(measuredBytes)} JSON bytes, over the ` +
        `${String(PAGE_MAX_BYTES)}-byte page budget`,
    });
  }
}

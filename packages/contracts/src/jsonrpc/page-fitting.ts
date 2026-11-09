// How many entries one page takes under its byte budget and its row limit.
import { jsonUtf8ByteLength } from "./byte-length.js";

/**
 * How many leading entries of `candidates`, at most `maxCount`, fit `budgetBytes` once written as
 * one JSON array, so a page built from the count passes its cap. A non-empty list yields at least
 * one, since none would stall the cursor; a lone entry over the budget is then refused by the
 * reply's cap.
 */
export function countEntriesFittingOneFrame(
  candidates: readonly unknown[],
  maxCount: number,
  budgetBytes: number,
): number {
  // The two brackets are charged up front; every entry past the first also charges a comma.
  let usedBytes = 2;
  let fittedCount = 0;
  const ceiling = Math.min(maxCount, candidates.length);
  for (let index = 0; index < ceiling; index += 1) {
    const entryBytes = jsonUtf8ByteLength(candidates[index]);
    const separatorBytes = fittedCount === 0 ? 0 : 1;
    if (usedBytes + separatorBytes + entryBytes > budgetBytes) {
      // A first entry alone over the budget rides alone rather than leave an empty page beside an
      // unconsumed cursor.
      return Math.max(fittedCount, 1);
    }
    usedBytes += separatorBytes + entryBytes;
    fittedCount += 1;
  }
  return fittedCount;
}

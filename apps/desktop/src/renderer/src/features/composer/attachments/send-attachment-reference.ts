// The attachment reference a message could carry, folded from the staged list's ledger.
//
// AN ATTACHMENT REFERENCE IS AN ORDERED LIST OF ARTIFACT IDS AND NEVER BYTES, in the
// user's own order: this fold reads the staged list's ledger as published and never sorts,
// groups, or de-duplicates. The ledger is the record, and a second ordering here would be
// a second answer to which attachment is first.
//
// IT IS COMPOSED AND SHOWN BESIDE THE ARTIFACTS. The strip reads the disposition below
// to say how many settled artifacts are ready to reference; nothing here puts them on a
// request.

import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/**
 * What this staged list would put on a send.
 *
 * A discriminated union rather than a list plus a flag: "nothing is attached" and
 * "something is attached, settled or not" are different facts, and a surface that read
 * an empty list for both would report the second as the first.
 */
export type SendAttachmentReference =
  | { readonly disposition: "none" }
  | {
      readonly disposition: "held";
      /** The minted artifacts, in the order the user declared them. */
      readonly artifactIds: readonly string[];
      /** Uploads still running or refused, which are not in the reference. */
      readonly unsettledCount: number;
    };

/** The artifact ids the staged list's settled attachments minted, and how many are not settled. */
export function composeSendAttachmentReference(
  entries: readonly AttachmentIngestEntry[],
): SendAttachmentReference {
  // Completed entries only: an artifact exists once `AttachmentIngestComplete` has settled,
  // so an in-flight upload has no id to reference and a refused one never will. The count
  // of what is left out lets the surface say a send is leaving something behind.
  const artifactIds: string[] = [];
  let unsettledCount = 0;
  for (const entry of entries) {
    const artifactId = entry.derived?.artifactId;
    if (artifactId === undefined) {
      // `abandoned` is deliberately counted here with `declared`, `ingesting`, and
      // `refused`: a person who cancelled has still left a chip on the staged list, and a
      // count that excluded it would disagree with what is on screen.
      unsettledCount += 1;
      continue;
    }
    artifactIds.push(artifactId);
  }
  if (artifactIds.length === 0 && unsettledCount === 0) {
    return { disposition: "none" };
  }
  return { disposition: "held", artifactIds, unsettledCount };
}

// The attachment reference a message could carry: an ordered list of artifact ids, never
// bytes, in the user's own order. The fold never sorts, groups or de-duplicates, so the record
// stays the one answer to which attachment is first. Nothing here puts them on a request.

import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/**
 * What this staged list would put on a send. A union rather than a list plus a flag, so an
 * empty list cannot stand for both "nothing is attached" and "something is, unsettled".
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

/** The artifact ids the settled attachments minted, and how many attachments are not settled. */
export function composeSendAttachmentReference(
  entries: readonly AttachmentIngestEntry[],
): SendAttachmentReference {
  // Completed entries only: an in-flight upload has no artifact id yet and a refused one never
  // will. The count lets the composer say a send is leaving something behind.
  const artifactIds: string[] = [];
  let unsettledCount = 0;
  for (const entry of entries) {
    const artifactId = entry.derived?.artifactId;
    if (artifactId === undefined) {
      // `abandoned` counts as unsettled too: a canceled chip is still on the staged list.
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

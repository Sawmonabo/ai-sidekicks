// What a send would carry, and what stops it carrying it.
//
// AN ATTACHMENT REFERENCE IS AN ORDERED LIST OF ARTIFACT IDS AND NEVER BYTES, and the
// ORDER is the user's own — caller-declared and preserved end to end — so this
// fold reads the carrier's ledger in its published order and never sorts, groups, or
// de-duplicates. The ledger is the record; a second ordering here would be a second
// answer to which attachment is first.
//
// AND IT IS COMPOSED EVEN THOUGH NOTHING DELIVERS IT YET, which is the decision this
// module exists to record. The registered carriers a composer send resolves to are
// `run.queueCreate` and `run.intervene`, and the attachment arm on the second is
// `unknown[]` — an UNTYPED arm, and an attachment is never delivered over one, each
// arm's retyping being a prerequisite of the first delivery wiring through it. So the
// reference is composed, rendered, and NOT put on a request: a console that quietly
// dropped it would leave a person watching an upload finish and a message send with
// nothing attached and no word about it, and a console that pushed it onto the untyped
// arm would break the one rule the contract states outright.
//
// WHICH IS WHY THE HELD ARM IS A VALUE AND NOT A SILENCE. The disposition below is what
// the surface renders, so the reason a settled artifact is not riding this turn is on
// screen beside the artifacts themselves — and the day the arms are typed, the `held`
// arm loses its only producer and this module's diff is the one that removes it.

import type { AttachmentIngestEntry } from "../../../../console/repos/index.js";
import type { ComposerArtifactAttachment } from "../../../../console/seats/index.js";

/**
 * What this carrier would put on a send, and whether anything can carry it.
 *
 * A discriminated union rather than a list plus a flag: "nothing is attached" and
 * "these are attached and no registered arm can take them" are different facts, and a
 * surface that read an empty list for both would report the second as the first.
 */
export type SendAttachmentReference =
  | { readonly disposition: "none" }
  | {
      readonly disposition: "held";
      /** The minted artifacts, in the order the user declared them. */
      readonly artifactIds: readonly string[];
      /** Uploads still running or refused, which are not part of the reference yet. */
      readonly unsettledCount: number;
    };

/**
 * The ordered reference this composer's settled attachments have minted.
 *
 * COMPLETED ENTRIES ONLY, and that is the contract rather than a convenience: an
 * artifact exists once `AttachmentIngestComplete` has settled and not before, so an
 * in-flight upload has no id to reference and a refused one never will. The count of
 * what is not in the list travels beside it so the surface can say a send is leaving
 * something behind rather than silently shortening the carrier.
 *
 * TWO SOURCES AND ONE ORDER. A file a person chose goes through this carrier; a page
 * a view family attached went through the same ingest pipeline inside that family and
 * came back already minted. Both are artifact ids by the time they arrive here, so
 * they join one list — the carrier's ledger order first, then the order the menu rows
 * settled in — rather than two lists a send would have to reconcile.
 */
export function sendAttachmentReference(
  entries: readonly AttachmentIngestEntry[],
  familyAttachments: readonly ComposerArtifactAttachment[],
): SendAttachmentReference {
  const artifactIds: string[] = [];
  let unsettledCount = 0;
  for (const entry of entries) {
    const artifactId = entry.derived?.artifactId;
    if (artifactId === undefined) {
      // `abandoned` is deliberately counted here with `declared`, `ingesting`, and
      // `refused`: a person who cancelled has still left a chip on the carrier, and a
      // count that excluded it would disagree with what is on screen.
      unsettledCount += 1;
      continue;
    }
    artifactIds.push(artifactId);
  }
  for (const attachment of familyAttachments) {
    artifactIds.push(attachment.artifactId);
  }
  if (artifactIds.length === 0 && unsettledCount === 0) {
    return { disposition: "none" };
  }
  return { disposition: "held", artifactIds, unsettledCount };
}

/**
 * Why a composed reference does not ride the send, in the words a person reads.
 *
 * A CONSTANT rather than a sentence built per render, because it says one thing and
 * says it the same way every time — and because the value is what the test asserts
 * against, so the surface and its check cannot describe the hold differently.
 */
export const ATTACHMENT_DELIVERY_HELD_COPY =
  "These stay in this session as artifacts and are reusable. They do not ride this message: the registered send carriers take an untyped attachment list, and an attachment is never delivered over one.";

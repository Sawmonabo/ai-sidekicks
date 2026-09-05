// What the artifact pane says once, politely, when a read or an act settles.
//
// A MODULE OF ITS OWN ON `frame/banner-announcements.ts`'s PRECEDENT: an announcement
// is a sentence a person hears rather than anything the pane draws, and the rule that
// each is said once and never on a re-render is the announcer's. Kept in the component
// the sentences sat between a hook and a render body, which is where prose goes to
// drift out of step with the surface it describes.
//
// A REFUSAL IS NOT HERE, and that is the rule rather than an omission: a refused act
// speaks in the refusal's own words, which rule 9 forbids this console to paraphrase.

import { type ArtifactDeleteReceipt } from "../artifacts/artifact-model.js";
import { artifactDeleteReceiptSentence } from "../artifacts/artifact-copy.js";
import type { ArtifactPayloadReading } from "./artifact-payload.js";

export /** What a settled act says, once, when it settles. A refusal speaks in its own words. */
const MANIFEST_RE_READ_ANNOUNCEMENT = "Manifest re-read. The row shows what the read answered.";

/**
 * What a settled delete says: the daemon's own two facts, in the daemon's own words.
 *
 * The sentence is composed by `repos/artifacts/artifact-copy.ts` and is the SAME one the panel
 * draws in its receipt strip, so the announcement and the screen cannot disagree about
 * what became of the bytes. Both used to say the reply reported nothing, which was
 * true of a `void` reply and is not true of a receipt.
 */
export function artifactDeletedAnnouncement(receipt: ArtifactDeleteReceipt): string {
  return `Artifact deleted and the list read again. ${artifactDeleteReceiptSentence(receipt)}`;
}

/** What each settled payload fetch says. Total over the arms a served fetch can reach. */
export const PAYLOAD_ANNOUNCEMENT_BY_STATUS: Readonly<
  Record<ArtifactPayloadReading["status"], string | undefined>
> = {
  // Neither is reachable from a settled fetch: `not-checked` is where the pane starts
  // and `refused` speaks in the refusal's own words through the pane's announcer.
  "not-checked": undefined,
  fetching: undefined,
  refused: undefined,
  deferred:
    "The read answered with a payload handle rather than the bytes. No registered operation fetches by one.",
  text: "Payload fetched. The preview shows the beginning of it.",
  opaque: "Payload fetched. Its bytes are not text, so there is nothing to preview.",
};

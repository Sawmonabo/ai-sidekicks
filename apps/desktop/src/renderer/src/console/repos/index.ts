// The sheet the repos root cards and the inspector's artifact rows share, and the
// attachment names the composer reads from here.

import "@renderer/features/repos/repos.css";

// The attachment carrier, published as the binding that owns it rather than as the client.
//
// THE CARRIER AND NOT THE CLIENT, deliberately. `AttachmentIngestClient` is a stream
// with a lifecycle — constructed, subscribed, disposed — and the composer handed the
// raw class would own three of those and get one of them wrong. `useAttachmentCarrier`
// is that seam done once: it constructs the client, publishes the entries with the
// instant they were published at, and gives the daemon back every open spool on
// unmount.
//
// Consumed by the composer's attachment affordance.
export {
  useAttachmentCarrier,
  type AttachmentCarrierBinding,
} from "./attachments/attachment-carrier.js";

// WHAT THE COMPOSER'S AFFORDANCE TAKES BESIDE THE BINDING, and why each of these and
// nothing more. The composer renders attachment CHIPS — one line each, at the density
// the send bar has room for — where this family renders cards, so the COMPONENT is not
// shared and every one of these is a READING or a SENTENCE the two surfaces must not
// answer differently: which name an entry goes by and whose it is, which media-type
// readings it has, what cancelling actually does, what each refusal disposition
// recommends, where a carrier stands against the count bound, whether one file is past
// the byte bound, and whether an upload has gone quiet.
export {
  attachmentCarrierFill,
  exceedsAttachmentByteAllowance,
} from "@renderer/features/composer/attachments/attachment-bounds.js";
export {
  INGEST_ABANDON_COPY,
  INGEST_DISPOSITION_COPY,
} from "@renderer/features/composer/attachments/attachment-policy.js";
export { isIngestStalled } from "@renderer/features/composer/attachments/attachment-presentation.js";
export {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  attachmentMediaTypeReadings,
  attachmentNameReading,
} from "@renderer/features/composer/attachments/attachment-provenance.js";
export type { AttachmentIngestEntry } from "@renderer/features/composer/attachments/attachment-shapes.js";

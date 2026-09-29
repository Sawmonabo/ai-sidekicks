// The shipped attachment bounds, and where a staged list and one file stand against them.
//
// This module renders nothing, calls nothing, and holds no copy about a refusal. The byte
// bound is `core/constants/attachment-caps.ts`'s `ATTACHMENT_BYTE_CAP_DEFAULT`. No read of
// the deployment's own bound is made anywhere, so every surface reads the shipped default.

import { ATTACHMENTS_PER_MESSAGE_CAP_DEFAULT } from "./attachment-caps.js";

/**
 * How full a staged list is against the count bound, as a figure and never as a gate.
 *
 * THE COUNT IS RENDERED AND THE DAEMON DECIDES. `attachment-ingest-machine.ts` states
 * the same rule from the other side: the daemon refuses the whole staged list at acceptance
 * with `artifact.too_many_attachments`, so a console that stopped the eleventh attach
 * would be deriving eligibility the daemon owns and would be wrong the moment an
 * operator raises the bound. Nothing here answers "may I", and no surface reading this
 * withdraws the picker.
 */
export interface StagedAttachmentsFill {
  readonly attached: number;
  /** The shipped default count bound. Operator-tunable, so it is labelled as a default. */
  readonly allowance: number;
}

/** Where this staged list stands against the count bound. Total over any count. */
export function stagedAttachmentsFill(attachedCount: number): StagedAttachmentsFill {
  return { attached: attachedCount, allowance: ATTACHMENTS_PER_MESSAGE_CAP_DEFAULT };
}

/**
 * Whether one attachment's own length is past the per-attachment bound.
 *
 * The answer is a warning ahead of `artifact.too_large` rather than a verdict standing in
 * for it: the upload is still attempted, because the enforcement points are the daemon's
 * and the console does not add another.
 */
export function exceedsAttachmentByteAllowance(
  byteLength: number,
  maximumByteLength: number,
): boolean {
  return byteLength > maximumByteLength;
}

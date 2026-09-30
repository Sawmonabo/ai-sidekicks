// The shipped attachment bounds, and where a staged list and one file stand against them. The
// byte bound is the contract's default; no read of the deployment's own bound is made, so every
// view shows the shipped default.

import { SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT } from "@ai-sidekicks/contracts";

/**
 * How full a staged list is against the count bound, as a figure and never a gate. The daemon
 * refuses an over-long list at acceptance with `artifact.too_many_attachments`, and an operator
 * can raise the bound, so no view withdraws the picker.
 */
export interface StagedAttachmentsFill {
  readonly attached: number;
  /** The shipped default count bound; operator-tunable, so it is labeled as a default. */
  readonly allowance: number;
}

/** Where this staged list stands against the count bound. Total over any count. */
export function stagedAttachmentsFill(attachedCount: number): StagedAttachmentsFill {
  return { attached: attachedCount, allowance: SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT };
}

/**
 * Whether one attachment's length is past the per-attachment bound. A warning ahead of
 * `artifact.too_large`, not a verdict: the upload is still attempted.
 */
export function exceedsAttachmentByteAllowance(
  byteLength: number,
  maximumByteLength: number,
): boolean {
  return byteLength > maximumByteLength;
}

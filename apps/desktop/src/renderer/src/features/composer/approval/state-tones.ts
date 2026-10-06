import type { ApprovalState } from "@ai-sidekicks/contracts/approval";

import type { ChipTone } from "#renderer/components/Chip/Chip.js";

/**
 * The chip tone each state wears. `pending` is the only amber, because amber means a person is
 * needed; `rejected` is not red, since a rejection is the console working and red is kept for
 * failures.
 */
export const APPROVAL_STATE_TONES: Readonly<Record<ApprovalState, ChipTone>> = {
  pending: "attention",
  approved: "accent",
  rejected: "neutral",
  canceled: "neutral",
};

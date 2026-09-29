import type { ChipTone } from "@renderer/components/Chip/Chip.js";
import type { ApprovalState } from "@renderer/lib/approval-vocabulary.js";

/**
 * The chip tone a state wears.
 *
 * `pending` is the only amber one, because amber means a person is needed and
 * nothing else earns it (rule 3). `rejected` is not red: a rejection is the
 * console working correctly, and spending red on it would leave nothing louder for
 * the case where something actually failed.
 */
export const APPROVAL_STATE_TONES: Readonly<Record<ApprovalState, ChipTone>> = {
  pending: "attention",
  approved: "accent",
  rejected: "neutral",
  expired: "neutral",
  canceled: "neutral",
};

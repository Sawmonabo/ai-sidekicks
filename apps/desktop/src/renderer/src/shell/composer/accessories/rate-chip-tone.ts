// The rate group's banding rule: which quota readings earn a chip, and in what tone.
//
// ITS OWN MODULE BECAUSE BOTH SIDES OF THE GROUP NEED IT. `RateChips` reads it to
// decide what to render at all and in what order; `RateChip` carries the answer on
// its props and is typed by it. Leaving it in either would make the other import
// from a module that imports it back — the cycle the layering gate refuses, and the
// reason its own message says to hoist the shared symbol rather than reach past a
// door for it.
//
// ONE FUNCTION FOR VISIBILITY AND TONE, because they are one rule read at two
// thresholds: a reading that earns no tone is exactly a reading that is not shown.
// Two functions would let the thresholds drift into a band that is visible and
// colourless.

import { remainingPercentOf, type ProviderQuotaReading } from "../../../console/bridge/index.js";
import {
  RATE_CHIP_URGENT_BELOW_REMAINING_PERCENT,
  RATE_CHIP_VISIBLE_BELOW_REMAINING_PERCENT,
} from "./accessory-bounds.js";

/**
 * The two tones that render. Closed, and derived into a union below, so a third
 * cannot be introduced in one place while the band function still answers two.
 */
export const RATE_CHIP_TONES: readonly ["caution", "urgent"] = ["caution", "urgent"] as const;

/** One rendered rate-chip tone. */
export type RateChipTone = (typeof RATE_CHIP_TONES)[number];

/** The tone a reading earns, or `undefined` when it earns no chip at all. */
export function rateChipToneFor(reading: ProviderQuotaReading): RateChipTone | undefined {
  const remaining = remainingPercentOf(reading);
  if (remaining >= RATE_CHIP_VISIBLE_BELOW_REMAINING_PERCENT) {
    return undefined;
  }
  return remaining < RATE_CHIP_URGENT_BELOW_REMAINING_PERCENT ? "urgent" : "caution";
}

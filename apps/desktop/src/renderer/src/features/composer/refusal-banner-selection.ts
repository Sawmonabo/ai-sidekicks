// Picks the one banner-class refusal a caller hands to the frame. A banner-class refusal
// (see `lib/refusal-remedies.ts`) changes what the whole session screen can do; the pick is
// handed over through `hooks/useRefusalBannerEscalation.ts`.

import { refusalRemedyFor } from "@renderer/lib/refusal-remedies.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * The first banner-class refusal among the candidates, or nothing. Callers whose refusals
 * arrive as a collection pass them in preference order and hand over exactly one: the frame
 * keys a banner on origin and code, so one vanished session noticed by several reads under
 * different origins would otherwise raise several banners. Order means preference, never
 * recency; no refusal carries a time.
 */
export function preferredBannerClassRefusalAmong(
  candidates: Iterable<Refusal | undefined>,
): Refusal | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && isBannerClass(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** True where the refusal changes what the whole session can do, so it spans the frame. */
export function isBannerClass(refusal: Refusal): boolean {
  return refusalRemedyFor(refusal.code)?.rendering === "banner";
}

// Whether a refusal is banner-class (see `lib/refusal/remedies.ts`): one that changes what the
// whole session screen can do, handed to the frame through `hooks/useRefusalBannerEscalation.ts`.

import { refusalRemedyFor } from "@renderer/lib/refusal/remedies.js";
import { type Refusal } from "@renderer/lib/refusal/refusal.js";

/** True where the refusal changes what the whole session can do, so it spans the frame. */
export function isBannerClass(refusal: Refusal): boolean {
  return refusalRemedyFor(refusal.code)?.rendering === "banner";
}

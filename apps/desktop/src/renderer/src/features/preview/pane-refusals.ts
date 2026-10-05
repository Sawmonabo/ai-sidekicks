// The refusal codes this pane authors, as a closed set. Each names something the renderer
// decided; a refusal off the wire keeps the code the other side sent, so a new code cannot be
// minted at a call site unnoticed. `geometry/page-host.ts` has its own set and origin, because
// the origin tells a person which subsystem wrote the sentence.

import type { RejectionFallback } from "#renderer/lib/wire/rejection.js";

/** Every refusal code the Preview pane authors or renders as its own. */
export const PREVIEW_PANE_REFUSAL_CODES = [
  "no-selected-page",
  "no-current-page",
  "file-address",
  "open-external-failed",
] as const;

/** One code this pane may refuse with. Derived, so the set has exactly one home. */
export type PreviewPaneRefusalCode = (typeof PREVIEW_PANE_REFUSAL_CODES)[number];

/**
 * A rejection fallback whose code is one of this pane's own, so an unlisted code is a compile
 * error where the fallback is declared.
 */
export type PreviewPaneRejectionFallback = RejectionFallback & {
  readonly code: PreviewPaneRefusalCode;
};

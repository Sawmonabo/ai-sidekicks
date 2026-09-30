// The page host a pane's rectangle is published to.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { PaneGeometrySample } from "./pane-geometry.js";

/** The subsystem name every refusal a page host raises carries. */
export const PAGE_HOST_REFUSAL_ORIGIN = "page-host";

/**
 * What a page host says back. A rejection ends the subscription; it never retries. The
 * `pane-gone` code is the page host saying the pane it was addressing has been destroyed.
 */
export type PaneRectOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly refusal: Refusal };

/** What carries a pane's native view and places it at the published rectangle. */
export interface PageHost {
  /** How the page host is reached, for diagnostics. */
  readonly transport: string;
  setRect(sample: PaneGeometrySample): PaneRectOutcome;
}

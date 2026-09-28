// The host a pane's rectangle is published to.
//
// The publisher consumes this file's host type; this file consumes the sample type from
// `pane-geometry.ts`.

import type { ConsoleRefusal } from "../../core/index.js";
import type { PaneGeometrySample } from "./pane-geometry.js";

/** The subsystem name every refusal a view host raises carries. */
export const PANE_VIEW_HOST_REFUSAL_ORIGIN = "browser-view-host";

/**
 * What a host says back. A rejection ends the subscription; it never retries. The
 * `pane-gone` code is the host saying the pane it was addressing has been destroyed.
 */
export type PaneRectOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly refusal: ConsoleRefusal };

/** A host that carries a view. */
export interface AttachedPaneViewHost {
  /** How the host is reached, for diagnostics. */
  readonly transport: string;
  setRect(sample: PaneGeometrySample): PaneRectOutcome;
}

// Types the preview pane's modules share.

import type { PreviewPage } from "@ai-sidekicks/contracts/preview/preview";

import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { ReadingState } from "#renderer/lib/partial-read.js";

/**
 * What the pane knows about the page right now. `ended` is a fact, not an absence: a pane
 * holding the last state would present a stale address, title and history depths as current.
 */
export type NavigationReading =
  /** No answer has come back yet, which is not the same as "no page". */
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly state: PreviewPage;
    })
  /** The producer finished. The pane was being told, and is not being told now. */
  | { readonly kind: "ended" };

/**
 * The pair a pane-scoped resource belongs to. Every pane-keyed call is made on one bridge with
 * one `paneId`, so a publisher made for another pair is not this one's.
 */
export interface PaneSubject {
  readonly bridge: PlatformBridge;
  readonly paneId: string;
}

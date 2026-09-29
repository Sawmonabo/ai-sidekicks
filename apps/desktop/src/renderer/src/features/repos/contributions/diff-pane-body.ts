// The diff pane's body, as the pane layout's registry loads it.
//
// A LOADER-BACKED BODY, so the diff viewer is not on the initial import graph. This
// pane reaches `diff` (jsdiff), the shared virtualized diff-row renderer, and the
// worker-side highlighting seam, and none of it is painted before a person opens a
// changed file — which is exactly the condition `apps/desktop/AGENTS.md` states the rule
// on: a pane body not on the flagship first paint registers through a loader.
//
// ONLY THE `import()` IN `panes.ts` NAMES THIS MODULE. A static import from any of the
// feature's contributions would put the viewer back on the entry graph, which is the
// edge the loader exists to remove.
//
// THE INLINE DIFF CARD IS DELIBERATELY NOT BEHIND THIS BOUNDARY. It is a transcript row's
// card rather than a pane, it renders inside the timeline a session opens on, and it
// keeps its static registration in `inline-cards.ts` — the two share the feature's
// vocabulary and not their loading terms.

import { createElement } from "react";

import { DiffPane } from "../diff/components/DiffPane.js";
import { paneBodyForKind, type PaneContext } from "@renderer/console/seats/index.js";

/**
 * The diff pane, at an address the pane layout resolved to this kind.
 *
 * Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader
 * module publishes. The narrowing and the mismatch refusal are `paneBodyForKind`'s:
 * every pane body writing that comparison itself would be one answer per pane to one
 * question, and a mismatch is a rendered refusal rather than a throw because one bad
 * layout row must lose that row and not the pane layout.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind("diff", (context) =>
  createElement(DiffPane, { context }),
);

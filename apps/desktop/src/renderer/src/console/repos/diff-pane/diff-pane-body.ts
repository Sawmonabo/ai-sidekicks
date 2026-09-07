// The diff pane's body, as the deck's registry loads it.
//
// A LOADER-BACKED BODY, so the diff viewer is not on the initial import graph. This
// pane reaches `diff` (jsdiff), the shared virtualized diff-row renderer, and the
// worker-side highlighting seam, and none of it is painted before a person opens a
// changed file — which is exactly the condition `apps/desktop/AGENTS.md` states the rule
// on: a pane body not on the flagship first paint registers through a loader.
//
// IT SITS BESIDE THE COMPONENT AND NOT IN `family-bodies.ts`. That module is the
// family's composition — it reads the doors and registers the sidebar sections and the
// inline cards — and a body composed there would be reached by a static import from the
// family door, which is the edge this whole change exists to remove. Here, the only
// thing that names this module is the `import()` in `repos/index.ts`.
//
// THE INLINE DIFF CARD IS DELIBERATELY NOT BEHIND THIS BOUNDARY. It is a ledger row's
// card rather than a pane, it renders inside the timeline a session opens on, and it
// keeps its static registration in `family-bodies.ts` — the two share the family's
// vocabulary and not their loading terms.

import { createElement } from "react";

import { DiffPane } from "./DiffPane.js";
import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/**
 * The diff pane, at an address the deck resolved to this kind.
 *
 * Named `Body` because `seats/lazy-body.ts` fixes the export name a loader
 * module publishes. The narrowing and the mismatch refusal are `paneBodyForKind`'s, for
 * the reason `family-bodies.ts` states about them: six families writing that comparison
 * themselves is six answers to one question, and a mismatch is a rendered refusal rather
 * than a throw because one bad layout row must lose that row and not the deck.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "diff",
  (context) => createElement(DiffPane, { context }),
);

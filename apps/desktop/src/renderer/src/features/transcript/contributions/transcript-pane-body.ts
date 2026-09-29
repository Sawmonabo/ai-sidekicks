// The transcript pane's body, as the deck's registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, because nothing in it is painted before a person acts: the window
// opens on the `sessions` destination (`routing/routes.ts`' `DEFAULT_ROUTE`), so every pane
// in the deck — this one included — is reached by opening a session. The pane, its feed,
// its window and structure derivations, the rows and the markdown and ANSI renderers
// behind them are the largest single block of the renderer, and a chunk keeps them off the
// initial import graph.
//
// THE ROW SEAT IS FILLED HERE BECAUSE THIS CHUNK IS WHAT READS IT. `TranscriptPane.tsx` is
// the only module that calls `timelineRowRenderer()`, so the seat's reader and the seat's
// filler arrive together; filling it from the eager registration would put the whole row
// subtree, and every markdown dependency behind it, back on the initial graph. The call
// runs at module scope, once per realm, which is the right number for a process-wide single
// slot, and a suite that wants the rows without the pane around them calls
// `registerFixtureShellRows` itself (`tests/accessibility/transcript-pane.test.tsx` does).
//
// THE SHEETS BELOW STYLE SEVERAL COMPONENTS EACH, across the feature's folders, so the
// chunk root imports them rather than any one component.
//
// Named `Body` because the pane registry's lazy loader fixes the export name it resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "@renderer/console/seats/index.js";
import { registerFixtureShellRows } from "./timeline-rows.js";
import { TimelinePane } from "../TranscriptPane.js";

import "../rows/rows.css";
import "../rows/bodies/bodies.css";
import "../rows/markdown/markdown.css";
import "../viewport/components/transcript-viewport.css";
import "../window/components/transcript-window.css";
import "../run-groups/components/run-groups.css";

registerFixtureShellRows();

/**
 * The ledger, at an address the deck resolved to this kind.
 *
 * The narrowing and the mismatch refusal are `paneBodyForKind`'s, for the reason every
 * other pane body gives about them: six families writing that comparison themselves is
 * six answers to one question, and a mismatched arm is a rendered refusal rather than a
 * throw because one bad layout row must lose that row and not the deck. `createElement`
 * rather than JSX: this is a `.ts` module, and the naming rule reserves `.tsx` for a
 * single PascalCase component per file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "timeline",
  (context) => createElement(TimelinePane, { context }),
);

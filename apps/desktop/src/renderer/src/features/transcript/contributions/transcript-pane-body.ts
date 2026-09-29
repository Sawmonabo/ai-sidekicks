// The transcript pane's body, as the pane layout's registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, because nothing in it is painted before a person acts: the window
// opens on the `sessions` destination (`routing/routes.ts`' `DEFAULT_ROUTE`), so every pane
// in the pane layout — this one included — is reached by opening a session. The pane, its feed,
// its window and structure derivations, the rows and the markdown and ANSI renderers
// behind them are the largest single block of the renderer, and a chunk keeps them off the
// initial import graph.
//
// THE ROW SEAT IS FILLED HERE BECAUSE THIS CHUNK IS WHAT READS IT. `TranscriptPane.tsx` is
// the only module that calls `findTranscriptRowRenderer()`, so the seat's reader and the seat's
// filler arrive together; filling it from the eager registration would put the whole row
// subtree, and every markdown dependency behind it, back on the initial graph. The call
// runs at module scope, once per realm, which is the right number for a process-wide single
// slot, and a suite that wants the rows without the pane around them calls
// `registerTranscriptRows` itself (`tests/accessibility/transcript-pane.test.tsx` does).
//
// THE SHEETS BELOW STYLE SEVERAL COMPONENTS EACH, across the feature's folders, so the
// chunk root imports them rather than any one component.
//
// Named `Body` because the pane registry's lazy loader fixes the export name it resolves.

import { createElement } from "react";

import { paneBodyForKind, type PaneContext } from "@renderer/console/seats/index.js";
import { registerTranscriptRows } from "./timeline-rows.js";
import { TranscriptPane } from "../TranscriptPane.js";

import "../rows/rows.css";
import "../rows/bodies/bodies.css";
import "../rows/markdown/markdown.css";
import "../viewport/components/transcript-viewport.css";
import "../window/components/transcript-window.css";
import "../run-groups/components/run-groups.css";

registerTranscriptRows();

/**
 * The transcript, at an address the pane layout resolved to this kind.
 *
 * The narrowing and the mismatch refusal are `paneBodyForKind`'s, for the reason every
 * other pane body gives about them: six families writing that comparison themselves is
 * six answers to one question, and a mismatched arm is a rendered refusal rather than a
 * throw because one bad layout row must lose that row and not the pane layout. `createElement`
 * rather than JSX: this is a `.ts` module, and the naming rule reserves `.tsx` for a
 * single PascalCase component per file.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "transcript",
  (context) => createElement(TranscriptPane, { context }),
);

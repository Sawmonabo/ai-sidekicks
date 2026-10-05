// The transcript pane's body as the pane registry loads it, and the root of its chunk, which
// keeps the feed, rows and markdown and ANSI renderers off the initial import graph. The row
// renderer registers here because `TranscriptPane.tsx` is its only reader; a suite wanting rows
// without the pane calls `registerTranscriptRows` itself. Named `Body` for the lazy loader.

import { createElement } from "react";

import { paneBodyForKind } from "@renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { registerTranscriptRows } from "./transcript-rows.js";
import { TranscriptPane } from "../TranscriptPane.js";

// Each sheet styles several components across the feature's folders, so the chunk root loads them.
import "../rows/rows.css";
import "../rows/bodies/bodies.css";
import "../viewport/components/transcript-viewport.css";
import "../window/components/transcript-window.css";
import "../run-groups/components/run-groups.css";

registerTranscriptRows();

/**
 * The transcript at an address the pane layout resolved to this kind. `paneBodyForKind` does the
 * narrowing and throws on a context of another kind, which only a body registered under the wrong
 * kind receives. `createElement` because this is a `.ts` module and `.tsx` is for components.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "transcript",
  (context) => createElement(TranscriptPane, { context }),
);

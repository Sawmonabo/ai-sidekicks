// The transcript pane's body as the pane registry loads it, and the root of its chunk, which
// keeps the feed, rows and markdown and ANSI renderers off the initial import graph. The row
// renderer registers here because `TranscriptPane.tsx` is its only reader; a suite wanting rows
// without the pane calls `registerTranscriptRows` itself. Named `Body` for the lazy loader.

import { createElement } from "react";

import { paneBodyForKind } from "#renderer/registries/panes/body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { registerTranscriptRows } from "./rows.js";
import { TranscriptPane } from "../TranscriptPane.js";

// The viewport's sheet styles components in `viewport/` and the head control in `history/`, so
// the chunk root loads it.
import "../viewport/components/transcript-viewport.css";

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

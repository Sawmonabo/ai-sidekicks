// The inspector pane's body, as the registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, on the runs pane's reasoning: the inspector opens from a
// control and from an address, so its readers, its sections, and its stylesheet ride
// behind the boundary rather than on the initial import graph.
//
// THE SHEET ENTERS HERE RATHER THAN AT THE DOOR, for the reason
// `apps/desktop/AGENTS.md` gives: the directory carrying the chunk owns it, and a sheet
// on the family door is the pane's rules on every session's first document.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { InspectorPane } from "./InspectorPane.js";

import "./inspector.css";

/**
 * The inspector, at an address the deck resolved.
 *
 * Narrowed to this kind's own address arm before the body sees it, so the body reads
 * the entity its kind admits and nothing else. `createElement` rather than JSX: this is
 * a `.ts` module, and the naming rule reserves `.tsx` for a single PascalCase component
 * per file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "inspector",
  (context) => createElement(InspectorPane, context),
);

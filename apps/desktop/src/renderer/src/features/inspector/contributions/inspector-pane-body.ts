// The inspector pane's body, as the registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, on the runs pane's reasoning: the inspector opens from a
// control and from an address, so its readers, its sections, and its stylesheet ride
// behind the boundary rather than on the initial import graph.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "@renderer/console/seats/index.js";
import { InspectorPane } from "../InspectorPane.js";

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

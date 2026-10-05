// The inspector pane's body as the registry loads it, and the root of its chunk (readers,
// sections and stylesheet ride behind the boundary, off the first paint). Named `Body` because
// that is the export the lazy body loader resolves.

import { createElement } from "react";

import { paneBodyForKind } from "#renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/pane-context.js";
import { InspectorPane } from "../InspectorPane.js";

/**
 * The inspector, at an address the pane layout resolved.
 *
 * Narrowed to this kind's address arm first. `createElement` rather than JSX because this is
 * a `.ts` module.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "inspector",
  (context) => createElement(InspectorPane, context),
);
